import { LibraryInfo, type Version } from '@xmcl/core';
import { spawn } from 'node:child_process';
import { lstat, open } from 'node:fs/promises';
import { delimiter } from 'node:path';
import { prepareFileDirectory, readZipFiles, safeRelativePath } from './install-files.js';
import { NEOFORGE_PROFILE, NEOFORGE_VERSION } from './neoforge.js';
import { artifactDownload, libraryDownloads, type MinecraftMetadata } from './prepare-minecraft.js';
import { PreparationFiles } from './preparation-files.js';
import { stageProgress, type ReportProgress } from './preparation-progress.js';
import { VANILLA_VERSION } from './vanilla.js';

export const NEOFORGE_RUNTIME_FILES = [
  'libraries/net/minecraft/client/1.21.1-20240808.144430/client-1.21.1-20240808.144430-srg.jar',
  'libraries/net/minecraft/client/1.21.1-20240808.144430/client-1.21.1-20240808.144430-extra.jar',
  `libraries/net/neoforged/neoforge/${NEOFORGE_VERSION}/${NEOFORGE_PROFILE}-client.jar`,
  `libraries/net/neoforged/neoforge/${NEOFORGE_VERSION}/${NEOFORGE_PROFILE}-universal.jar`
];

type Processor = { sides?: string[]; jar: string; classpath: string[]; args: string[] };
type InstallProfile = { version: string; minecraft: string; data: Record<string, { client: string }>; processors: Processor[]; libraries: Version['libraries'] };
export type LocalProcessor = { label: string; jar: string; classpath: string[]; args: string[]; outputs: string[] };

export function mavenPath(coordinate: string): string {
  if (typeof coordinate !== 'string' || !/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.+-]+(?::[A-Za-z0-9_.-]+)?(?:@[A-Za-z0-9]+)?$/.test(coordinate)) throw new Error('Неверные Maven-координаты.');
  return 'libraries/' + safeRelativePath(LibraryInfo.resolve(coordinate).path);
}

export function clientProcessorPlan(profile: InstallProfile, files: PreparationFiles): LocalProcessor[] {
  if (profile.version !== NEOFORGE_PROFILE || profile.minecraft !== VANILLA_VERSION || !Array.isArray(profile.processors)) throw new Error('Неподдерживаемый профиль установщика NeoForge.');
  const values: Record<string, string> = { SIDE: 'client', ROOT: files.root,
    MINECRAFT_JAR: files.path(`versions/${VANILLA_VERSION}/${VANILLA_VERSION}.jar`), MINECRAFT_VERSION: VANILLA_VERSION,
    INSTALLER: files.path('.preparation/neoforge-installer.jar'), LIBRARY_DIR: files.path('libraries') };
  for (const [key, entry] of Object.entries(profile.data)) {
    const value = entry.client;
    if (/^\[.+\]$/.test(value)) values[key] = files.path(mavenPath(value.slice(1, -1)));
    else if (/^'[^']*'$/.test(value)) values[key] = value.slice(1, -1);
    else if (value === '/data/client.lzma') values[key] = files.path('.preparation/client.lzma');
    else throw new Error('Неизвестное значение данных NeoForge: ' + key);
  }
  const expand = (value: string) => {
    if (/^\[.+\]$/.test(value)) return files.path(mavenPath(value.slice(1, -1)));
    return value.replace(/\{([^}]+)\}/g, (_match, key: string) => {
      if (!(key in values)) throw new Error('Неизвестная переменная процессора NeoForge: ' + key);
      return values[key];
    });
  };
  const selected = profile.processors.filter(processor => !processor.sides || processor.sides.includes('client'));
  const labels = ['MCP_DATA', 'DOWNLOAD_MOJMAPS', 'MERGE_MAPPING', 'jarsplitter', 'AutoRenamingTool', 'binarypatcher'];
  if (selected.length !== labels.length) throw new Error('Неожиданный набор клиентских процессоров.');
  return selected.flatMap((processor, index) => {
    const label = labels[index];
    const task = processor.args[processor.args.indexOf('--task') + 1];
    if (index < 3 ? task !== label : !processor.jar.includes(':' + label + ':')) throw new Error('Неожиданный процессор NeoForge: ' + processor.jar);
    if (label === 'DOWNLOAD_MOJMAPS') return [];
    const outputFlags = label === 'jarsplitter' ? ['--slim', '--extra'] : ['--output'];
    const outputs = outputFlags.map(flag => {
      const offset = processor.args.indexOf(flag);
      if (offset < 0) throw new Error('Не указан результат процессора.');
      const variable = processor.args[offset + 1];
      const key = /^\{([A-Z_]+)\}$/.exec(variable)?.[1];
      const coordinate = key && profile.data[key]?.client;
      if (!coordinate || !/^\[.+\]$/.test(coordinate)) throw new Error('Небезопасный результат процессора.');
      return mavenPath(coordinate.slice(1, -1));
    });
    return [{ label, jar: mavenPath(processor.jar), classpath: [...new Set([processor.jar, ...processor.classpath])].map(mavenPath), args: processor.args.map(expand), outputs }];
  });
}

async function runLocalProcessor(java: string, processor: LocalProcessor, files: PreparationFiles, index: number): Promise<void> {
  for (const output of processor.outputs) {
    await prepareFileDirectory(files.root, output);
    try { await lstat(files.path(output)); throw new Error('Результат процессора уже существует: ' + output); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const manifest = (await readZipFiles(files.path(processor.jar), name => name === 'META-INF/MANIFEST.MF', 1_000_000)).get('META-INF/MANIFEST.MF')?.toString('utf8').replace(/\r?\n /g, '');
  const mainClass = /^Main-Class: ([A-Za-z0-9_.$]+)\r?$/m.exec(manifest ?? '')?.[1];
  if (!mainClass) throw new Error('У процессора NeoForge нет главного класса.');
  const log = await open(files.path(`.preparation/processor-${index}.log`), 'wx', 0o600);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH'].includes(key.toUpperCase())) delete env[key];
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(java, ['-cp', processor.classpath.map(path => files.path(path)).join(delimiter), mainClass, ...processor.args], {
        cwd: files.root, env, windowsHide: true, stdio: ['ignore', log.fd, log.fd], shell: false
      });
      let failure: Error | undefined;
      const timer = setTimeout(() => { failure = new Error('Превышено время подготовки NeoForge; журнал сохранён.'); child.kill(); }, 600_000);
      child.once('error', error => { failure = error; });
      child.once('close', code => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`Процессор ${processor.label} завершился с кодом ${code}; журнал сохранён.`));
        else resolve();
      });
    });
  } finally { await log.close(); }
  for (const output of processor.outputs) {
    if ((await lstat(files.path(output))).size === 0) throw new Error('Пустой результат процессора: ' + output);
    await files.record(output);
  }
}

export async function prepareNeoForge(files: PreparationFiles, java: string, minecraft: MinecraftMetadata, report: ReportProgress): Promise<void> {
  await files.downloads([{
    path: '.preparation/neoforge-installer.jar',
    url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${NEOFORGE_VERSION}/${NEOFORGE_PROFILE}-installer.jar`,
    size: 6972019, hash: 'd0345e2a104ce4633065f572310ba6e0dd428bb6a73364cf0c2443ed9f8950ad', algorithm: 'sha256'
  }], 'neoforge', report);
  stageProgress(report, 'neoforge', 'Чтение закреплённого профиля NeoForge');
  const entries = await readZipFiles(files.path('.preparation/neoforge-installer.jar'), name => ['install_profile.json', 'version.json', 'data/client.lzma'].includes(name), 20_000_000);
  if (!entries.has('install_profile.json') || !entries.has('version.json') || !entries.has('data/client.lzma')) throw new Error('Неполный установщик NeoForge.');
  const profile = JSON.parse(entries.get('install_profile.json')!.toString('utf8')) as InstallProfile;
  const version = JSON.parse(entries.get('version.json')!.toString('utf8')) as Version;
  if (version.id !== NEOFORGE_PROFILE || version.inheritsFrom !== VANILLA_VERSION) throw new Error('Неожиданный профиль запуска NeoForge.');
  const processors = clientProcessorPlan(profile, files);
  await files.write('.preparation/client.lzma', entries.get('data/client.lzma')!);
  const mappings = profile.data.MOJMAPS.client;
  if (!/^\[.+\]$/.test(mappings)) throw new Error('Неверный путь mappings NeoForge.');
  await files.downloads([...libraryDownloads(profile.libraries), ...libraryDownloads(version.libraries),
    artifactDownload(mavenPath(mappings.slice(1, -1)), minecraft.downloads.client_mappings)], 'neoforge', report);
  for (let index = 0; index < processors.length; index++) {
    stageProgress(report, 'neoforge', `${index + 1}/${processors.length}: ${processors[index].label}`);
    await runLocalProcessor(java, processors[index], files, index);
  }
  await files.write(`versions/${NEOFORGE_PROFILE}/${NEOFORGE_PROFILE}.json`, entries.get('version.json')!);
  await files.write('.kayvel-neoforge-ready', NEOFORGE_VERSION);
}

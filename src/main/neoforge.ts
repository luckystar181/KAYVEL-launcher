import { launch } from '@xmcl/core';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { installVanilla, offlineUUID, validateNickname, VANILLA_VERSION } from './vanilla.js';
import { assertGamePreparationAllowed } from './game-preparation.js';

export const NEOFORGE_VERSION = '21.1.252';
export const NEOFORGE_PROFILE = `neoforge-${NEOFORGE_VERSION}`;
const INSTALLER_URL = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${NEOFORGE_VERSION}/${NEOFORGE_PROFILE}-installer.jar`;
const INSTALLER_SHA256 = 'd0345e2a104ce4633065f572310ba6e0dd428bb6a73364cf0c2443ed9f8950ad';

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function installerReady(path: string): Promise<boolean> {
  try { return (await stat(path)).size > 0 && await sha256File(path) === INSTALLER_SHA256; }
  catch { return false; }
}

async function downloadInstaller(path: string): Promise<void> {
  if (await installerReady(path)) return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const response = await fetch(INSTALLER_URL, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`NeoForge: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== INSTALLER_SHA256) throw new Error('Контрольная сумма установщика NeoForge не совпадает.');
    await writeFile(temporary, bytes);
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

function runInstaller(java: string, installer: string, directory: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(java, ['-jar', installer, '--install-client', directory], { cwd: directory, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Установщик NeoForge завершился с кодом ${code ?? 'неизвестно'}.`)));
  });
}

export function neoForgeReady(directory: string): boolean {
  return existsSync(join(directory, 'versions', NEOFORGE_PROFILE, `${NEOFORGE_PROFILE}.json`))
    && existsSync(join(directory, 'versions', VANILLA_VERSION, `${VANILLA_VERSION}.jar`))
    && existsSync(join(directory, 'libraries', 'net', 'neoforged', 'neoforge', NEOFORGE_VERSION, `${NEOFORGE_PROFILE}-client.jar`))
    && existsSync(join(directory, '.kayvel-neoforge-ready'));
}

export async function installNeoForge(directory: string, installerCache: string, java: string): Promise<void> {
  assertGamePreparationAllowed();
  await installVanilla(directory);
  await downloadInstaller(installerCache);
  if (!neoForgeReady(directory)) {
    await rm(join(directory, '.kayvel-neoforge-ready'), { force: true });
    const profiles = join(directory, 'launcher_profiles.json');
    if (!existsSync(profiles)) await writeFile(profiles, '{"profiles":{},"settings":{},"version":3}');
    await runInstaller(java, installerCache, directory);
    const profile = join(directory, 'versions', NEOFORGE_PROFILE, `${NEOFORGE_PROFILE}.json`);
    if (!existsSync(profile)) throw new Error('Установщик завершился без профиля NeoForge.');
    const installed: unknown = JSON.parse(await readFile(profile, 'utf8'));
    if (!installed || typeof installed !== 'object' || !('id' in installed) || installed.id !== NEOFORGE_PROFILE || !('inheritsFrom' in installed) || installed.inheritsFrom !== VANILLA_VERSION) throw new Error('Некорректный профиль NeoForge.');
    const patchedClient = join(directory, 'libraries', 'net', 'neoforged', 'neoforge', NEOFORGE_VERSION, `${NEOFORGE_PROFILE}-client.jar`);
    if (!existsSync(patchedClient)) throw new Error('Установщик не создал клиентский JAR NeoForge.');
    await writeFile(join(directory, '.kayvel-neoforge-ready'), NEOFORGE_VERSION);
  }
}

export async function launchNeoForge(
  directory: string,
  name: string,
  javaPath: string,
  onSpawn?: (child: ChildProcess) => void
) {
  return launch({
    gamePath: directory,
    resourcePath: directory,
    version: NEOFORGE_PROFILE,
    javaPath,
    gameProfile: { name: validateNickname(name), id: offlineUUID(name) },
    accessToken: '0',
    userType: 'legacy',
    launcherName: 'KAYVEL',
    spawn: (command, args, options) => {
      const child = spawn(command, args ?? [], options ?? {});
      onSpawn?.(child);
      return child;
    },
    extraExecOption: { windowsHide: false, stdio: 'ignore' }
  });
}

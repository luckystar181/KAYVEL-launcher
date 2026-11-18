import { lstat, mkdir, readFile, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireGameDirectoryLock, getInstalledManifest, installRelease, verifyInstalledRelease, withInstallationLock } from './installer.js';
import { safeRelativePath, writeNewFile } from './install-files.js';
import { fileDigest } from './official-download.js';
import { availableJava21, validJava21 } from './java-runtime.js';
import { prepareJava, PREPARED_JAVA } from './prepare-java.js';
import { prepareMinecraft } from './prepare-minecraft.js';
import { NEOFORGE_RUNTIME_FILES, prepareNeoForge } from './prepare-neoforge.js';
import { PreparationFiles, type FileReceipt } from './preparation-files.js';
import { stageProgress, type ReportProgress } from './preparation-progress.js';

export const INSTANCE_FOLDER = 'kayvel-1.21.1-neoforge-21.1.252-v3S';
const incompletePath = '.preparation/incomplete.json';
const readyPath = '.preparation/ready.json';
export const instancePath = (userData: string) => join(userData, 'instances', INSTANCE_FOLDER);

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function realDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Небезопасный каталог установки: ' + path);
}

export async function verifyPreparation(root: string, publicKey: string, report: ReportProgress = () => {}): Promise<void> {
  await realDirectory(root);
  if (await exists(join(root, incompletePath))) throw new Error('Подготовка не завершена. Файлы сохранены для проверки; автоматическое восстановление отключено.');
  await verifyPreparedFiles(root, publicKey, report);
}

async function verifyPreparedFiles(root: string, publicKey: string, report: ReportProgress): Promise<void> {
  await realDirectory(join(root, '.preparation'));
  const recordPath = join(root, readyPath);
  const info = await lstat(recordPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 5_000_000) throw new Error('Неверная запись подготовки.');
  const record = JSON.parse(await readFile(recordPath, 'utf8')) as { schema?: number; instance?: string; files?: FileReceipt[] };
  if (record.schema !== 1 || record.instance !== INSTANCE_FOLDER || !Array.isArray(record.files) || record.files.length < 3 || record.files.length > 30_000) throw new Error('Неподдерживаемая запись подготовки.');
  const seen = new Set<string>();
  const checkedDirectories = new Set<string>();
  let completedFiles = 0;
  for (const file of record.files) {
    if (!file || typeof file.path !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Неверная запись подготовленного файла.');
    safeRelativePath(file.path);
    if (!/^(?:libraries|versions|assets|runtime|\.preparation)\//.test(file.path) && file.path !== '.kayvel-neoforge-ready') throw new Error('Неожиданный путь подготовленного файла.');
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new Error('Повторный путь подготовленного файла.');
    seen.add(key);
    const parts = file.path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const directory = join(root, ...parts.slice(0, index));
      if (!checkedDirectories.has(directory)) { await realDirectory(directory); checkedDirectories.add(directory); }
    }
    const path = join(root, file.path);
    const current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.size !== file.size || await fileDigest(path) !== file.sha256) throw new Error('Подготовленный файл изменён или отсутствует; восстановление отключено: ' + file.path);
    report({ stage: 'verify', file: file.path, received: 0, total: null, completedFiles: ++completedFiles, totalFiles: record.files.length });
  }
  for (const required of ['versions/1.21.1/1.21.1.json', 'versions/1.21.1/1.21.1.jar',
    'versions/neoforge-21.1.252/neoforge-21.1.252.json',
    ...NEOFORGE_RUNTIME_FILES, '.kayvel-neoforge-ready']) {
    if (!seen.has(required)) throw new Error('В записи подготовки отсутствует обязательный файл: ' + required);
  }
  if (!await getInstalledManifest(join(root, '.kayvel'), publicKey)) throw new Error('Подписанная сборка не установлена.');
  await verifyInstalledRelease(root, publicKey);
}

export type PreparationDependencies = {
  java: typeof prepareJava;
  minecraft: typeof prepareMinecraft;
  neoforge: typeof prepareNeoForge;
  modpack: typeof installRelease;
};
const defaults: PreparationDependencies = { java: prepareJava, minecraft: prepareMinecraft, neoforge: prepareNeoForge, modpack: installRelease };

export async function prepareInstance(userData: string, manifestUrl: string, publicKey: string, report: ReportProgress,
    dependencies: PreparationDependencies = defaults): Promise<string> {
  if (!manifestUrl || !publicKey) throw new Error('Новый подписанный выпуск сборки ещё не настроен.');
  const root = instancePath(userData);
  const parent = join(userData, 'instances');
  await mkdir(parent, { recursive: true });
  await realDirectory(parent);
  if (await exists(root)) {
    await realDirectory(root);
    if (await exists(join(root, incompletePath))) throw new Error('Подготовка не завершена. Файлы сохранены для проверки; автоматическое восстановление отключено.');
    if (!await exists(join(root, readyPath))) throw new Error('Каталог экземпляра уже существует без записи подготовки. Файлы не приняты и не изменены.');
    const releaseLock = await acquireGameDirectoryLock(root);
    try { await verifyPreparation(root, publicKey, report); }
    finally { await releaseLock(); }
    stageProgress(report, 'ready', 'Сборка проверена');
    return root;
  }
  const disk = await statfs(parent);
  if (disk.bavail * disk.bsize < 4_000_000_000) throw new Error('Для чистой установки нужно не менее 4 ГБ свободного места.');
  await mkdir(root);
  return withInstallationLock(root, async install => {
    await writeNewFile(root, incompletePath, JSON.stringify({ schema: 1, instance: INSTANCE_FOLDER }));
    const files = new PreparationFiles(root);
    try {
      const java = await dependencies.java(files, userData, report);
      const minecraft = await dependencies.minecraft(files, report);
      await dependencies.neoforge(files, java, minecraft, report);
      if (dependencies.modpack === installRelease) await install(manifestUrl, publicKey, report);
      else await dependencies.modpack(root, manifestUrl, publicKey, report);
      stageProgress(report, 'verify', 'Проверка подготовленного экземпляра');
      await files.write(readyPath, JSON.stringify({ schema: 1, instance: INSTANCE_FOLDER, files: [...files.receipts.values()] }));
      await verifyPreparedFiles(root, publicKey, report);
      await unlink(join(root, incompletePath));
      stageProgress(report, 'ready', 'Minecraft, NeoForge и сборка готовы');
      return root;
    } catch (error) {
      stageProgress(report, 'error', 'Подготовка остановлена. Файлы сохранены для проверки.');
      throw error;
    }
  });
}

export function preparedJava(root: string, userData: string): string {
  const managed = join(root, PREPARED_JAVA);
  if (validJava21(managed)) return managed;
  const java = availableJava21(userData);
  if (!java) throw new Error('Java 21 недоступна. Автоматическое восстановление отключено.');
  return java;
}

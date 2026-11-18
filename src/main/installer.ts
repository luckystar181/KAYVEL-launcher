import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, lstat, open, readFile, link, rmdir, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Manifest, ManagedFile, validReleaseUrl, verifyManifest } from './manifest.js';
import { downloadReleaseBytes, readReleaseBody, withReleaseDownload } from './release-download.js';
import { stageProgress, type ReportProgress } from './preparation-progress.js';
import { assertOptionalDestinationsFree, hasOptionalModsMarker, inspectOptionalMod, isSwitchable, optionalModsMarker, optionalModsMarkerPath } from './optional-mod-files.js';

async function regularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error('Refusing to use a link or non-file: ' + path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function existingDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe installation directory: ' + path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function safeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: false }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  if (!await existingDirectory(path)) throw new Error('Installation directory disappeared: ' + path);
}

function managedDirectories(files: ManagedFile[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.path.split('/');
    for (let depth = 1; depth < parts.length; depth++) directories.add(parts.slice(0, depth).join('/'));
  }
  return [...directories];
}

async function verifyParentDirectories(root: string, file: ManagedFile): Promise<void> {
  for (const directory of managedDirectories([file])) {
    if (!await existingDirectory(join(root, directory))) {
      throw new Error('Каталог установленного модпака отсутствует; автоматическое восстановление отключено: ' + directory);
    }
  }
}

const INCOMPLETE_INSTALL = 'install-incomplete.json';

async function entryExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function acquireGameDirectoryLock(root: string): Promise<() => Promise<void>> {
  await safeDirectory(root);
  const meta = join(root, '.kayvel');
  await safeDirectory(meta);
  const lock = join(meta, 'lock');
  try { await mkdir(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Папка игры заблокирована: игра или установка уже выполняется, либо осталась старая блокировка.');
    }
    throw error;
  }
  try {
    if (await entryExists(join(meta, INCOMPLETE_INSTALL))) {
      throw new Error('Обнаружена незавершённая установка модпака. Не запускайте игру и не удаляйте файлы .kayvel до проверки.');
    }
  } catch (error) {
    await rmdir(lock);
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    await rmdir(lock);
    released = true;
  };
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function matches(path: string, file: ManagedFile): Promise<boolean> {
  if (!await regularFile(path)) return false;
  return (await lstat(path)).size === file.size && await hashFile(path) === file.sha256;
}

async function fetchSignedManifest(url: string, key: string): Promise<{ manifest: Manifest; bytes: Buffer; signature: string }> {
  if (!validReleaseUrl(url) || !url.endsWith('.json')) throw new Error('Untrusted manifest URL');
  const bytes = await downloadReleaseBytes(url, 1_000_000);
  const signature = (await downloadReleaseBytes(url + '.sig', 1024)).toString('utf8');
  return { manifest: verifyManifest(bytes, signature, key), bytes, signature };
}

export async function getInstalledManifest(meta: string, key: string): Promise<{ manifest: Manifest; bytes: Buffer } | undefined> {
  const recordFile = join(meta, 'signed-manifest.json');
  if (!await regularFile(recordFile)) return undefined;
  const info = await lstat(recordFile);
  if (info.size > 1_500_000) throw new Error('Installed manifest record is too large');
  const record: unknown = JSON.parse(await readFile(recordFile, 'utf8'));
  if (!record || typeof record !== 'object' || !('bytes' in record) || !('signature' in record) ||
      typeof record.bytes !== 'string' || typeof record.signature !== 'string') throw new Error('Invalid installed manifest record');
  const bytes = Buffer.from(record.bytes, 'base64');
  return { manifest: verifyManifest(bytes, record.signature, key), bytes };
}

function sameInstalledRelease(previous: Manifest, next: Manifest): boolean {
  if (previous.buildVersion !== next.buildVersion || previous.files.length !== next.files.length) return false;
  const files = new Map(previous.files.map(file => [file.path, file]));
  return next.files.every(file => {
    const old = files.get(file.path);
    return old?.size === file.size && old.sha256 === file.sha256;
  });
}

async function verifyInstalledFiles(root: string, installed: { manifest: Manifest; bytes: Buffer }): Promise<void> {
  const { manifest, bytes } = installed;
  const canSwitch = await hasOptionalModsMarker(root, bytes);
  for (const file of manifest.files) {
    await verifyParentDirectories(root, file);
    if (canSwitch && isSwitchable(file)) await inspectOptionalMod(root, file);
    else if (!await matches(join(root, file.path), file)) {
      throw new Error('Файл установленного модпака изменён или отсутствует; автоматическое восстановление отключено: ' + file.path);
    }
  }
}

export async function verifyInstalledRelease(root: string, publicKeyPem: string): Promise<void> {
  const installed = await getInstalledManifest(join(root, '.kayvel'), publicKeyPem);
  if (installed) await verifyInstalledFiles(root, installed);
  else if (await entryExists(optionalModsMarkerPath(root))) {
    throw new Error('Метка модпака существует, но подписанный манифест отсутствует. Проверьте файлы вручную.');
  }
}

async function fetchFile(file: ManagedFile, part: string, progress: (received: number) => void): Promise<void> {
  let size = 0;
  await withReleaseDownload(file.url, async (response, signal) => {
    const handle = await open(part, 'wx', 0o600);
    let received = 0;
    try {
      size = await readReleaseBody(response, file.size, signal, async value => {
        let written = 0;
        while (written < value.byteLength) {
          signal.throwIfAborted();
          const result = await handle.write(value, written, value.byteLength - written);
          if (result.bytesWritten === 0) throw new Error('Disk write failed');
          written += result.bytesWritten;
        }
        received += value.byteLength;
        progress(received);
      });
      await handle.sync();
    } finally { await handle.close(); }
  });
  if (size !== file.size || !await matches(part, file)) {
    throw new Error('Downloaded file failed SHA-256 or size check');
  }
}

async function createDurableFile(path: string, contents: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(contents, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}

export async function withInstallationLock<T>(root: string,
    action: (install: (manifestUrl: string, publicKeyPem: string, report?: ReportProgress) => Promise<string>) => Promise<T>): Promise<T> {
  const releaseLock = await acquireGameDirectoryLock(root);
  let active = true;
  let pending: Promise<string> | undefined;
  try {
    const result = await action((url, key, report = () => {}) => {
      if (!active) throw new Error('Блокировка установки уже освобождена.');
      if (pending) throw new Error('В этой блокировке установка сборки уже начата.');
      pending = Promise.resolve().then(async () => {
        stageProgress(report, 'modpack', 'Проверка подписи сборки');
        const signed = await fetchSignedManifest(url, key);
        return installVerifiedRelease(root, signed, key, report);
      });
      void pending.catch(() => {});
      return pending;
    });
    active = false;
    if (pending) await pending;
    return result;
  } finally {
    active = false;
    try { if (pending) await Promise.allSettled([pending]); }
    finally { await releaseLock(); }
  }
}

export async function installRelease(root: string, manifestUrl: string, publicKeyPem: string, report: ReportProgress = () => {}): Promise<string> {
  stageProgress(report, 'modpack', 'Проверка подписи сборки');
  const signed = await fetchSignedManifest(manifestUrl, publicKeyPem);
  return withInstallationLock(root, async () => installVerifiedRelease(root, signed, publicKeyPem, report));
}

async function installVerifiedRelease(root: string, signed: Awaited<ReturnType<typeof fetchSignedManifest>>, publicKeyPem: string, report: ReportProgress): Promise<string> {
  const { manifest, bytes, signature } = signed;
  const meta = join(root, '.kayvel');
  const directories = managedDirectories(manifest.files);
  const previous = await getInstalledManifest(meta, publicKeyPem);
  if (previous) {
    if (!sameInstalledRelease(previous.manifest, manifest)) {
      throw new Error('Автоматическое изменение установленного модпака пока отключено: происхождение старых файлов не подтверждено.');
    }
    await verifyInstalledFiles(root, previous);
    return previous.manifest.buildVersion;
  }

  await assertOptionalDestinationsFree(root, manifest.files);
  for (const directory of directories) await safeDirectory(join(root, directory));
  for (const file of manifest.files) {
    if (await regularFile(join(root, file.path))) {
      throw new Error('An unmanaged file already occupies: ' + file.path);
    }
  }
  const stagingRoot = join(meta, 'staging');
  await safeDirectory(stagingRoot);
  const disk = await statfs(root);
  const required = manifest.files.reduce((sum, file) => sum + file.size, 0);
  const available = disk.bavail * disk.bsize;
  if (required > available) throw new Error(`Insufficient disk space: required ${required}, available ${available} bytes`);
  const staging = join(stagingRoot, randomUUID());
  await mkdir(staging);
  let received = 0;
  let completedFiles = 0;
  for (const file of manifest.files) {
    const part = join(staging, createHash('sha256').update(file.path).digest('hex') + '.part');
    const base = received;
    await fetchFile(file, part, current => {
      received = base + current;
      report({ stage: 'modpack', file: file.path, received, total: required, completedFiles, totalFiles: manifest.files.length });
    });
    completedFiles++;
    report({ stage: 'modpack', file: file.path, received, total: required, completedFiles, totalFiles: manifest.files.length });
  }
  stageProgress(report, 'modpack', 'Размещение проверенных файлов сборки');

  const record = JSON.stringify({ bytes: bytes.toString('base64'), signature });
  const incomplete = join(meta, INCOMPLETE_INSTALL);
  await createDurableFile(incomplete, record);
  for (const file of manifest.files) {
    const part = join(staging, createHash('sha256').update(file.path).digest('hex') + '.part');
    const info = await lstat(part);
    if (!info.isFile() || info.nlink !== 1 || !await matches(part, file)) throw new Error('Staged file changed before installation');
    await verifyParentDirectories(root, file);
    const target = join(root, file.path);
    await link(part, target);
    await verifyParentDirectories(root, file);
    if (!await matches(target, file)) throw new Error('Installed file changed during installation');
    await unlink(part);
  }
  await rmdir(staging);
  await createDurableFile(join(meta, 'signed-manifest.json'), record);
  if (manifest.files.some(isSwitchable)) await createDurableFile(optionalModsMarkerPath(root), optionalModsMarker(bytes));
  await unlink(incomplete);
  return manifest.buildVersion;
}

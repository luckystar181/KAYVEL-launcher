import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, readFile, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { sameKnownFile } from './file-identity.js';
import { safeRelativePath } from './install-files.js';
import { acquireGameDirectoryLock, fetchFile, getInstalledManifest, verifyInstalledRelease } from './installer.js';
import { assertRecoveryProcessesStopped } from './lock-processes.js';
import { type ManagedFile } from './manifest.js';
import { compareModpackVersions, validateModpack, type SignedModpack } from './modpack-channel.js';
import { RELEASE_MANIFEST_URL } from './release.js';
import { fileDigest } from './official-download.js';
import { hasOptionalModsMarker, inspectOptionalMod, isSwitchable, optionalModsMarker } from './optional-mod-files.js';
import { verifyPreparation } from './prepare-instance.js';
import { stageProgress, type ReportProgress } from './preparation-progress.js';

const marker = '.kayvel/update-incomplete.json';
const recordPath = '.kayvel/signed-manifest.json';
const optionalPath = '.kayvel/optional-mods-managed.json';
const fail = () => new Error('Обновление остановлено: файл изменён, занят или является ссылкой. Существующие данные сохранены для проверки.');
type Change = { path: string; old?: ManagedFile; next?: ManagedFile };

async function entry(path: string) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function checkedPath(root: string, relative: string, create = false): Promise<string> {
  const parts = safeRelativePath(relative).split('/');
  for (let index = 0; index < parts.length; index++) {
    const directory = join(root, ...parts.slice(0, index));
    if (create && index > 0) await mkdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const info = await entry(directory);
    if (!info?.isDirectory() || info.isSymbolicLink()) throw fail();
  }
  return join(root, ...parts);
}

async function regular(root: string, path: string, file?: Pick<ManagedFile, 'size' | 'sha256'>): Promise<void> {
  const absolute = await checkedPath(root, path);
  const before = await entry(absolute);
  if (!before?.isFile() || before.isSymbolicLink() || before.nlink !== 1n || (file && before.size !== BigInt(file.size))) throw fail();
  const hash = await fileDigest(absolute);
  const after = await entry(absolute);
  if (!after || !sameKnownFile(before, after) || after.nlink !== 1n || before.size !== after.size || (file && hash !== file.sha256)) throw fail();
}

async function smallFile(root: string, path: string): Promise<Buffer> {
  const absolute = await checkedPath(root, path);
  const info = await entry(absolute);
  if (!info || info.size > 1_500_000n) throw fail();
  await regular(root, path);
  return readFile(absolute);
}

async function durable(root: string, path: string, bytes: string | Buffer): Promise<void> {
  const absolute = await checkedPath(root, path, true);
  const handle = await open(absolute, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

async function copyBackup(root: string, source: string, destination: string, file: Pick<ManagedFile, 'size' | 'sha256'>): Promise<void> {
  await regular(root, source, file);
  const target = await checkedPath(root, destination, true);
  await copyFile(await checkedPath(root, source), target, constants.COPYFILE_EXCL);
  const handle = await open(target, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
  await regular(root, destination, file);
  if (await fileDigest(target) !== await fileDigest(await checkedPath(root, source))) throw fail();
}

async function publish(root: string, staged: string, destination: string, file: Pick<ManagedFile, 'size' | 'sha256'>): Promise<void> {
  await regular(root, staged, file);
  const source = await checkedPath(root, staged);
  const target = await checkedPath(root, destination, true);
  await link(source, target);
  const a = await entry(source);
  const b = await entry(target);
  if (!a || !b || !a.isFile() || !b.isFile() || a.isSymbolicLink() || b.isSymbolicLink() || a.nlink !== 2n || b.nlink !== 2n || !sameKnownFile(a, b) || await fileDigest(target) !== file.sha256) throw fail();
  await checkedPath(root, destination);
  await checkedPath(root, staged);
  const finalSource = await entry(source);
  const finalTarget = await entry(target);
  if (!finalSource || !finalTarget || !sameKnownFile(a, finalSource) || !sameKnownFile(a, finalTarget) || finalSource.nlink !== 2n || finalTarget.nlink !== 2n) throw fail();
  await unlink(source);
  await regular(root, destination, file);
}

export async function updateModpack(root: string, candidate: SignedModpack, publicKey: string, report: ReportProgress = () => {},
    checkProcesses: () => Promise<void> = assertRecoveryProcessesStopped, pinnedUrl = RELEASE_MANIFEST_URL): Promise<{ version: string; backup: string | null }> {
  const bytes = Buffer.from(candidate.bytes);
  const signature = candidate.signature;
  const { manifest: next } = validateModpack(bytes, signature, publicKey, pinnedUrl);
  const release = await acquireGameDirectoryLock(root);
  let started = false;
  let backup: string | null = null;
  try {
    await checkProcesses();
    await verifyPreparation(root, publicKey, report);
    const installed = await getInstalledManifest(join(root, '.kayvel'), publicKey);
    if (!installed) throw new Error('Нет установленной подписанной сборки.');
    const order = compareModpackVersions(next.buildVersion, installed.manifest.buildVersion);
    if (order < 0) throw new Error('Откат сборки запрещён.');
    if (order === 0) {
      if (!bytes.equals(installed.bytes)) throw new Error('Содержимое уже опубликованной версии изменено. Выпустите новый номер сборки.');
      return { version: next.buildVersion, backup: null };
    }
    const oldRecord = await smallFile(root, recordPath);
    const digest = (value: Buffer) => ({ size: value.length, sha256: createHash('sha256').update(value).digest('hex') });
    if (!Buffer.from(JSON.parse(oldRecord.toString('utf8')).bytes, 'base64').equals(installed.bytes)) throw fail();
    const managedOptional = await hasOptionalModsMarker(root, installed.bytes);
    const oldOptional = managedOptional ? await smallFile(root, optionalPath) : null;
    const oldFiles = new Map(installed.manifest.files.map(file => [file.path, file]));
    const nextFiles = new Map(next.files.map(file => [file.path, file]));
    const lower = new Map(installed.manifest.files.map(file => [file.path.toLowerCase(), file.path]));
    for (const file of next.files) {
      safeRelativePath(file.path);
      if (lower.has(file.path.toLowerCase()) && lower.get(file.path.toLowerCase()) !== file.path) throw new Error('Смена только регистра пути в обновлении не поддерживается.');
    }
    const changes: Change[] = [];
    for (const file of installed.manifest.files) {
      const replacement = nextFiles.get(file.path);
      const disabled = managedOptional && isSwitchable(file) && await inspectOptionalMod(root, file) === 'disabled';
      const path = disabled ? `.kayvel/disabled-mods/${file.path.slice('mods/'.length)}` : file.path;
      await regular(root, path, file);
      if (!replacement || replacement.size !== file.size || replacement.sha256 !== file.sha256) changes.push({ path, old: file, next: replacement });
    }
    for (const file of next.files) if (!oldFiles.has(file.path)) changes.push({ path: file.path, next: file });
    for (const change of changes) {
      if (!change.old) {
        const path = await checkedPath(root, change.path, true);
        if (await entry(path)) throw new Error('Новый файл конфликтует с пользовательским файлом: ' + change.path);
      }
      if (change.next && isSwitchable(change.next) && !oldFiles.has(change.next.path)) {
        const disabled = `.kayvel/disabled-mods/${change.next.path.slice('mods/'.length)}`;
        const parent = await entry(join(root, '.kayvel', 'disabled-mods'));
        if (parent && (!parent.isDirectory() || parent.isSymbolicLink() || await entry(join(root, disabled)))) throw fail();
      }
    }
    const required = changes.reduce((total, change) => total + (change.old?.size ?? 0) + (change.next?.size ?? 0), 5_000_000);
    const disk = await statfs(root);
    if (disk.bavail * disk.bsize < required) throw new Error('Недостаточно места для загрузки обновления и резервной копии.');
    const transaction = `.kayvel/updates/${randomUUID()}`;
    backup = join(root, transaction, 'backup');
    let received = 0;
    let completedFiles = 0;
    const downloads = changes.filter(change => change.next);
    const total = downloads.reduce((sum, change) => sum + change.next!.size, 0);
    for (let index = 0; index < changes.length; index++) {
      const change = changes[index];
      if (!change.next) continue;
      const staging = `${transaction}/staging/${index}.part`;
      const destination = await checkedPath(root, staging, true);
      const base = received;
      await fetchFile(change.next, destination, current => {
        received = base + current;
        report({ stage: 'modpack', file: change.next!.path, received, total, completedFiles, totalFiles: downloads.length });
      });
      completedFiles++;
      report({ stage: 'modpack', file: change.next.path, received, total, completedFiles, totalFiles: downloads.length });
    }
    const assertMetadata = async () => {
      if (!(await smallFile(root, recordPath)).equals(oldRecord)) throw fail();
      if (oldOptional ? !(await smallFile(root, optionalPath)).equals(oldOptional) : await entry(join(root, optionalPath))) throw fail();
    };
    await assertMetadata();
    await copyBackup(root, recordPath, `${transaction}/backup/signed-manifest.json`, digest(oldRecord));
    if (oldOptional) await copyBackup(root, optionalPath, `${transaction}/backup/optional-mods-managed.json`, digest(oldOptional));
    for (let index = 0; index < changes.length; index++) {
      const change = changes[index];
      if (change.old) await copyBackup(root, change.path, `${transaction}/backup/files/${index}`, change.old);
    }
    const nextRecord = Buffer.from(JSON.stringify({ bytes: bytes.toString('base64'), signature }));
    const nextOptional = Buffer.from(optionalModsMarker(bytes));
    await durable(root, `${transaction}/staging/manifest.json`, nextRecord);
    await durable(root, `${transaction}/staging/optional.json`, nextOptional);
    const journal = JSON.stringify({ schema: 1, from: installed.manifest.buildVersion, to: next.buildVersion, transaction,
      changes: changes.map((change, index) => ({ ...change, backup: change.old ? `files/${index}` : null })) });
    await durable(root, `${transaction}/backup/transaction.json`, journal);
    await verifyPreparation(root, publicKey, report);
    await checkProcesses();
    await assertMetadata();
    await regular(root, `${transaction}/backup/signed-manifest.json`, digest(oldRecord));
    if (oldOptional) await regular(root, `${transaction}/backup/optional-mods-managed.json`, digest(oldOptional));
    for (let index = 0; index < changes.length; index++) {
      const change = changes[index];
      if (change.old) await regular(root, `${transaction}/backup/files/${index}`, change.old);
      if (change.next) await regular(root, `${transaction}/staging/${index}.part`, change.next);
    }
    await regular(root, `${transaction}/staging/manifest.json`, digest(nextRecord));
    await regular(root, `${transaction}/staging/optional.json`, digest(nextOptional));
    await regular(root, `${transaction}/backup/transaction.json`, digest(Buffer.from(journal)));
    started = true;
    await durable(root, marker, journal);
    stageProgress(report, 'modpack', 'Применение обновления; резервная копия сохранена');
    for (let index = 0; index < changes.length; index++) {
      const change = changes[index];
      await assertMetadata();
      if (change.old) {
        await regular(root, `${transaction}/backup/files/${index}`, change.old);
        await regular(root, change.path, change.old);
        await unlink(await checkedPath(root, change.path));
      }
      if (change.next) await publish(root, `${transaction}/staging/${index}.part`, change.path, change.next);
      stageProgress(report, 'modpack', change.path);
    }
    await assertMetadata();
    await regular(root, `${transaction}/backup/signed-manifest.json`, digest(oldRecord));
    await regular(root, recordPath, digest(oldRecord));
    await unlink(await checkedPath(root, recordPath));
    await publish(root, `${transaction}/staging/manifest.json`, recordPath, digest(nextRecord));
    if (oldOptional) {
      await regular(root, `${transaction}/backup/optional-mods-managed.json`, digest(oldOptional));
      await regular(root, optionalPath, digest(oldOptional));
      await unlink(await checkedPath(root, optionalPath));
    }
    await publish(root, `${transaction}/staging/optional.json`, optionalPath, digest(nextOptional));
    await verifyInstalledRelease(root, publicKey);
    await regular(root, recordPath, digest(nextRecord));
    await regular(root, optionalPath, digest(nextOptional));
    await regular(root, `${transaction}/backup/signed-manifest.json`, digest(oldRecord));
    if (oldOptional) await regular(root, `${transaction}/backup/optional-mods-managed.json`, digest(oldOptional));
    await regular(root, `${transaction}/backup/transaction.json`, digest(Buffer.from(journal)));
    for (let index = 0; index < changes.length; index++) {
      const change = changes[index];
      if (change.old) await regular(root, `${transaction}/backup/files/${index}`, change.old);
      if (!change.next && await entry(await checkedPath(root, change.path))) throw fail();
    }
    for (const file of next.files) {
      const disabled = isSwitchable(file) && await inspectOptionalMod(root, file) === 'disabled';
      await regular(root, disabled ? `.kayvel/disabled-mods/${file.path.slice('mods/'.length)}` : file.path, file);
    }
    await regular(root, marker, digest(Buffer.from(journal)));
    await unlink(await checkedPath(root, marker));
    started = false;
    stageProgress(report, 'ready', 'Сборка обновлена');
    return { version: next.buildVersion, backup };
  } catch (error) {
    if (started) throw new Error(`Обновление прервано. Запуск заблокирован до проверки; резервная копия: ${backup}. Не удаляйте update-incomplete.json.`, { cause: error });
    throw error;
  } finally { await release(); }
}

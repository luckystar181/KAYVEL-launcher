import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { assertRecoveryProcessesStopped, processMayBeAlive } from './lock-processes.js';

export type GameDirectoryLock = (() => Promise<void>) & { trackChild?: (pid: number) => void };
type Owner = { schema: 1; id: string; pid: number };
type LockRecord = { owner: Owner | undefined; names: string[]; childPids: number[] };
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const ownerName = new RegExp(`^owner-(${uuid})\\.json$`);
const blocked = () => new Error('Папка игры заблокирована: игра или установка уже выполняется, либо старую блокировку нельзя безопасно снять.');

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function realDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw blocked();
}

async function readRecord(lock: string): Promise<LockRecord> {
  await realDirectory(lock);
  const names = await readdir(lock);
  if (names.length > 32) throw blocked();
  const owners = names.filter(name => ownerName.test(name));
  if (!names.length) return { owner: undefined, names, childPids: [] };
  if (owners.length !== 1) throw blocked();
  const id = ownerName.exec(owners[0])![1];
  const children = new RegExp(`^child-${id}-([1-9][0-9]*)\\.json$`);
  let owner: Owner | undefined;
  const childPids: number[] = [];
  for (const name of names) {
    if (name !== owners[0] && !children.test(name)) throw blocked();
    const path = join(lock, name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024) throw blocked();
    const value = JSON.parse(await readFile(path, 'utf8')) as Owner;
    if (!value || value.schema !== 1 || value.id !== id || !Number.isSafeInteger(value.pid) || value.pid <= 0) throw blocked();
    if (name === owners[0]) owner = value;
    else {
      if (value.pid !== Number(children.exec(name)![1])) throw blocked();
      childPids.push(value.pid);
    }
  }
  return { owner, names, childPids };
}

async function incomplete(root: string, meta: string): Promise<'install' | 'preparation' | undefined> {
  if (await exists(join(meta, 'install-incomplete.json'))) return 'install';
  const preparation = join(root, '.preparation');
  if (!await exists(preparation)) return undefined;
  await realDirectory(preparation);
  return await exists(join(preparation, 'incomplete.json')) ? 'preparation' : undefined;
}

async function lockDirectories(root: string, meta: string, lock: string): Promise<void> {
  await realDirectory(root);
  await realDirectory(meta);
  await realDirectory(lock);
}

async function removeGeneration(root: string, meta: string, lock: string, names: string[]): Promise<void> {
  try {
    for (const name of [...names].sort((a, b) => Number(ownerName.test(a)) - Number(ownerName.test(b)))) {
      await lockDirectories(root, meta, lock);
      await unlink(join(lock, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    // A successor is published with its unique owner already inside: rmdir cannot remove it.
    await lockDirectories(root, meta, lock);
    await rmdir(lock).catch((error: NodeJS.ErrnoException) => {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code || '')) throw error;
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function recover(root: string, meta: string, lock: string): Promise<void> {
  try {
    await lockDirectories(root, meta, lock);
    const initial = await readRecord(lock);
    if (initial.owner && processMayBeAlive(initial.owner.pid)) throw blocked();
    if (await incomplete(root, meta)) throw blocked();
    // Read child registrations only after the owner is known to have stopped writing them.
    const stopped = await readRecord(lock);
    if (stopped.owner?.id !== initial.owner?.id || stopped.owner?.pid !== initial.owner?.pid ||
        stopped.childPids.some(processMayBeAlive)) throw blocked();
    await assertRecoveryProcessesStopped();
    if (await incomplete(root, meta)) throw blocked();
    await removeGeneration(root, meta, lock, stopped.names);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw blocked();
  }
}

export async function acquireGameDirectoryLock(root: string): Promise<GameDirectoryLock> {
  await mkdir(root).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
  await realDirectory(root);
  const meta = join(root, '.kayvel');
  await mkdir(meta).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
  await realDirectory(meta);
  const lock = join(meta, 'lock');
  const id = randomUUID();
  const name = `owner-${id}.json`;
  const candidate = join(meta, `lock-candidate-${id}`);
  const owner: Owner = { schema: 1, id, pid: process.pid };
  await mkdir(candidate);
  let published = false;
  try {
    const file = await open(join(candidate, name), 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(owner)); await file.sync(); }
    finally { await file.close(); }
    for (let attempt = 0; attempt < 3 && !published; attempt++) {
      if (await exists(lock)) await recover(root, meta, lock);
      try {
        await lockDirectories(root, meta, candidate);
        await rename(candidate, lock);
        published = true;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '') || !await exists(lock)) throw error;
      }
    }
    if (!published) throw blocked();
  } finally {
    if (!published) await removeGeneration(root, meta, candidate, [name]);
  }
  const ownedNames = [name];
  let released = false;
  let releasing: Promise<void> | undefined;
  const release: GameDirectoryLock = () => {
    if (released) return Promise.resolve();
    if (releasing) return releasing;
    releasing = removeGeneration(root, meta, lock, ownedNames).then(() => { released = true; }).finally(() => { releasing = undefined; });
    return releasing;
  };
  release.trackChild = pid => {
    if (released || releasing || !Number.isSafeInteger(pid) || pid <= 0) throw blocked();
    const childName = `child-${id}-${pid}.json`;
    if (ownedNames.includes(childName)) return;
    const descriptor = openSync(join(lock, childName), 'wx', 0o600);
    ownedNames.push(childName);
    try { writeFileSync(descriptor, JSON.stringify({ schema: 1, id, pid })); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
  };
  try {
    const unfinished = await incomplete(root, meta);
    if (unfinished === 'preparation') throw new Error('Подготовка не завершена. Файлы сохранены для проверки; автоматическое восстановление отключено.');
    if (unfinished) throw new Error('Обнаружена незавершённая установка модпака. Не запускайте игру и не удаляйте файлы .kayvel до проверки.');
  } catch (error) {
    await release();
    throw error;
  }
  return release;
}

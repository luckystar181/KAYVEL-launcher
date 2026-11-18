import { assertRecoveryProcessesStopped } from './lock-processes.js';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { checkDownloadCancelled } from './download-session.js';
import { safeRelativePath, writeNewFile } from './install-files.js';

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function directory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Небезопасный каталог повторной подготовки. Файлы сохранены.');
}

export async function backupIncompletePreparation(root: string, instance: string): Promise<string> {
  checkDownloadCancelled();
  await directory(root);
  const meta = join(root, '.kayvel');
  const preparation = join(root, '.preparation');
  await directory(meta);
  await directory(preparation);
  for (const name of ['update-incomplete.json', 'install-incomplete.json']) {
    if (await exists(join(meta, name))) throw new Error('Незавершённая установка или обновление модпака требует отдельной проверки. Повтор подготовки заблокирован.');
  }
  if (await exists(join(preparation, 'ready.json'))) throw new Error('Запись готовой сборки уже существует. Автоматический сброс запрещён.');
  const marker = join(preparation, 'incomplete.json');
  const info = await lstat(marker);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024) throw new Error('Неверная отметка незавершённой подготовки.');
  const markerBytes = await readFile(marker);
  const value = JSON.parse(markerBytes.toString('utf8'));
  if (value?.schema !== 1 || value.instance !== instance) throw new Error('Происхождение незавершённой подготовки не подтверждено.');
  await assertRecoveryProcessesStopped();
  const components = ['runtime', 'assets', 'libraries', 'versions', '.kayvel-neoforge-ready'];
  const moves: { source: string; target: string }[] = [];
  for (const name of components) {
    if (!await exists(join(root, name))) continue;
    const entry = await lstat(join(root, name));
    if (entry.isSymbolicLink() || (name === '.kayvel-neoforge-ready' ? !entry.isFile() || entry.nlink !== 1 : !entry.isDirectory())) throw new Error('Небезопасный компонент подготовки: ' + name);
    moves.push({ source: name, target: 'components/' + name });
  }
  const entries = await readdir(preparation);
  if (entries.length > 30_000) throw new Error('Слишком много файлов подготовки.');
  for (const name of entries) {
    if (name === 'incomplete.json') continue;
    safeRelativePath('.preparation/' + name);
    const entry = await lstat(join(preparation, name));
    if (entry.isSymbolicLink() || (!entry.isDirectory() && (!entry.isFile() || entry.nlink !== 1))) throw new Error('Небезопасный файл незавершённой подготовки.');
    moves.push({ source: '.preparation/' + name, target: 'preparation/' + name });
  }
  const backups = join(meta, 'preparation-backups');
  await mkdir(backups).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
  await directory(backups);
  const relative = '.kayvel/preparation-backups/' + randomUUID();
  const backup = join(root, relative);
  await mkdir(backup);
  await mkdir(join(backup, 'components'));
  await mkdir(join(backup, 'preparation'));
  await writeNewFile(backup, 'preparation/incomplete.json', markerBytes);
  await writeNewFile(backup, 'backup.json', JSON.stringify({ schema: 1, instance, moves }));
  for (const move of moves) {
    checkDownloadCancelled();
    await directory(root);
    await directory(meta);
    await directory(preparation);
    await directory(backups);
    await directory(backup);
    await directory(join(backup, 'components'));
    await directory(join(backup, 'preparation'));
    await rename(join(root, move.source), join(backup, move.target));
  }
  return relative;
}

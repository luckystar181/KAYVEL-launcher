import { open, readEntry, walkEntriesGenerator } from '@xmcl/unzip';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function safeRelativePath(value: string): string {
  if (typeof value !== 'string' || value.length > 240 || value.includes('\\') || value.split('/').some(part =>
    !part || part === '.' || part === '..' || /[\x00-\x1f<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Небезопасный путь в установочных данных.');
  }
  return value;
}

export async function readZipFiles(path: string, select: (name: string) => boolean, limit = 100_000_000): Promise<Map<string, Buffer>> {
  const zip = await open(path, { lazyEntries: true });
  const files = new Map<string, Buffer>();
  let total = 0;
  let count = 0;
  try {
    for await (const entry of walkEntriesGenerator(zip)) {
      if (++count > 20_000) throw new Error('Слишком много записей в архиве.');
      const directory = entry.fileName.endsWith('/');
      const name = safeRelativePath(directory ? entry.fileName.slice(0, -1) : entry.fileName);
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (mode === 0xa000 || (mode && mode !== 0x8000 && mode !== 0x4000)) throw new Error('Ссылка или специальный файл в архиве.');
      if (directory || !select(name)) continue;
      const key = name.toLowerCase();
      if ([...files.keys()].some(value => value.toLowerCase() === key)) throw new Error('Повторяющийся путь в архиве.');
      total += entry.uncompressedSize;
      if (!Number.isSafeInteger(total) || total > limit || entry.uncompressedSize > limit) throw new Error('Архив превышает допустимый размер.');
      const bytes = await readEntry(zip, entry);
      if (bytes.length !== entry.uncompressedSize) throw new Error('Размер записи архива не совпадает.');
      files.set(name, bytes);
    }
    return files;
  } finally { zip.close(); }
}

export async function prepareFileDirectory(root: string, relative: string): Promise<string> {
  const parts = safeRelativePath(relative).split('/');
  let directory = root;
  const check = async () => {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Небезопасный установочный каталог: ' + directory);
  };
  await check();
  for (const part of parts.slice(0, -1)) {
    directory = join(directory, part);
    await mkdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    await check();
  }
  return join(root, relative);
}

export async function writeNewFile(root: string, relative: string, bytes: Uint8Array | string): Promise<void> {
  const destination = await prepareFileDirectory(root, relative);
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
}

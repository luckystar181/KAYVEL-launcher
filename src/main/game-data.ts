import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const owner = Buffer.from('KAYVEL game defaults v1\n');
const fail = () => new Error('Не удалось безопасно добавить настройки сборки. Существующие файлы сохранены.');

function directory(path: string, create = false) {
  if (!lstat(path) && create) mkdirSync(path);
  const entry = lstat(path);
  if (!entry?.isDirectory() || entry.isSymbolicLink()) throw fail();
}

function lstat(path: string) {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function readGameData(path: string): Buffer | null {
  const entry = lstat(path);
  if (!entry) return null;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > 4_194_304) throw fail();
  const bytes = readFileSync(path);
  if (bytes.length > 4_194_304) throw fail();
  return bytes;
}

// The caller holds the game-directory lock; original bytes are retained before any replacement.
export function gameDataWriter(gamePath: string) {
  const metadata = join(gamePath, '.kayvel');
  const history = join(metadata, 'game-defaults-v1');
  directory(gamePath);
  directory(metadata);
  if (!lstat(history)) {
    mkdirSync(history);
    writeFileSync(join(history, 'owner.txt'), owner, { flag: 'wx' });
  }
  const check = () => {
    directory(gamePath);
    directory(metadata);
    directory(history);
    if (!readGameData(join(history, 'owner.txt'))?.equals(owner)) throw fail();
  };
  check();
  const immutable = (path: string, bytes: Buffer) => {
    check();
    const current = readGameData(path);
    if (current) {
      if (!current.equals(bytes)) throw fail();
    } else writeFileSync(path, bytes, { flag: 'wx' });
  };
  return {
    completed(name: string) {
      check();
      const bytes = readGameData(join(history, `${name}.done`));
      if (bytes && !bytes.equals(owner)) throw fail();
      return bytes !== null;
    },
    complete(name: string) { immutable(join(history, `${name}.done`), owner); },
    replace(name: string, previous: Buffer | null, next: Buffer) {
      check();
      if (next.length > 4_194_304) throw fail();
      if (previous?.equals(next)) return;
      if (previous) {
        const sha = createHash('sha256').update(previous).digest('hex');
        immutable(join(history, `${sha}.${name}.bak`), previous);
      }
      const path = join(gamePath, name);
      const pending = join(gamePath, `.kayvel-defaults-${randomUUID()}.tmp`);
      writeFileSync(pending, next, { flag: 'wx' });
      try {
        check();
        const current = readGameData(path);
        if (previous ? !current?.equals(previous) : current !== null) throw fail();
        renameSync(pending, path);
      } finally {
        check();
        if (readGameData(pending)?.equals(next)) unlinkSync(pending);
      }
    }
  };
}

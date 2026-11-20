import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateNickname } from './vanilla.js';

type StoredProfile = { version: 3; nickname: string };
type ProfileState = { value: StoredProfile; sequence: number; tail: string | null };
export type LocalProfile = { nickname: string };

const maxProfile = 1_500_000;
const maxRevisions = 256;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function fileName(value: unknown): string {
  const name = validateNickname(value);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) throw new Error('Этот ник зарезервирован Windows для имён файлов. Выберите другой ник.');
  return name;
}

function info(path: string) {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function directory(path: string, create = false): boolean {
  let entry = info(path);
  if (!entry && create) {
    try { mkdirSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    entry = info(path);
  }
  if (!entry) return false;
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Папка локального профиля недоступна или является ссылкой.');
  return true;
}

function profileBytes(path: string, limit = maxProfile): Buffer | null {
  const entry = info(path);
  if (!entry) return null;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > limit) throw new Error('Не удалось безопасно прочитать локальный профиль.');
  const bytes = readFileSync(path);
  if (bytes.length > limit) throw new Error('Локальный файл профиля слишком велик.');
  return bytes;
}

function parseProfile(data: unknown): StoredProfile {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
  const value = data as { version?: unknown; nickname?: unknown };
  // Version 2 profiles contained local texture data. Read only the nickname and never inspect or copy it.
  if ((value.version !== 2 && value.version !== 3) || typeof value.nickname !== 'string') throw new Error();
  if (value.nickname) fileName(value.nickname);
  return { version: 3, nickname: value.nickname };
}

export function createLocalProfileStore(userData: string) {
  const root = join(userData, 'local-player');
  const profilePath = join(root, 'profile.json');
  const revisions = join(root, 'profile-revisions');
  const lock = join(root, 'profile.lock');
  const empty = (): StoredProfile => ({ version: 3, nickname: '' });

  function readStored(): ProfileState {
    if (!directory(root)) return { value: empty(), sequence: 0, tail: null };
    try {
      const base = profileBytes(profilePath);
      let value = base ? parseProfile(JSON.parse(base.toString('utf8'))) : empty();
      let tail = base ? digest(base) : null;
      let sequence = 0;
      if (directory(revisions)) {
        const names = readdirSync(revisions).sort();
        if (names.length > maxRevisions) throw new Error();
        for (const name of names) {
          sequence++;
          if (name !== `${String(sequence).padStart(6, '0')}.json`) throw new Error();
          const bytes = profileBytes(join(revisions, name), maxProfile + 1024);
          if (!bytes) throw new Error();
          const record: unknown = JSON.parse(bytes.toString('utf8'));
          if (!record || typeof record !== 'object' || Array.isArray(record) || !('version' in record) || record.version !== 1
            || !('previous' in record) || record.previous !== tail || !('profile' in record)) throw new Error();
          value = parseProfile(record.profile);
          tail = digest(bytes);
        }
      }
      return { value, sequence, tail };
    } catch {
      throw new Error('Локальный профиль повреждён или недоступен. Существующие файлы не изменены; проверьте папку local-player.');
    }
  }

  function view(profile: StoredProfile): LocalProfile { return { nickname: profile.nickname }; }

  function locked<T>(action: () => T): T {
    directory(root, true);
    try { mkdirSync(lock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Локальный профиль заблокирован. Проверьте другие экземпляры лаунчера и состояние profile.lock.');
      throw error;
    }
    try { return action(); }
    finally { rmdirSync(lock); }
  }

  function commit(previous: ProfileState, next: StoredProfile): LocalProfile {
    if (previous.sequence >= maxRevisions) throw new Error('Достигнут предел локальных изменений профиля. Сохраните данные и проверьте историю вручную.');
    directory(revisions, true);
    const current = readStored();
    if (current.sequence !== previous.sequence || current.tail !== previous.tail) {
      throw new Error('Профиль изменён извне. Старые файлы сохранены; проверьте состояние вручную.');
    }
    const name = `${String(previous.sequence + 1).padStart(6, '0')}.json`;
    const record = { version: 1, previous: previous.tail, profile: next };
    writeFileSync(join(revisions, name), JSON.stringify(record), { flag: 'wx' });
    return view(next);
  }

  function saveNickname(input: unknown): LocalProfile {
    const nickname = fileName(input);
    return locked(() => {
      const previous = readStored();
      return commit(previous, { version: 3, nickname });
    });
  }

  return { read: () => view(readStored().value), saveNickname };
}

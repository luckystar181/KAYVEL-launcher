import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateNickname } from './vanilla.js';

type SkinModel = 'classic' | 'slim';
type StoredSkin = { model: SkinModel; sha256: string; png: string; copyId: string };
type StoredProfile = { version: 2; nickname: string; skin: StoredSkin | null };
type ProfileState = { value: StoredProfile; sequence: number; tail: string | null };
export type LocalProfile = { nickname: string; skin: { model: SkinModel; bytes: number[]; copyPath: string; copyReady: boolean } | null };

const maxPng = 1_048_576;
const maxProfile = 1_500_000;
const maxRevisions = 256;
const signature = [137, 80, 78, 71, 13, 10, 26, 10];
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function fileName(value: unknown): string {
  const name = validateNickname(value);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) throw new Error('Этот ник зарезервирован Windows для имён файлов. Выберите другой ник.');
  return name;
}

function skinHeader(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 33 || bytes.byteLength > maxPng || !signature.every((byte, i) => bytes[i] === byte)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(8) === 13 && Buffer.from(bytes.subarray(12, 16)).toString('ascii') === 'IHDR'
    && view.getUint32(16) === 64 && [32, 64].includes(view.getUint32(20));
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

function regularFile(path: string, maxSize: number): Buffer | null {
  const entry = info(path);
  if (!entry) return null;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > maxSize) throw new Error('Не удалось безопасно прочитать локальный файл профиля.');
  const bytes = readFileSync(path);
  if (bytes.length > maxSize) throw new Error('Локальный файл профиля слишком велик.');
  return bytes;
}

export function createLocalProfileStore(userData: string, decodeSkin: (bytes: Uint8Array) => boolean) {
  const root = join(userData, 'local-player');
  const profilePath = join(root, 'profile.json');
  const revisions = join(root, 'profile-revisions');
  const copies = join(root, 'skin-copies');
  const lock = join(root, 'profile.lock');
  const empty = (): StoredProfile => ({ version: 2, nickname: '', skin: null });

  function validateProfile(data: unknown): StoredProfile {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    const value = data as StoredProfile;
    if (value.version !== 2 || typeof value.nickname !== 'string') throw new Error();
    if (value.nickname) fileName(value.nickname);
    if (value.skin !== null) {
      const skin = value.skin;
      if (!value.nickname || !skin || typeof skin !== 'object' || !['classic', 'slim'].includes(skin.model)
        || typeof skin.png !== 'string' || typeof skin.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(skin.sha256)
        || typeof skin.copyId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(skin.copyId)) throw new Error();
      const bytes = Buffer.from(skin.png, 'base64');
      if (bytes.toString('base64') !== skin.png || !skinHeader(bytes) || sha256(bytes) !== skin.sha256 || !decodeSkin(bytes)) throw new Error();
    }
    return value;
  }

  function readStored(): ProfileState {
    if (!directory(root)) return { value: empty(), sequence: 0, tail: null };
    try {
      const base = regularFile(profilePath, maxProfile);
      let value = base ? validateProfile(JSON.parse(base.toString('utf8'))) : empty();
      let tail = base ? sha256(base) : null;
      let sequence = 0;
      if (directory(revisions)) {
        const names = readdirSync(revisions).sort();
        if (names.length > maxRevisions) throw new Error();
        for (const name of names) {
          sequence++;
          if (name !== `${String(sequence).padStart(6, '0')}.json`) throw new Error();
          const bytes = regularFile(join(revisions, name), maxProfile + 1024);
          if (!bytes) throw new Error();
          const record: unknown = JSON.parse(bytes.toString('utf8'));
          if (!record || typeof record !== 'object' || Array.isArray(record) || !('version' in record) || record.version !== 1 ||
              !('previous' in record) || record.previous !== tail || !('profile' in record)) throw new Error();
          value = validateProfile(record.profile);
          tail = sha256(bytes);
        }
      }
      return { value, sequence, tail };
    } catch {
      throw new Error('Локальный профиль повреждён или недоступен. Существующие файлы не изменены; проверьте папку local-player.');
    }
  }

  function view(profile: StoredProfile): LocalProfile {
    if (!profile.skin) return { nickname: profile.nickname, skin: null };
    const revision = join(copies, profile.skin.copyId);
    const copyPath = join(revision, `${profile.nickname}.png`);
    let copyReady = false;
    try {
      const copy = directory(root) && directory(copies) && directory(revision) ? regularFile(copyPath, maxPng) : null;
      copyReady = Boolean(copy && sha256(copy) === profile.skin.sha256);
    } catch { copyReady = false; }
    return { nickname: profile.nickname, skin: { model: profile.skin.model, bytes: [...Buffer.from(profile.skin.png, 'base64')], copyPath, copyReady } };
  }

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
    if (next.skin) {
      directory(copies, true);
      const revision = join(copies, next.skin.copyId);
      mkdirSync(revision);
      writeFileSync(join(revision, `${next.nickname}.png`), Buffer.from(next.skin.png, 'base64'), { flag: 'wx' });
    }
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
      const skin = previous.value.skin ? { ...previous.value.skin, copyId: randomUUID() } : null;
      return commit(previous, { version: 2, nickname, skin });
    });
  }

  function saveSkin(input: unknown, model: unknown): LocalProfile {
    if (!(input instanceof Uint8Array) || (model !== 'classic' && model !== 'slim') || !skinHeader(input) || !decodeSkin(input)) {
      throw new Error('Нужен корректный PNG 64×64 или 64×32, не более 1 MiB.');
    }
    return locked(() => {
      const previous = readStored();
      if (!previous.value.nickname) throw new Error('Сначала сохраните ник игрока.');
      const bytes = Buffer.from(input);
      const skin: StoredSkin = { model, sha256: sha256(bytes), png: bytes.toString('base64'), copyId: randomUUID() };
      return commit(previous, { version: 2, nickname: previous.value.nickname, skin });
    });
  }

  return { read: () => view(readStored().value), saveNickname, saveSkin };
}

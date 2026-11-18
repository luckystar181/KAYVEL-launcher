import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalProfile } from './local-profile.js';
import { validateNickname } from './vanilla.js';

const source = { name: 'KAYVEL Local PNG v1', type: 'CustomSkinAPI', root: 'KAYVEL-Local-v1/' };
const marker = Buffer.from('KAYVEL local skin API v1\n');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const fail = () => new Error('Локальный скин не применён: конфликт или небезопасный файл в CustomSkinLoader. Существующие данные сохранены.');

function info(path: string) {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function directory(path: string, create = false) {
  if (!info(path) && create) {
    try { mkdirSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const entry = info(path);
  if (!entry?.isDirectory() || entry.isSymbolicLink()) throw fail();
}

function read(path: string, limit = 1_048_576): Buffer | null {
  const entry = info(path);
  if (!entry) return null;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > limit) throw fail();
  const bytes = readFileSync(path);
  if (bytes.length > limit) throw fail();
  return bytes;
}

function immutable(path: string, bytes: Buffer) {
  const previous = read(path);
  if (previous) {
    if (!previous.equals(bytes)) throw fail();
  } else {
    writeFileSync(path, bytes, { flag: 'wx' });
  }
}

function profileBytes(model: 'default' | 'slim', texture: string) {
  return json({ kayvel: 1, textures: { [model]: texture } });
}

function ownedProfile(bytes: Buffer): boolean {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    const keys = Object.keys(value.textures ?? {});
    const model = keys[0];
    const texture = value.textures?.[model];
    return keys.length === 1 && (model === 'default' || model === 'slim') && typeof texture === 'string'
      && /^[a-f0-9]{64}\.png$/.test(texture) && bytes.equals(profileBytes(model, texture));
  } catch { return false; }
}

// Called only while the game-directory lock is held, before starting Java.
export function applyLocalSkin(gamePath: string, profile: LocalProfile): void {
  if (!profile.skin) return;
  const nickname = validateNickname(profile.nickname);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(nickname)) throw fail();
  const { model, bytes } = profile.skin;
  if (!['classic', 'slim'].includes(model) || !Array.isArray(bytes) || bytes.length < 33 || bytes.length > 1_048_576
    || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw fail();
  const png = Buffer.from(bytes);
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR'
    || png.readUInt32BE(16) !== 64 || ![32, 64].includes(png.readUInt32BE(20))) throw fail();
  const csl = join(gamePath, 'CustomSkinLoader');
  const root = join(csl, 'KAYVEL-Local-v1');
  const textures = join(root, 'textures');
  const history = join(root, 'history');
  const extra = join(csl, 'ExtraList');
  const check = () => {
    directory(gamePath);
    directory(csl);
    directory(root);
    if (!read(join(root, 'owner.txt'), 128)?.equals(marker)) throw fail();
  };

  directory(gamePath);
  directory(csl, true);
  const configBytes = read(join(csl, 'CustomSkinLoader.json'));
  let registered = false;
  if (configBytes) {
    let config;
    try { config = JSON.parse(configBytes.toString('utf8')); } catch { throw fail(); }
    if (!Array.isArray(config?.loadlist)) throw fail();
    for (const entry of config.loadlist) {
      if (entry?.name === source.name || entry?.root === source.root) {
        if (entry.name !== source.name || entry.type !== source.type || entry.root !== source.root) throw fail();
        registered = true;
      }
    }
  }
  directory(gamePath);
  directory(csl);
  if (!info(root)) {
    mkdirSync(root);
    immutable(join(root, 'owner.txt'), marker);
  }
  check();
  directory(textures, true);
  directory(history, true);
  directory(extra, true);
  const texture = `${digest(png)}.png`;
  check();
  directory(textures);
  immutable(join(textures, texture), png);

  const path = join(root, `${nickname}.json`);
  const next = profileBytes(model === 'classic' ? 'default' : 'slim', texture);
  const previous = read(path, 4096);
  if (previous && !ownedProfile(previous)) throw fail();
  if (!previous?.equals(next)) {
    if (previous) {
      check();
      directory(history);
      immutable(join(history, `${digest(previous)}.json`), previous);
    }
    check();
    const pending = join(root, `.pending-${randomUUID()}.json`);
    writeFileSync(pending, next, { flag: 'wx' });
    try {
      check();
      const current = read(path, 4096);
      if (previous ? !current?.equals(previous) : current !== null) throw fail();
      renameSync(pending, path);
    } finally {
      check();
      const remaining = read(pending, 4096);
      if (remaining?.equals(next)) unlinkSync(pending);
    }
  }
  if (!registered) {
    check();
    directory(extra);
    immutable(join(extra, 'KAYVEL-Local-v1.json'), json(source));
  }
}

import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalProfile } from './local-profile.js';
import { validateNickname } from './vanilla.js';

const oldSource = { name: 'KAYVEL Local PNG v1', type: 'CustomSkinAPI', root: 'KAYVEL-Local-v1/' };
const selectedSource = { name: 'KAYVEL Local PNG v2', type: 'CustomSkinAPI', root: 'KAYVEL-Local-v2/' };
const marker = Buffer.from('KAYVEL local skin files v2\n');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const fail = () => new Error('Локальный скин не применён: конфликт или небезопасный файл в CustomSkinLoader. Существующие данные сохранены.');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export const localSkinTemplate: { loadlist: Record<string, unknown>[]; enableLocalProfileCache: boolean; forceLoadAllTextures: boolean } = {
  loadlist: [
    selectedSource,
    { name: 'LocalSkin', type: 'Legacy', skin: 'LocalSkin/skins/{USERNAME}.png', cape: 'LocalSkin/capes/{USERNAME}.png', elytra: 'LocalSkin/elytras/{USERNAME}.png', model: 'auto' },
    { name: 'Mojang', type: 'MojangAPI' }
  ],
  enableLocalProfileCache: false,
  forceLoadAllTextures: true
};

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

function replace(path: string, previous: Buffer | null, next: Buffer, check: () => void) {
  if (previous?.equals(next)) return;
  const pending = `${path}.pending-${randomUUID()}`;
  check();
  writeFileSync(pending, next, { flag: 'wx' });
  try {
    check();
    const current = read(path);
    if (previous ? !current?.equals(previous) : current !== null) throw fail();
    renameSync(pending, path);
  } finally {
    check();
    if (read(pending)?.equals(next)) unlinkSync(pending);
  }
}

function parseConfig(bytes: Buffer) {
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw fail(); }
  if (!record(value) || !Array.isArray(value.loadlist) || !value.loadlist.every(record)) throw fail();
  return value as Record<string, unknown> & { loadlist: Record<string, unknown>[] };
}

// Called only while the game-directory lock is held, before starting Java.
export function applyLocalSkin(gamePath: string, profile: LocalProfile): void {
  let nickname = '';
  let png: Buffer | null = null;
  if (profile.skin) {
    nickname = validateNickname(profile.nickname);
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(nickname)) throw fail();
    const { model, bytes } = profile.skin;
    if (!['classic', 'slim'].includes(model) || !Array.isArray(bytes) || bytes.length < 33 || bytes.length > 1_048_576
      || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw fail();
    png = Buffer.from(bytes);
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR'
      || png.readUInt32BE(16) !== 64 || ![32, 64].includes(png.readUInt32BE(20))) throw fail();
  }
  const csl = join(gamePath, 'CustomSkinLoader');
  const root = join(csl, 'KAYVEL-Local-v2');
  const history = join(root, 'history');
  const textures = join(root, 'textures');
  const local = join(csl, 'LocalSkin');
  const skins = join(local, 'skins');
  const extra = join(csl, 'ExtraList');
  const configPath = join(csl, 'CustomSkinLoader.json');
  const kubejs = join(gamePath, 'kubejs');
  const templateDirectory = join(kubejs, 'config');
  const check = () => {
    directory(gamePath);
    directory(csl);
    directory(root);
    if (!read(join(root, 'owner.txt'), 128)?.equals(marker)) throw fail();
    directory(history);
    directory(textures);
    directory(local);
    directory(skins);
    if (info(extra)) directory(extra);
    if (info(kubejs)) directory(kubejs);
    if (info(templateDirectory)) directory(templateDirectory);
  };

  directory(gamePath);
  directory(csl, true);
  if (info(kubejs)) directory(kubejs);
  if (info(templateDirectory)) directory(templateDirectory);
  const templateBytes = read(join(templateDirectory, 'kayvel-customskinloader.json'));
  const template = templateBytes ? parseConfig(templateBytes) : localSkinTemplate;
  if (!json(template).equals(json(localSkinTemplate))) throw fail();
  const configBytes = read(configPath);
  const config = configBytes ? parseConfig(configBytes) : template;
  let oldExtra: Buffer | null = null;
  const oldExtraPath = join(extra, 'KAYVEL-Local-v1.json');
  if (info(extra)) {
    directory(extra);
    for (const name of readdirSync(extra)) {
      if (!/\.(json|txt)$/i.test(name)) continue;
      const bytes = read(join(extra, name));
      if (name !== 'KAYVEL-Local-v1.json' || !bytes?.equals(json(oldSource))) throw fail();
      oldExtra = bytes;
    }
  }
  for (const entry of config.loadlist) {
    if (entry.name === oldSource.name || entry.root === oldSource.root) {
      if (entry.name !== oldSource.name || entry.type !== oldSource.type || entry.root !== oldSource.root) throw fail();
    }
    if ((entry.name === selectedSource.name || entry.root === selectedSource.root)
      && (entry.name !== selectedSource.name || entry.type !== selectedSource.type || entry.root !== selectedSource.root)) throw fail();
  }
  if (!info(root)) {
    mkdirSync(root);
    immutable(join(root, 'owner.txt'), marker);
  }
  directory(root);
  if (!read(join(root, 'owner.txt'), 128)?.equals(marker)) throw fail();
  directory(history, true);
  directory(textures, true);
  directory(local, true);
  directory(skins, true);
  check();

  const archive = (bytes: Buffer, extension: string) => {
    check();
    immutable(join(history, `${digest(bytes)}.${extension}`), bytes);
  };
  if (png && profile.skin) {
    const skinPath = join(skins, `${nickname}.png`);
    const receiptPath = join(root, `${nickname}.json`);
    const previous = read(skinPath);
    const receiptBytes = read(receiptPath, 4096);
    if (receiptBytes) {
      let receipt;
      try { receipt = JSON.parse(receiptBytes.toString('utf8')); } catch { throw fail(); }
      const model = receipt?.model === 'classic' ? 'default' : 'slim';
      if (!record(receipt) || receipt.kayvel !== 2 || !/^[a-f0-9]{64}$/.test(String(receipt.sha256))
        || !['classic', 'slim'].includes(String(receipt.model))
        || !receiptBytes.equals(json({ kayvel: 2, sha256: receipt.sha256, model: receipt.model, textures: { [model]: `${receipt.sha256}.png` } }))
        || (previous && digest(previous) !== receipt.sha256)) throw fail();
      const textureBytes = read(join(textures, `${receipt.sha256}.png`));
      if (!textureBytes || digest(textureBytes) !== receipt.sha256) throw fail();
    } else if (previous && !previous.equals(png)) throw fail();
    const sha256 = digest(png);
    const nextReceipt = json({ kayvel: 2, sha256, model: profile.skin.model, textures: { [profile.skin.model === 'classic' ? 'default' : 'slim']: `${sha256}.png` } });
    immutable(join(textures, `${sha256}.png`), png);
    if (previous && !previous.equals(png)) archive(previous, 'png');
    if (receiptBytes && !receiptBytes.equals(nextReceipt)) archive(receiptBytes, 'json');
    replace(skinPath, previous, png, check);
    replace(receiptPath, receiptBytes, nextReceipt, check);
  }

  const loadlist: Record<string, unknown>[] = [...template.loadlist];
  for (const entry of config.loadlist) {
    const canonical = template.loadlist.find(source => source.name === entry.name);
    if (canonical && Object.entries(canonical).every(([key, value]) => entry[key] === value)) {
      loadlist[loadlist.findIndex(source => source.name === entry.name)] = entry;
    } else {
      loadlist.push(entry);
    }
  }
  const nextConfig = { ...config, loadlist };
  const configNextBytes = json(nextConfig);
  if (!configBytes || JSON.stringify(config) !== JSON.stringify(nextConfig)) {
    if (configBytes) archive(configBytes, 'json');
    replace(configPath, configBytes, configNextBytes, check);
  }
  if (oldExtra) {
    archive(oldExtra, 'json');
    check();
    if (!read(oldExtraPath)?.equals(oldExtra)) throw fail();
    unlinkSync(oldExtraPath);
  }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyLocalSkin } from '../dist/main/game-skin.js';
import { createLocalProfileStore } from '../dist/main/local-profile.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = { name: 'KAYVEL Local PNG v1', type: 'CustomSkinAPI', root: 'KAYVEL-Local-v1/' };

function png(pixel = 0) {
  const bytes = Buffer.alloc(34, pixel);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(64, 16);
  bytes.writeUInt32BE(64, 20);
  return bytes;
}

function fixture(run) {
  const dir = mkdtempSync(join(process.env.KAYVEL_TEST_TMPDIR || tmpdir(), 'kayvel-game-skin-'));
  const game = join(dir, 'game');
  const csl = join(game, 'CustomSkinLoader');
  const root = join(csl, 'KAYVEL-Local-v1');
  mkdirSync(csl, { recursive: true });
  const configPath = join(csl, 'CustomSkinLoader.json');
  const config = Buffer.from('{\n  "loadlist": [{"name":"User custom site","type":"CustomSkinAPI","root":"https://example.invalid/"}],\n  "enableCape": false\n}\n');
  writeFileSync(configPath, config);
  const profile = (pixel = 0, model = 'classic', nickname = 'LocalPlayer') => ({ nickname, skin: { bytes: [...png(pixel)], model, copyReady: false, copyPath: 'not-used' } });
  const apply = (...args) => applyLocalSkin(game, profile(...args));
  try { return run({ dir, game, csl, root, configPath, config, profile, apply }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

for (const model of ['classic', 'slim']) {
  test(`local CSL API uses a content-addressed PNG and explicit ${model} model without changing config`, () => fixture(({ csl, root, configPath, config, apply }) => {
    apply(0, model);
    const texture = `${hash(png())}.png`;
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'LocalPlayer.json'))), { kayvel: 1, textures: { [model === 'classic' ? 'default' : 'slim']: texture } });
    assert.deepEqual(readFileSync(join(root, 'textures', texture)), png());
    assert.deepEqual(JSON.parse(readFileSync(join(csl, 'ExtraList', 'KAYVEL-Local-v1.json'))), source);
    assert.deepEqual(readFileSync(configPath), config);
    apply(0, model);
    assert.equal(readdirSync(join(root, 'textures')).length, 1);
    assert.deepEqual(readdirSync(join(root, 'history')), []);
    assert.equal(readdirSync(root).some(name => name.startsWith('.pending-')), false);
  }));
}

test('changing and reverting PNG/model updates the stable API and preserves all former bytes', () => fixture(({ root, apply }) => {
  apply();
  const first = readFileSync(join(root, 'LocalPlayer.json'));
  apply(37, 'slim');
  const second = readFileSync(join(root, 'LocalPlayer.json'));
  assert.notDeepEqual(first, second);
  assert.deepEqual(readFileSync(join(root, 'history', `${hash(first)}.json`)), first);
  apply();
  assert.deepEqual(readFileSync(join(root, 'LocalPlayer.json')), first);
  assert.deepEqual(readFileSync(join(root, 'history', `${hash(second)}.json`)), second);
  assert.equal(readdirSync(join(root, 'textures')).length, 2);
  assert.deepEqual(readFileSync(join(root, 'textures', `${hash(png(37))}.png`)), png(37));
}));

test('nickname changes, including case-only changes on Windows, retain a working profile', () => fixture(({ dir, game, root }) => {
  const store = createLocalProfileStore(dir, () => true);
  store.saveNickname('PlayerOne');
  applyLocalSkin(game, store.saveSkin(png(), 'slim'));
  const previous = readFileSync(join(root, 'PlayerOne.json'));
  applyLocalSkin(game, store.saveNickname('PlayerTwo'));
  assert.deepEqual(readFileSync(join(root, 'PlayerOne.json')), previous);
  assert.deepEqual(readFileSync(join(root, 'PlayerTwo.json')), previous);
  applyLocalSkin(game, store.saveNickname('playertwo'));
  assert.deepEqual(readFileSync(join(root, 'playertwo.json')), previous);
}));

test('no skin means no game filesystem access; invalid names/skin data fail before writes', () => fixture(({ root, game, profile }) => {
  applyLocalSkin('a-folder-that-does-not-exist', { nickname: '', skin: null });
  for (const nickname of ['../outside', 'CON', 'nul', 'a']) assert.throws(() => applyLocalSkin(game, profile(0, 'classic', nickname)));
  for (const skin of [{ bytes: [1, 2], model: 'slim' }, { bytes: [...png()], model: 'bad' }, { bytes: [...png(), 256], model: 'classic' }]) {
    assert.throws(() => applyLocalSkin(game, { nickname: 'LocalPlayer', skin }));
  }
  assert.equal(existsSync(root), false);
}));

test('first launch without a CSL config supplies ExtraList without generating a replacement config', () => fixture(({ csl, configPath, apply }) => {
  unlinkSync(configPath);
  apply();
  assert.equal(existsSync(configPath), false);
  assert.deepEqual(JSON.parse(readFileSync(join(csl, 'ExtraList', 'KAYVEL-Local-v1.json'))), source);
}));

test('after CSL consumes ExtraList, subsequent launches reuse its registration', () => fixture(({ csl, configPath, apply }) => {
  apply();
  unlinkSync(join(csl, 'ExtraList', 'KAYVEL-Local-v1.json'));
  const config = Buffer.from(JSON.stringify({ loadlist: [source, { name: 'GameProfile', type: 'GameProfile' }] }));
  writeFileSync(configPath, config);
  apply(5, 'slim');
  assert.deepEqual(readFileSync(configPath), config);
  assert.deepEqual(readdirSync(join(csl, 'ExtraList')), []);
}));

for (const conflict of ['malformed-config', 'null-config', 'wrong-registration', 'foreign-root', 'foreign-profile', 'foreign-extra', 'changed-texture', 'changed-history']) {
  test(`CSL conflict preserves the conflicting bytes: ${conflict}`, () => fixture(({ csl, root, configPath, apply }) => {
    let path;
    let bytes = Buffer.from('foreign user data\n');
    let action = () => apply(37, 'slim');
    if (conflict.endsWith('config')) {
      path = configPath;
      if (conflict === 'null-config') bytes = Buffer.from('null');
    } else if (conflict === 'wrong-registration') {
      path = configPath;
      bytes = Buffer.from(JSON.stringify({ loadlist: [{ ...source, root: 'Other/' }] }));
    } else if (conflict === 'foreign-root') {
      mkdirSync(root);
      path = join(root, 'precious.txt');
    } else {
      apply();
      if (conflict === 'foreign-profile') path = join(root, 'LocalPlayer.json');
      if (conflict === 'foreign-extra') path = join(csl, 'ExtraList', 'KAYVEL-Local-v1.json');
      if (conflict === 'changed-texture') { path = join(root, 'textures', `${hash(png())}.png`); action = () => apply(); }
      if (conflict === 'changed-history') {
        const previous = readFileSync(join(root, 'LocalPlayer.json'));
        path = join(root, 'history', `${hash(previous)}.json`);
      }
    }
    writeFileSync(path, bytes);
    assert.throws(action);
    assert.deepEqual(readFileSync(path), bytes);
  }));
}

for (const location of ['game', 'csl', 'root', 'textures', 'history', 'extra']) {
  test(`directory junction at ${location} is rejected without touching target`, () => fixture(({ dir, game, csl, root, apply }) => {
    apply();
    const target = join(dir, 'outside');
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'keep');
    const path = { game, csl, root, textures: join(root, 'textures'), history: join(root, 'history'), extra: join(csl, 'ExtraList') }[location];
    rmSync(path, { recursive: true });
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => apply(7, 'slim'));
    assert.deepEqual(readdirSync(target), ['keep.txt']);
    assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'keep');
  }));
}

for (const location of ['config', 'owner', 'profile', 'texture', 'history', 'extra']) {
  test(`hardlinked ${location} is rejected and its target preserved`, () => fixture(({ dir, csl, root, configPath, apply }) => {
    apply();
    const previous = readFileSync(join(root, 'LocalPlayer.json'));
    const path = { config: configPath, owner: join(root, 'owner.txt'), profile: join(root, 'LocalPlayer.json'),
      texture: join(root, 'textures', `${hash(png())}.png`), history: join(root, 'history', `${hash(previous)}.json`), extra: join(csl, 'ExtraList', 'KAYVEL-Local-v1.json') }[location];
    const bytes = existsSync(path) ? readFileSync(path) : previous;
    const target = join(dir, 'outside-file');
    writeFileSync(target, bytes);
    if (existsSync(path)) unlinkSync(path);
    linkSync(target, path);
    assert.throws(() => location === 'texture' ? apply() : apply(7, 'slim'));
    assert.deepEqual(readFileSync(target), bytes);
  }));
}

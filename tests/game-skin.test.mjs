import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyLocalSkin, localSkinTemplate } from '../dist/main/game-skin.js';
import { createLocalProfileStore } from '../dist/main/local-profile.js';
import { validManagedPath } from '../dist/main/manifest.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const oldSource = { name: 'KAYVEL Local PNG v1', type: 'CustomSkinAPI', root: 'KAYVEL-Local-v1/' };
const json = value => Buffer.from(`${JSON.stringify(value)}\n`);

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
  const root = join(csl, 'KAYVEL-Local-v2');
  const skins = join(csl, 'LocalSkin', 'skins');
  mkdirSync(csl, { recursive: true });
  mkdirSync(join(game, 'kubejs', 'config'), { recursive: true });
  const templatePath = join(game, 'kubejs', 'config', 'kayvel-customskinloader.json');
  const configPath = join(csl, 'CustomSkinLoader.json');
  const config = Buffer.from('{\n  "loadlist": [{"name":"User custom site","type":"CustomSkinAPI","root":"https://example.invalid/"}],\n  "enableCape": false, "version": "15.1", "buildNumber": 42\n}\n');
  writeFileSync(configPath, config);
  const profile = (pixel = 0, model = 'classic', nickname = 'LocalPlayer') => ({ nickname, skin: { bytes: [...png(pixel)], model, copyReady: false, copyPath: 'not-used' } });
  const apply = (...args) => applyLocalSkin(game, profile(...args));
  try { return run({ dir, game, csl, root, skins, configPath, templatePath, config, profile, apply }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

for (const model of ['classic', 'slim']) {
  test(`PNG is written as LocalSkin/skins/nickname.png with explicit ${model} metadata and local before Mojang`, () => fixture(({ csl, root, skins, configPath, config, apply }) => {
    apply(0, model);
    const texture = `${hash(png())}.png`;
    assert.deepEqual(readFileSync(join(skins, 'LocalPlayer.png')), png());
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'LocalPlayer.json'))), { kayvel: 2, sha256: hash(png()), model, textures: { [model === 'classic' ? 'default' : 'slim']: texture } });
    assert.deepEqual(readFileSync(join(root, 'textures', texture)), png());
    const next = JSON.parse(readFileSync(configPath));
    assert.deepEqual(next.loadlist, [...localSkinTemplate.loadlist, ...JSON.parse(config).loadlist]);
    assert.equal(next.enableCape, false);
    assert.equal(next.version, '15.1');
    assert.equal(next.buildNumber, 42);
    assert.deepEqual(readFileSync(join(root, 'history', `${hash(config)}.json`)), config);
    assert.equal(existsSync(join(csl, 'ExtraList')), false);
    const before = readFileSync(configPath);
    const history = readdirSync(join(root, 'history'));
    apply(0, model);
    assert.deepEqual(readFileSync(configPath), before);
    assert.deepEqual(readdirSync(join(root, 'history')), history);
    assert.equal(readdirSync(join(root, 'textures')).length, 1);
    for (const path of [root, csl, skins]) assert.equal(readdirSync(path).some(name => name.includes('.pending-')), false);
  }));
}

test('changing and reverting PNG/model preserves all former PNGs and metadata', () => fixture(({ root, skins, apply }) => {
  apply();
  const first = readFileSync(join(root, 'LocalPlayer.json'));
  apply(37, 'slim');
  const second = readFileSync(join(root, 'LocalPlayer.json'));
  assert.deepEqual(readFileSync(join(skins, 'LocalPlayer.png')), png(37));
  assert.deepEqual(readFileSync(join(root, 'history', `${hash(first)}.json`)), first);
  assert.deepEqual(readFileSync(join(root, 'history', `${hash(png())}.png`)), png());
  apply();
  assert.deepEqual(readFileSync(join(skins, 'LocalPlayer.png')), png());
  assert.deepEqual(readFileSync(join(root, 'LocalPlayer.json')), first);
  assert.deepEqual(readFileSync(join(root, 'history', `${hash(second)}.json`)), second);
  assert.deepEqual(readFileSync(join(root, 'history', `${hash(png(37))}.png`)), png(37));
  assert.equal(readdirSync(join(root, 'textures')).length, 2);
}));

test('nickname changes, including case-only changes on Windows, retain former named PNGs and profiles', () => fixture(({ dir, game, root, skins }) => {
  const store = createLocalProfileStore(dir, () => true);
  store.saveNickname('PlayerOne');
  applyLocalSkin(game, store.saveSkin(png(), 'slim'));
  const previous = readFileSync(join(root, 'PlayerOne.json'));
  applyLocalSkin(game, store.saveNickname('PlayerTwo'));
  applyLocalSkin(game, store.saveNickname('playertwo'));
  for (const name of ['PlayerOne', 'PlayerTwo', 'playertwo']) {
    assert.deepEqual(readFileSync(join(root, `${name}.json`)), previous);
    assert.deepEqual(readFileSync(join(skins, `${name}.png`)), png());
  }
}));

test('invalid names/skin data fail before writes', () => fixture(({ root, game, profile }) => {
  for (const nickname of ['../outside', 'CON', 'nul', 'a']) assert.throws(() => applyLocalSkin(game, profile(0, 'classic', nickname)));
  for (const skin of [{ bytes: [1, 2], model: 'slim' }, { bytes: [...png()], model: 'bad' }, { bytes: [...png(), 256], model: 'classic' }]) {
    assert.throws(() => applyLocalSkin(game, { nickname: 'LocalPlayer', skin }));
  }
  assert.equal(existsSync(root), false);
}));

test('a fresh client without a selected skin still receives local then Mojang config from the immutable template', () => fixture(({ game, root, configPath, templatePath }) => {
  unlinkSync(configPath);
  const template = readFileSync(new URL('../modpack/kubejs/config/kayvel-customskinloader.json', import.meta.url));
  assert.deepEqual(JSON.parse(template), localSkinTemplate);
  writeFileSync(templatePath, template);
  applyLocalSkin(game, { nickname: 'LocalPlayer', skin: null });
  assert.deepEqual(JSON.parse(readFileSync(configPath)), localSkinTemplate);
  assert.deepEqual(readFileSync(templatePath), template);
  assert.deepEqual(readdirSync(join(root, 'textures')), []);
}));

test('CSL rewriting the mutable config does not change the template or cause unnecessary rewrites', () => fixture(({ templatePath, configPath, apply }) => {
  writeFileSync(templatePath, json(localSkinTemplate));
  apply();
  const config = JSON.parse(readFileSync(configPath));
  config.loadlist[1].checkPNG = false;
  config.loadlist[2].apiRoot = 'https://api.mojang.com/';
  config.version = '15.2';
  config.buildNumber = 999;
  const bytes = Buffer.from(JSON.stringify(config, null, 4));
  writeFileSync(configPath, bytes);
  apply(5, 'slim');
  assert.deepEqual(readFileSync(configPath), bytes);
  assert.deepEqual(readFileSync(templatePath), json(localSkinTemplate));
}));

test('v1 migration archives only its known pending ExtraList and leaves all legacy files and personal data intact', () => fixture(({ csl, game, root, configPath, apply }) => {
  const legacy = join(csl, 'KAYVEL-Local-v1');
  mkdirSync(legacy);
  writeFileSync(join(legacy, 'LocalPlayer.json'), 'legacy bytes');
  mkdirSync(join(csl, 'ExtraList'));
  writeFileSync(join(csl, 'ExtraList', 'KAYVEL-Local-v1.json'), json(oldSource));
  writeFileSync(configPath, json({ loadlist: [oldSource, { name: 'GameProfile', type: 'GameProfile' }], enableCape: false }));
  const personal = ['options.txt', 'servers.dat', 'saves/world/level.dat', 'screenshots/shot.png'];
  for (const path of personal) {
    const parts = path.split('/');
    mkdirSync(join(game, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(game, path), path);
  }
  apply();
  assert.deepEqual(JSON.parse(readFileSync(configPath)).loadlist, [...localSkinTemplate.loadlist, oldSource, { name: 'GameProfile', type: 'GameProfile' }]);
  assert.equal(readFileSync(join(legacy, 'LocalPlayer.json'), 'utf8'), 'legacy bytes');
  assert.deepEqual(readdirSync(join(csl, 'ExtraList')), []);
  assert.deepEqual(readFileSync(join(root, 'history', `${hash(json(oldSource))}.json`)), json(oldSource));
  for (const path of personal) assert.equal(readFileSync(join(game, path), 'utf8'), path);
}));

for (const same of [false, true]) {
  test(`existing unowned nickname PNG is ${same ? 'adopted only when identical' : 'preserved on conflict'}`, () => fixture(({ skins, configPath, config, apply }) => {
    mkdirSync(skins, { recursive: true });
    const bytes = png(same ? 0 : 7);
    writeFileSync(join(skins, 'LocalPlayer.png'), bytes);
    if (same) apply();
    else {
      assert.throws(() => apply());
      assert.deepEqual(readFileSync(configPath), config);
    }
    assert.deepEqual(readFileSync(join(skins, 'LocalPlayer.png')), bytes);
  }));
}

for (const conflict of ['malformed-config', 'null-config', 'wrong-registration', 'foreign-root', 'foreign-profile', 'foreign-extra', 'changed-texture', 'changed-history', 'changed-png', 'changed-template']) {
  test(`CSL conflict preserves the conflicting bytes: ${conflict}`, () => fixture(({ csl, root, skins, configPath, templatePath, apply }) => {
    let path;
    let bytes = Buffer.from('foreign user data\n');
    let action = () => apply(37, 'slim');
    if (conflict.endsWith('config')) {
      path = configPath;
      if (conflict === 'null-config') bytes = Buffer.from('null');
    } else if (conflict === 'wrong-registration') {
      path = configPath;
      bytes = json({ loadlist: [{ ...localSkinTemplate.loadlist[0], root: 'Other/' }] });
    } else if (conflict === 'foreign-root') {
      mkdirSync(root);
      path = join(root, 'precious.txt');
    } else {
      apply();
      if (conflict === 'foreign-profile') path = join(root, 'LocalPlayer.json');
      if (conflict === 'foreign-extra') { mkdirSync(join(csl, 'ExtraList')); path = join(csl, 'ExtraList', 'other.json'); }
      if (conflict === 'changed-texture') { path = join(root, 'textures', `${hash(png())}.png`); action = () => apply(); }
      if (conflict === 'changed-history') path = join(root, 'history', `${hash(readFileSync(join(root, 'LocalPlayer.json')))}.json`);
      if (conflict === 'changed-png') path = join(skins, 'LocalPlayer.png');
      if (conflict === 'changed-template') path = templatePath;
    }
    writeFileSync(path, bytes);
    assert.throws(action);
    assert.deepEqual(readFileSync(path), bytes);
  }));
}

for (const location of ['game', 'csl', 'root', 'textures', 'history', 'local', 'skins', 'extra', 'kubejs', 'template-directory']) {
  test(`directory junction at ${location} is rejected without touching target`, () => fixture(({ dir, game, csl, root, skins, apply }) => {
    apply();
    mkdirSync(join(csl, 'ExtraList'));
    const target = join(dir, 'outside');
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'keep');
    const path = { game, csl, root, skins, kubejs: join(game, 'kubejs'), 'template-directory': join(game, 'kubejs', 'config'), local: join(csl, 'LocalSkin'), textures: join(root, 'textures'), history: join(root, 'history'), extra: join(csl, 'ExtraList') }[location];
    rmSync(path, { recursive: true });
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => apply(7, 'slim'));
    assert.deepEqual(readdirSync(target), ['keep.txt']);
    assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'keep');
  }));
}

for (const location of ['config', 'owner', 'profile', 'texture', 'history', 'png', 'template', 'extra']) {
  test(`hardlinked ${location} is rejected and its target preserved`, () => fixture(({ dir, csl, root, skins, configPath, templatePath, apply }) => {
    apply();
    mkdirSync(join(csl, 'ExtraList'));
    const previous = readFileSync(join(root, 'LocalPlayer.json'));
    const path = { config: configPath, owner: join(root, 'owner.txt'), profile: join(root, 'LocalPlayer.json'), png: join(skins, 'LocalPlayer.png'),
      template: templatePath, texture: join(root, 'textures', `${hash(png())}.png`),
      history: join(root, 'history', `${hash(previous)}.json`), extra: join(csl, 'ExtraList', 'KAYVEL-Local-v1.json') }[location];
    const bytes = existsSync(path) ? readFileSync(path) : previous;
    const target = join(dir, 'outside-file');
    writeFileSync(target, bytes);
    if (existsSync(path)) unlinkSync(path);
    linkSync(target, path);
    assert.throws(() => location === 'texture' ? apply() : apply(7, 'slim'));
    assert.deepEqual(readFileSync(target), bytes);
  }));
}

test('only the immutable template is allowed as a managed CSL file, never mutable config or nickname PNGs', () => {
  assert.equal(validManagedPath('kubejs/config/kayvel-customskinloader.json'), true);
  for (const path of ['CustomSkinLoader/CustomSkinLoader.json', 'CustomSkinLoader/LocalSkin/skins/Player.png', 'CustomSkinLoader/ExtraList/KAYVEL.json', 'CustomSkinLoader/owner.txt', 'customskinloader/KAYVEL-Template-v1.json']) assert.equal(validManagedPath(path), false);
});

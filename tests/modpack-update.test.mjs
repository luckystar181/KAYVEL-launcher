import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir, rename, symlink, unlink, writeFile, link } from 'node:fs/promises';
import { join } from 'node:path';
import { updateModpack } from '../dist/main/modpack-update.js';
import { acquireGameDirectoryLock, getInstalledManifest, withInstallationLock } from '../dist/main/installer.js';
import { verifyPreparation, prepareInstance } from '../dist/main/prepare-instance.js';
import { readModSwitches, setModEnabled } from '../dist/main/mod-switches.js';
import { writeNewFile } from '../dist/main/install-files.js';
import { applyGameDefaults } from '../dist/main/game-defaults.js';
import { signedPack, preparedFixture, pinnedUrl, publicKey, mockDownloads, stopped, optionalMod } from './helpers/modpack-fixture.mjs';

const update = (root, pack, report = () => {}, processes = stopped) => updateModpack(root, pack, publicKey, report, processes, pinnedUrl);
const text = (root, path) => readFile(join(root, path), 'utf8');
const absent = async (root, path) => assert.rejects(lstat(join(root, path)), { code: 'ENOENT' });

test('update downloads only differences, backs up managed changes, and preserves every personal file', async t => {
  const old = signedPack('v0.2.0-v3S', { 'mods/keep.jar': 'same', 'mods/change.jar': 'before', 'mods/remove.jar': 'removed', 'kubejs/config/managed.json': 'config' });
  const { root, userData } = await preparedFixture(t, old);
  const personal = ['saves/world/level.dat', 'screenshots/shot.png', 'servers.dat', 'options.txt', 'config/personal.json', 'mods/personal.jar', 'CustomSkinLoader/LocalSkin/skin.png'];
  for (const path of personal) await writeNewFile(root, path, 'personal: ' + path);
  await writeNewFile(userData, 'local-player/profile.json', 'PNG profile');
  await writeNewFile(userData, 'game/mods/previous.jar', 'previous install');
  const receipts = await readFile(join(root, '.preparation/ready.json'));
  const metadata = await readFile(join(root, '.kayvel/signed-manifest.json'));
  const next = signedPack('v0.2.1-v3S', { 'mods/keep.jar': 'same', 'mods/change.jar': 'after', 'mods/add.jar': 'added', 'kubejs/config/managed.json': 'config' });
  const calls = mockDownloads(t, next);
  let processChecks = 0;
  const result = await update(root, next, () => {}, async () => { processChecks++; });
  assert.equal(result.version, 'v0.2.1-v3S');
  assert.equal(processChecks, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(new Set(calls), new Set(next.manifest.files.filter(file => ['mods/change.jar', 'mods/add.jar'].includes(file.path)).map(file => file.url)));
  assert.equal(await text(root, 'mods/change.jar'), 'after');
  assert.equal(await text(root, 'mods/add.jar'), 'added');
  await absent(root, 'mods/remove.jar');
  assert.equal(await readFile(join(result.backup, 'files/0'), 'utf8'), 'before');
  assert.equal(await readFile(join(result.backup, 'files/1'), 'utf8'), 'removed');
  assert.deepEqual(await readFile(join(result.backup, 'signed-manifest.json')), metadata);
  assert.equal(JSON.parse(await readFile(join(result.backup, 'transaction.json'), 'utf8')).to, 'v0.2.1-v3S');
  for (const path of personal) assert.equal(await text(root, path), 'personal: ' + path);
  assert.equal(await text(userData, 'local-player/profile.json'), 'PNG profile');
  assert.equal(await text(userData, 'game/mods/previous.jar'), 'previous install');
  assert.deepEqual(await readFile(join(root, '.preparation/ready.json')), receipts);
  await absent(root, '.kayvel/update-incomplete.json');
  assert.equal((await getInstalledManifest(join(root, '.kayvel'), publicKey)).manifest.buildVersion, result.version);
  await verifyPreparation(root, publicKey);
  await prepareInstance(userData, pinnedUrl, publicKey, () => {}, { ffmpeg: async () => {} });
  assert.equal(calls.length, 2, 'an already updated instance must not download or downgrade to the pin');
});

const removedSkinFiles = {
  'mods/offlineskins-1.21.1-v1a-neoforge.jar': 'offline skin fixture',
  'mods/CustomSkinLoader_Universal-15.1.jar': 'custom skin fixture',
  'kubejs/config/kayvel-customskinloader.json': '{"loadlist":[]}'
};

test('removing client skin mods backs up exactly the managed files without touching personal textures or profiles', async t => {
  const keep = { 'mods/fixture.jar': 'same' };
  const old = signedPack('v0.2.3-v3S', { ...keep, ...removedSkinFiles });
  const { root, userData } = await preparedFixture(t, old);
  const personal = ['CustomSkinLoader/CustomSkinLoader.json', 'CustomSkinLoader/LocalSkin/skins/LocalPlayer.png', 'CustomSkinLoader/KAYVEL-Local-v2/history/old.json', 'OfflineSkins/LocalPlayer.png', 'saves/world/level.dat', 'servers.dat', 'options.txt'];
  for (const path of personal) await writeNewFile(root, path, 'personal: ' + path);
  await writeNewFile(userData, 'local-player/profile.json', 'legacy profile bytes');
  await writeNewFile(userData, 'local-player/skin-copies/old/LocalPlayer.png', 'legacy PNG');
  const next = signedPack('v0.2.4-v3S', keep);
  const calls = mockDownloads(t, next);
  const result = await update(root, next);
  assert.equal(calls.length, 0, 'removal-only delta needs no managed file downloads');
  const transaction = JSON.parse(await readFile(join(result.backup, 'transaction.json'), 'utf8'));
  assert.deepEqual(transaction.changes.map(change => change.path).sort(), Object.keys(removedSkinFiles).sort());
  for (const change of transaction.changes) {
    await absent(root, change.path);
    assert.equal(await readFile(join(result.backup, change.backup), 'utf8'), removedSkinFiles[change.path]);
  }
  for (const path of personal) assert.equal(await text(root, path), 'personal: ' + path);
  assert.equal(await text(userData, 'local-player/profile.json'), 'legacy profile bytes');
  assert.equal(await text(userData, 'local-player/skin-copies/old/LocalPlayer.png'), 'legacy PNG');
  await verifyPreparation(root, publicKey);
  assert.equal((await getInstalledManifest(join(root, '.kayvel'), publicKey)).manifest.buildVersion, 'v0.2.4-v3S');
  await update(root, next);
  assert.equal(calls.length, 0);
});

for (const path of Object.keys(removedSkinFiles)) {
  test(`a modified managed skin file blocks removal and preserves all originals: ${path}`, async t => {
    const keep = { 'mods/fixture.jar': 'same' };
    const old = signedPack('v0.2.3-v3S', { ...keep, ...removedSkinFiles });
    const { root } = await preparedFixture(t, old);
    await writeFile(join(root, path), 'externally modified');
    const next = signedPack('v0.2.4-v3S', keep);
    const calls = mockDownloads(t, next);
    await assert.rejects(update(root, next));
    assert.equal(calls.length, 0);
    for (const [name, bytes] of Object.entries(removedSkinFiles)) assert.equal(await text(root, name), name === path ? 'externally modified' : bytes);
    assert.equal((await getInstalledManifest(join(root, '.kayvel'), publicKey)).manifest.buildVersion, 'v0.2.3-v3S');
    await absent(root, '.kayvel/update-incomplete.json');
  });
}

test('one-time key and server defaults preserve preparation verification and player choices across signed updates', async t => {
  const { root } = await preparedFixture(t);
  const originalOptions = Buffer.from('soundCategory_master:0.4\r\nkey_key.custom:key.keyboard.x\r\n');
  const originalServers = Buffer.from([10, 0, 0, 0]);
  await writeNewFile(root, 'options.txt', originalOptions);
  await writeNewFile(root, 'servers.dat', originalServers);
  await verifyPreparation(root, publicKey);
  const release = await acquireGameDirectoryLock(root);
  try {
    await verifyPreparation(root, publicKey);
    applyGameDefaults(root);
    await verifyPreparation(root, publicKey);
  } finally { await release(); }
  assert.ok((await text(root, 'options.txt')).includes('key_key.sable_player_ragdoll.ragdoll:key.keyboard.x\r\n'));
  assert.ok((await text(root, 'options.txt')).includes('key_key.freecam.toggle:key.keyboard.c\r\n'));
  assert.ok((await text(root, 'servers.dat')).includes('c9.play2go.cloud:20018'));
  const defaults = new Map(await Promise.all((await readdir(join(root, '.kayvel/game-defaults-v1')))
    .map(async name => [name, await readFile(join(root, '.kayvel/game-defaults-v1', name))])));
  assert.ok([...defaults.values()].some(bytes => bytes.equals(originalOptions)));
  assert.ok([...defaults.values()].some(bytes => bytes.equals(originalServers)));
  const playerOptions = 'soundCategory_master:0.8\nkey_key.freecam.toggle:key.keyboard.j\n';
  await writeFile(join(root, 'options.txt'), playerOptions);
  await writeFile(join(root, 'servers.dat'), originalServers);
  const next = signedPack('v0.2.1-v3S', { 'mods/fixture.jar': 'updated fixture never executed' });
  mockDownloads(t, next);
  await update(root, next);
  const releaseNext = await acquireGameDirectoryLock(root);
  try {
    await verifyPreparation(root, publicKey);
    applyGameDefaults(root);
    await verifyPreparation(root, publicKey);
  } finally { await releaseNext(); }
  assert.equal(await text(root, 'options.txt'), playerOptions);
  assert.deepEqual(await readFile(join(root, 'servers.dat')), originalServers);
  assert.deepEqual((await readdir(join(root, '.kayvel/game-defaults-v1'))).sort(), [...defaults.keys()].sort());
  for (const [name, bytes] of defaults) assert.deepEqual(await readFile(join(root, '.kayvel/game-defaults-v1', name)), bytes);
});

test('optional disabled state survives replacement and the new file can be enabled', async t => {
  const { root } = await preparedFixture(t, signedPack('v0.2.0-v3S', { [optionalMod]: 'before' }));
  await setModEnabled(root, publicKey, 'iris', false);
  const next = signedPack('v0.2.1-v3S', { [optionalMod]: 'after' });
  mockDownloads(t, next);
  await update(root, next);
  await absent(root, optionalMod);
  const disabled = '.kayvel/disabled-mods/' + optionalMod.slice(5);
  assert.equal(await text(root, disabled), 'after');
  assert.equal((await readModSwitches(root, publicKey)).find(mod => mod.id === 'iris').state, 'disabled');
  await setModEnabled(root, publicKey, 'iris', true);
  assert.equal(await text(root, optionalMod), 'after');
});

for (const scenario of ['network', 'checksum', 'size', 'local-change', 'conflict', 'case-only', 'running-game', 'concurrent-lock', 'rollback', 'republished-version']) {
  test(`preflight ${scenario} leaves the installed modpack and metadata untouched`, async t => {
    const { root, pack: old } = await preparedFixture(t);
    let next = signedPack('v0.2.1-v3S', { 'mods/fixture.jar': 'replacement', 'mods/new.jar': 'new file' });
    const oldMetadata = await readFile(join(root, '.kayvel/signed-manifest.json'));
    if (scenario === 'local-change') await writeFile(join(root, 'mods/fixture.jar'), 'personal edited contents');
    if (scenario === 'conflict') await writeNewFile(root, 'mods/new.jar', 'personal mod');
    if (scenario === 'case-only') next = signedPack('v0.2.1-v3S', { 'mods/Fixture.jar': 'replacement' });
    if (scenario === 'rollback') next = signedPack('v0.1.9-v3S');
    if (scenario === 'republished-version') next = signedPack('v0.2.0-v3S', { 'mods/fixture.jar': 'different bytes' });
    const before = await readFile(join(root, 'mods/fixture.jar'));
    const calls = mockDownloads(t, next, async () => {
      if (scenario === 'network') throw new Error('fixture network failure');
      if (scenario === 'checksum') return new Response(Buffer.alloc(next.manifest.files[0].size));
      if (scenario === 'size') return new Response('too much content, larger than advertised payload');
    });
    const release = scenario === 'concurrent-lock' ? await acquireGameDirectoryLock(root) : null;
    try {
      await assert.rejects(update(root, next, () => {}, async () => { if (scenario === 'running-game') throw new Error('game is running'); }));
    } finally { await release?.(); }
    assert.deepEqual(await readFile(join(root, 'mods/fixture.jar')), before);
    assert.deepEqual(await readFile(join(root, '.kayvel/signed-manifest.json')), oldMetadata);
    await absent(root, '.kayvel/update-incomplete.json');
    if (!['network', 'checksum', 'size'].includes(scenario)) assert.equal(calls.length, 0);
    if (scenario === 'conflict') assert.equal(await text(root, 'mods/new.jar'), 'personal mod');
    assert.deepEqual(old.bytes, (await getInstalledManifest(join(root, '.kayvel'), publicKey)).bytes);
  });
}

test('unchanged signed version is a no-op and a version-only update needs no payload transfer', async t => {
  const { root, pack } = await preparedFixture(t);
  const next = signedPack('v0.2.1-v3S');
  const calls = mockDownloads(t, next);
  assert.deepEqual(await update(root, pack), { version: 'v0.2.0-v3S', backup: null });
  assert.equal(calls.length, 0);
  const result = await update(root, next);
  assert.equal(result.version, 'v0.2.1-v3S');
  assert.ok(result.backup);
  assert.equal(calls.length, 0);
  await verifyPreparation(root, publicKey);
});

test('a mid-application failure preserves backup and blocks all mutation and launch verification', async t => {
  const { root, userData } = await preparedFixture(t);
  const next = signedPack('v0.2.1-v3S', { 'mods/fixture.jar': 'replacement', 'mods/new.jar': 'new file' });
  mockDownloads(t, next);
  await assert.rejects(update(root, next, progress => {
    if (progress.stage === 'modpack' && progress.file === 'mods/fixture.jar' && progress.total === null) throw new Error('simulated crash after first replacement');
  }), /Обновление прервано/);
  assert.equal(await text(root, 'mods/fixture.jar'), 'replacement');
  const marker = JSON.parse(await text(root, '.kayvel/update-incomplete.json'));
  assert.equal(await text(root, marker.transaction + '/backup/files/0'), 'old fictional mod, never executed');
  for (const action of [() => acquireGameDirectoryLock(root), () => verifyPreparation(root, publicKey),
    () => setModEnabled(root, publicKey, 'iris', false), () => update(root, next), () => prepareInstance(userData, pinnedUrl, publicKey, () => {})]) {
    await assert.rejects(action());
  }
  assert.ok((await readModSwitches(root, publicKey)).every(mod => mod.state === 'unavailable'));
  assert.equal(JSON.parse(await text(root, '.kayvel/update-incomplete.json')).transaction, marker.transaction);
});

for (const kind of ['file', 'directory', 'dangling-link']) {
  test(`any update marker blocks acquisition and readiness: ${kind}`, async t => {
    const { root } = await preparedFixture(t);
    const marker = join(root, '.kayvel/update-incomplete.json');
    if (kind === 'file') await writeFile(marker, 'not even JSON');
    if (kind === 'directory') await mkdir(marker);
    if (kind === 'dangling-link') {
      try { await symlink(join(root, 'absent-target'), marker, 'junction'); }
      catch (error) { if (error.code === 'EPERM') return t.skip('Symlink privilege unavailable'); throw error; }
    }
    await assert.rejects(acquireGameDirectoryLock(root));
    await assert.rejects(verifyPreparation(root, publicKey));
    assert.ok((await readModSwitches(root, publicKey)).every(mod => mod.state === 'unavailable'));
  });
}

test('managed hardlinks and parent junctions are rejected without writing through them', async t => {
  const { root, userData } = await preparedFixture(t);
  const next = signedPack('v0.2.1-v3S');
  const calls = mockDownloads(t, next);
  const alias = join(userData, 'alias.jar');
  await link(join(root, 'mods/fixture.jar'), alias);
  await assert.rejects(update(root, next));
  await unlink(alias);
  await rename(join(root, 'mods'), join(userData, 'outside-mods'));
  await symlink(join(userData, 'outside-mods'), join(root, 'mods'), 'junction');
  await assert.rejects(update(root, next));
  assert.equal(await text(userData, 'outside-mods/fixture.jar'), 'old fictional mod, never executed');
  assert.equal(calls.length, 0);
});

test('updater rechecks processes after downloads and preserves files if a game appeared', async t => {
  const { root } = await preparedFixture(t);
  const next = signedPack('v0.2.1-v3S', { 'mods/fixture.jar': 'after' });
  mockDownloads(t, next);
  let checks = 0;
  await assert.rejects(update(root, next, () => {}, async () => { if (++checks === 2) throw new Error('game appeared'); }), /game appeared/);
  assert.equal(await text(root, 'mods/fixture.jar'), 'old fictional mod, never executed');
  await absent(root, '.kayvel/update-incomplete.json');
});

test('initial install refuses changed immutable manifest after latest discovery', async t => {
  const { userData } = await preparedFixture(t);
  const root = join(userData, 'separate-empty-instance');
  await mkdir(root);
  const next = signedPack('v0.2.1-v3S');
  mockDownloads(t, next);
  await assert.rejects(withInstallationLock(root, install => install(pinnedUrl.replace('v0.2.0-v3S', 'v0.2.1-v3S'), publicKey, () => {}, Buffer.from('different discovery bytes'))), /Выпуск изменился/);
  await absent(root, 'mods');
  await absent(root, '.kayvel/signed-manifest.json');
});

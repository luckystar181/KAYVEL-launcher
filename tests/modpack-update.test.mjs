import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir, rename, symlink, unlink, writeFile, link } from 'node:fs/promises';
import { join } from 'node:path';
import { updateModpack } from '../dist/main/modpack-update.js';
import { acquireGameDirectoryLock, getInstalledManifest, withInstallationLock } from '../dist/main/installer.js';
import { verifyPreparation, prepareInstance } from '../dist/main/prepare-instance.js';
import { readModSwitches, setModEnabled } from '../dist/main/mod-switches.js';
import { writeNewFile } from '../dist/main/install-files.js';
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

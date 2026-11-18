import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { instancePath, prepareInstance, verifyPreparation } from '../dist/main/prepare-instance.js';
import { acquireGameDirectoryLock, withInstallationLock } from '../dist/main/installer.js';
import { writeNewFile } from '../dist/main/install-files.js';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';

const temporary = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : process.cwd();
const url = 'https://github.com/example/kayvel/releases/download/fixture/manifest.json';
const required = ['versions/1.21.1/1.21.1.json', 'versions/1.21.1/1.21.1.jar',
  'versions/neoforge-21.1.252/neoforge-21.1.252.json',
  'libraries/net/neoforged/neoforge/21.1.252/neoforge-21.1.252-client.jar',
  'libraries/net/neoforged/neoforge/21.1.252/neoforge-21.1.252-universal.jar',
  'libraries/net/minecraft/client/1.21.1-20240808.144430/client-1.21.1-20240808.144430-srg.jar',
  'libraries/net/minecraft/client/1.21.1-20240808.144430/client-1.21.1-20240808.144430-extra.jar', '.kayvel-neoforge-ready'];
const payload = Buffer.from('fictional mod, never executed');
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, buildVersion: 'fixture', minecraftVersion: '1.21.1', neoforgeVersion: '21.1.252',
  files: [{ path: 'mods/fixture.jar', size: payload.length, sha256: createHash('sha256').update(payload).digest('hex'), url: url.replace('manifest.json', 'fixture.jar') }] }));
const signature = sign(null, bytes, keys.privateKey).toString('base64');
async function workspace(t) {
  const root = await mkdtemp(join(temporary, 'kayvel-ready-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function dependencies(calls) {
  return {
    java: async () => { calls.push('java'); return 'fictional-java-never-executed'; },
    minecraft: async files => { calls.push('minecraft'); for (const path of required.slice(0, 2)) await files.write(path, path); return {}; },
    neoforge: async files => { calls.push('neoforge'); for (const path of required.slice(2)) await files.write(path, path); },
    modpack: async root => {
      calls.push('modpack');
      await writeNewFile(root, 'mods/fixture.jar', payload);
      await writeNewFile(root, '.kayvel/signed-manifest.json', JSON.stringify({ bytes: bytes.toString('base64'), signature }));
      return 'fixture';
    }
  };
}

test('successful preparation verifies a signed fixture, repeats without downloads and preserves old installations', async t => {
  const userData = await workspace(t);
  for (const path of ['game/mods/old.jar', 'vanilla/saves/world/level.dat', 'runtime/old-java.txt']) await writeNewFile(userData, path, 'keep');
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request'); });
  const calls = [];
  const progress = [];
  const root = await prepareInstance(userData, url, publicKey, value => progress.push(value), dependencies(calls));
  assert.equal(root, instancePath(userData));
  assert.deepEqual(calls, ['java', 'minecraft', 'neoforge', 'modpack']);
  assert.equal(progress.at(-1).stage, 'ready');
  assert.deepEqual(await readdir(join(root, '.preparation')), ['ready.json']);
  const record = await readFile(join(root, '.preparation/ready.json'));
  await verifyPreparation(root, publicKey);
  assert.equal(await prepareInstance(userData, url, publicKey, () => {}, dependencies(calls)), root);
  assert.equal(calls.length, 4);
  assert.deepEqual(await readFile(join(root, '.preparation/ready.json')), record);
  for (const path of ['game/mods/old.jar', 'vanilla/saves/world/level.dat', 'runtime/old-java.txt']) assert.equal(await readFile(join(userData, path), 'utf8'), 'keep');
});

for (const changed of [required[1], 'mods/fixture.jar', '.kayvel/signed-manifest.json']) {
  test(`prepared instance refuses a changed ${changed} without repair or redownload`, async t => {
    const userData = await workspace(t);
    const calls = [];
    const deps = dependencies(calls);
    const root = await prepareInstance(userData, url, publicKey, () => {}, deps);
    const path = join(root, changed);
    await writeFile(path, 'changed');
    t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request'); });
    await assert.rejects(prepareInstance(userData, url, publicKey, () => {}, deps));
    assert.equal(calls.length, 4);
    assert.equal(await readFile(path, 'utf8'), 'changed');
  });
}

for (const change of ['duplicate', 'missing-required', 'unsafe-path', 'schema', 'oversized']) {
  test(`prepared receipts fail closed on ${change}`, async t => {
    const userData = await workspace(t);
    const root = await prepareInstance(userData, url, publicKey, () => {}, dependencies([]));
    const path = join(root, '.preparation/ready.json');
    const record = JSON.parse(await readFile(path, 'utf8'));
    if (change === 'duplicate') record.files.push(record.files[0]);
    if (change === 'missing-required') record.files = record.files.filter(file => file.path !== required[0]);
    if (change === 'unsafe-path') record.files[0].path = '../outside';
    if (change === 'schema') record.schema = 2;
    const contents = change === 'oversized' ? ' '.repeat(5_000_001) : JSON.stringify(record);
    await writeFile(path, contents);
    await assert.rejects(verifyPreparation(root, publicKey));
    assert.equal(await readFile(path, 'utf8'), contents);
  });
}

for (const actionThrows of [false, true]) {
  test(`scoped lock waits for an unawaited install when action ${actionThrows ? 'throws' : 'returns'}`, async t => {
    const root = await workspace(t);
    let requestStarted;
    const started = new Promise(resolve => { requestStarted = resolve; });
    let unblock;
    const response = new Promise(resolve => { unblock = resolve; });
    t.mock.method(globalThis, 'fetch', async () => { requestStarted(); await response; throw new Error('fixture transfer failed'); });
    let settled = false;
    const pending = withInstallationLock(root, async install => {
      void install(url, publicKey);
      assert.throws(() => install(url, publicKey), /уже начата/);
      if (actionThrows) throw new Error('fixture action failed');
    }).finally(() => { settled = true; });
    const rejection = assert.rejects(pending, actionThrows ? /fixture action failed/ : /fixture transfer failed/);
    await started;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    await assert.rejects(acquireGameDirectoryLock(root), /заблокирована/);
    unblock();
    await rejection;
    const release = await acquireGameDirectoryLock(root);
    await release();
  });
}

test('scoped installer handles a fully signed release without nested lock acquisition', async t => {
  const userData = await workspace(t);
  const deps = dependencies([]);
  delete deps.modpack;
  const { installRelease } = await import('../dist/main/installer.js');
  deps.modpack = installRelease;
  const requests = [];
  t.mock.method(globalThis, 'fetch', async requested => {
    requests.push(requested);
    if (requested === url) return new Response(bytes);
    if (requested === url + '.sig') return new Response(signature);
    if (requested === url.replace('manifest.json', 'fixture.jar')) return new Response(payload);
    throw new Error('Unexpected request');
  });
  const root = await prepareInstance(userData, url, publicKey, () => {}, deps);
  await verifyPreparation(root, publicKey);
  await prepareInstance(userData, url, publicKey, () => {}, deps);
  assert.equal(requests.length, 3);
  assert.deepEqual(await readFile(join(root, 'mods/fixture.jar')), payload);
});

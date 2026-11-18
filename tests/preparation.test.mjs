import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PreparationFiles } from '../dist/main/preparation-files.js';
import { artifactDownload, assetDownloads, libraryDownloads } from '../dist/main/prepare-minecraft.js';
import { instancePath, prepareInstance, verifyPreparation } from '../dist/main/prepare-instance.js';
import { acquireGameDirectoryLock, withInstallationLock } from '../dist/main/installer.js';
import { officialDownloadUrl, downloadNewFile } from '../dist/main/official-download.js';
import { safeRelativePath, writeNewFile } from '../dist/main/install-files.js';

const temporary = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : process.cwd();
const digest = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const payload = Buffer.from('fictional official asset');
const url = 'https://libraries.minecraft.net/fixture.jar';
const artifact = { url, size: payload.length, sha1: digest(payload, 'sha1') };
const plan = path => ({ path, url, size: payload.length, hash: digest(payload), algorithm: 'sha256' });
async function workspace(t) {
  const root = await mkdtemp(join(temporary, 'kayvel-preparation-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function mockFetch(t, handler) {
  t.mock.method(globalThis, 'fetch', handler);
}

test('official transport permits only explicit HTTPS hosts without credentials or fragments', () => {
  assert.equal(officialDownloadUrl(url), url);
  for (const value of ['http://libraries.minecraft.net/a', 'https://libraries.minecraft.net.invalid/a',
    'https://user:pass@libraries.minecraft.net/a', 'https://libraries.minecraft.net:444/a', url + '#a',
    'https://github.com/owner/repo/releases/download/v1/a', 'https://maven.minecraftforge.net/a']) {
    assert.throws(() => officialDownloadUrl(value));
  }
});

test('installation paths reject Windows devices, traversal and alternate data streams', () => {
  assert.equal(safeRelativePath('libraries/net/example/a+1.jar'), 'libraries/net/example/a+1.jar');
  for (const path of ['', '../a', '/a', 'a//b', 'a/./b', 'C:/a', 'a\\b', 'mods/a.jar:stream',
    'aux.txt', 'a/COM1.jar', 'a/nul', 'a/b.', 'a/b ', 'a/\u0000']) assert.throws(() => safeRelativePath(path));
});

test('new writes never replace existing files or traverse linked directories', async t => {
  const root = await workspace(t);
  await writeNewFile(root, 'new/a.txt', 'original');
  await assert.rejects(writeNewFile(root, 'new/a.txt', 'replacement'), /EEXIST/);
  assert.equal(await readFile(join(root, 'new/a.txt'), 'utf8'), 'original');
  await mkdir(join(root, 'outside'));
  await symlink(join(root, 'outside'), join(root, 'linked'), 'junction');
  await assert.rejects(writeNewFile(root, 'linked/a.txt', 'no'), /Небезопасный/);
  assert.deepEqual(await readdir(join(root, 'outside')), []);
});

test('Minecraft planning preserves hashes and selects assets by content hash, not their display names', () => {
  assert.deepEqual(artifactDownload('versions/1.21.1/a.jar', artifact), { path: 'versions/1.21.1/a.jar', url, size: payload.length, hash: artifact.sha1, algorithm: 'sha1' });
  const assets = assetDownloads({ objects: { '../display-only': { hash: artifact.sha1, size: payload.length } } });
  assert.equal(assets[0].path, `assets/objects/${artifact.sha1.slice(0, 2)}/${artifact.sha1}`);
  assert.equal(assets[0].url, `https://resources.download.minecraft.net/${artifact.sha1.slice(0, 2)}/${artifact.sha1}`);
  for (const bad of [{ ...artifact, size: -1 }, { ...artifact, sha1: 'x' }, null]) assert.throws(() => artifactDownload('a', bad));
  assert.throws(() => assetDownloads({ objects: { a: { hash: '../', size: 2 } } }));
  assert.throws(() => libraryDownloads([{ name: 'net.fixture:a:1' }]));
});

test('official downloads verify bytes, report progress, and reject occupied paths without network', async t => {
  const root = await workspace(t);
  let requests = 0;
  mockFetch(t, async (_url, options) => {
    requests++;
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    return new Response(payload);
  });
  const progress = [];
  const file = { ...plan(''), path: join(root, 'asset.jar') };
  await downloadNewFile(file, (received, total) => progress.push({ received, total }));
  assert.deepEqual(await readFile(file.path), payload);
  assert.equal(progress.at(-1).received, payload.length);
  await assert.rejects(downloadNewFile(file), /уже занят/);
  assert.equal(requests, 1);
});

test('bad official checksums and blocked redirects preserve partial files without retries', async t => {
  const root = await workspace(t);
  let requests = 0;
  mockFetch(t, async () => { requests++; return new Response(payload); });
  await assert.rejects(downloadNewFile({ ...plan(''), path: join(root, 'bad.jar'), hash: '0'.repeat(64) }), /сумма/);
  assert.deepEqual(await readFile(join(root, 'bad.jar')), payload);
  assert.equal(requests, 1);
  globalThis.fetch = async () => { requests++; return new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid/a' } }); };
  await assert.rejects(downloadNewFile({ ...plan(''), path: join(root, 'redirect.jar') }), /Недоверенный/);
  assert.equal(requests, 2);
});

test('preparation downloads deduplicate matching plans, record SHA-256 and never redownload receipts', async t => {
  const root = await workspace(t);
  let requests = 0;
  mockFetch(t, async () => { requests++; return new Response(payload); });
  const files = new PreparationFiles(root);
  const progress = [];
  const file = plan('libraries/a.jar');
  await files.downloads([file, { ...file }], 'minecraft', value => progress.push(value));
  await files.downloads([file], 'minecraft', () => {});
  assert.equal(requests, 1);
  assert.deepEqual(files.receipts.get('libraries/a.jar'), { path: file.path, size: payload.length, sha256: digest(payload) });
  assert.equal(progress.at(-1).received, payload.length);
  assert.equal(progress.at(-1).completedFiles, 1);
  assert.equal(progress.at(-1).totalFiles, 1);
  await assert.rejects(files.downloads([file, { ...file, hash: '0'.repeat(64) }], 'minecraft', () => {}), /Конфликт/);
  assert.equal(requests, 1);
});

test('failed preparation download identifies its relative file and preserves the network cause', async t => {
  const root = await workspace(t);
  const failure = new TypeError('private signed URL', {
    cause: Object.assign(new Error('private network detail'), { code: 'ENOTFOUND' })
  });
  let calls = 0;
  mockFetch(t, async () => { calls++; throw failure; });
  const files = new PreparationFiles(root);
  await assert.rejects(files.downloads([plan('libraries/fixture.jar')], 'minecraft', () => {}), error => {
    assert.match(error.message, /^Файл libraries\/fixture\.jar:.*libraries\.minecraft\.net.*ENOTFOUND/);
    assert.doesNotMatch(error.message, /private|https:/);
    assert.equal(error.cause.cause, failure);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(files.receipts.size, 0);
});

test('download workers stop scheduling on error and settle all in-flight writes before rejecting', async t => {
  const root = await workspace(t);
  let count = 0;
  let releaseBodies;
  const bodies = new Promise(resolve => { releaseBodies = resolve; });
  let failureSeen;
  const failed = new Promise(resolve => { failureSeen = resolve; });
  mockFetch(t, async () => {
    const current = count++;
    if (current === 0) { failureSeen(); return new Response(null, { status: 500 }); }
    await bodies;
    return new Response(payload);
  });
  const files = new PreparationFiles(root);
  let settled = false;
  const pending = files.downloads(Array.from({ length: 12 }, (_, i) => plan(`libraries/${i}.jar`)), 'minecraft', () => {}).finally(() => { settled = true; });
  const rejection = assert.rejects(pending, /HTTP status 500/);
  await failed;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  releaseBodies();
  await rejection;
  assert.ok(count <= 6);
  assert.ok(files.receipts.size <= 5);
  assert.equal(settled, true);
});

const required = ['versions/1.21.1/1.21.1.json', 'versions/1.21.1/1.21.1.jar',
  'versions/neoforge-21.1.252/neoforge-21.1.252.json',
  'libraries/net/neoforged/neoforge/21.1.252/neoforge-21.1.252-client.jar',
  'libraries/net/neoforged/neoforge/21.1.252/neoforge-21.1.252-universal.jar',
  'libraries/net/minecraft/client/1.21.1-20240808.144430/client-1.21.1-20240808.144430-srg.jar',
  'libraries/net/minecraft/client/1.21.1-20240808.144430/client-1.21.1-20240808.144430-extra.jar', '.kayvel-neoforge-ready'];
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
async function signedModpack(root) {
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, buildVersion: 'fixture', minecraftVersion: '1.21.1', neoforgeVersion: '21.1.252',
    files: [{ path: 'mods/fixture.jar', size: payload.length, sha256: digest(payload), url: 'https://github.com/example/kayvel/releases/download/fixture/fixture.jar' }] }));
  await writeNewFile(root, 'mods/fixture.jar', payload);
  await writeNewFile(root, '.kayvel/signed-manifest.json', JSON.stringify({ bytes: bytes.toString('base64'), signature: sign(null, bytes, keys.privateKey).toString('base64') }));
}
function fakeDependencies(hooks = {}) {
  return {
    java: async files => { await hooks.java?.(files); return 'fictional-java-never-executed'; },
    minecraft: async files => { for (const path of required.slice(0, 2)) await files.write(path, path); return {}; },
    neoforge: async files => { for (const path of required.slice(2)) await files.write(path, path); },
    modpack: async root => { await signedModpack(root); return 'fixture'; },
    ...hooks
  };
}

test('unconfigured release and existing unmanaged instance stop without adopting or changing files', async t => {
  const userData = await workspace(t);
  await assert.rejects(prepareInstance(userData, '', publicKey, () => {}), /не настроен/);
  assert.deepEqual(await readdir(userData), []);
  const root = instancePath(userData);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'keep.txt'), 'original');
  await assert.rejects(prepareInstance(userData, url, publicKey, () => {}), /без записи/);
  assert.deepEqual(await readdir(root), ['keep.txt']);
});

test('preparation holds one lock throughout all stages and retains incomplete state on failure', async t => {
  const userData = await workspace(t);
  const root = instancePath(userData);
  const stages = [];
  const failure = new Error('fixture preparation interrupted');
  const dependencies = fakeDependencies({ java: async () => {
    await assert.rejects(acquireGameDirectoryLock(root), /заблокирована/);
    throw failure;
  } });
  await assert.rejects(prepareInstance(userData, url, publicKey, value => stages.push(value), dependencies), error => error === failure);
  assert.ok(await readFile(join(root, '.preparation/incomplete.json')));
  await assert.rejects(prepareInstance(userData, url, publicKey, () => {}, dependencies), /не завершена/);
  await assert.rejects(verifyPreparation(root, publicKey), /не завершена/);
  assert.equal(stages.at(-1).stage, 'error');
});

test('failed final verification keeps both ready record and incomplete marker', async t => {
  const userData = await workspace(t);
  const dependencies = fakeDependencies({ modpack: async root => { await writeFile(join(root, required[0]), 'changed'); return 'fixture'; } });
  await assert.rejects(prepareInstance(userData, url, publicKey, () => {}, dependencies), /изменён/);
  const root = instancePath(userData);
  assert.ok(await readFile(join(root, '.preparation/ready.json')));
  assert.ok(await readFile(join(root, '.preparation/incomplete.json')));
});

test('scoped installation lock blocks concurrent work and rejects use after release', async t => {
  const root = await workspace(t);
  let retained;
  await withInstallationLock(root, async install => {
    retained = install;
    await assert.rejects(acquireGameDirectoryLock(root), /заблокирована/);
  });
  assert.throws(() => retained(url, publicKey), /освобождена/);
  const release = await acquireGameDirectoryLock(root);
  await release();
});

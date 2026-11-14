import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink, readdir, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyManifest } from '../dist/main/manifest.js';
import { acquireGameDirectoryLock, installRelease } from '../dist/main/installer.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const content = Buffer.from('mock jar contents');
const sha256 = createHash('sha256').update(content).digest('hex');
const url = 'https://github.com/example/kayvel/releases/download/v1/mod.jar';
const manifestUrl = 'https://github.com/example/kayvel/releases/download/v1/manifest.json';
function signed(files = [{ path: 'mods/mod.jar', size: content.length, sha256, url }], buildVersion = 'v1') {
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, buildVersion, minecraftVersion: '1.21.1', neoforgeVersion: '21.1.252', files }));
  return { bytes, signature: sign(null, bytes, privateKey).toString('base64') };
}

test('verifies exact signed bytes and rejects tampering', () => {
  const { bytes, signature } = signed();
  assert.equal(verifyManifest(bytes, signature, publicPem).files.length, 1);
  assert.throws(() => verifyManifest(Buffer.concat([bytes, Buffer.from(' ')]), signature, publicPem), /signature/i);
  assert.throws(() => verifyManifest(bytes, '', publicPem), /signature/i);
});

test('rejects unsafe, duplicate, and mismatched-release paths', () => {
  const file = { path: 'mods/mod.jar', size: content.length, sha256, url };
  for (const files of [[{ ...file, path: '../escape.jar' }], [file, { ...file, path: 'mods/MOD.jar' }], [{ ...file, url: 'http://evil.example/mod.jar' }]]) {
    const { bytes, signature } = signed(files);
    assert.throws(() => verifyManifest(bytes, signature, publicPem));
  }
});

test('accepts common mod filenames but rejects unsafe Windows paths', () => {
  for (const path of ['mods/copycats-3.0.9+mc.1.21.1-neoforge.jar', 'mods/creategoggles-1.21.1-6.1.1-[NEOFORGE].jar']) {
    const { bytes, signature } = signed([{ path, size: content.length, sha256, url }]);
    assert.equal(verifyManifest(bytes, signature, publicPem).files[0].path, path);
  }
  for (const path of ['mods/../escape.jar', 'mods/con.jar', 'mods/mod?.jar', 'mods/mod\\name.jar']) {
    const { bytes, signature } = signed([{ path, size: content.length, sha256, url }]);
    assert.throws(() => verifyManifest(bytes, signature, publicPem));
  }
});

test('accepts flat resource-pack ZIP paths and rejects unsafe variants', () => {
  const file = { path: 'resourcepacks/Create Russified v2.5.zip', size: content.length, sha256, url };
  for (const path of [file.path, 'resourcepacks/Create_Russified-3.5-universal.zip', 'resourcepacks/SodiumTranslations.zip']) {
    const { bytes, signature } = signed([{ ...file, path }]);
    assert.equal(verifyManifest(bytes, signature, publicPem).files[0].path, path);
  }
  for (const path of [
    'resourcepacks/../escape.zip', 'resourcepacks/nested/pack.zip', 'resourcepacks/pack\\name.zip',
    'resourcepacks/con.zip', 'resourcepacks/NUL.txt.zip', 'resourcepacks/CON .name.zip', 'resourcepacks/pack .zip',
    'resourcepacks/pack?.zip', 'resourcepacks/pack.jar', 'mods/pack.zip', 'resourcepacks/pack.zip:stream'
  ]) {
    const { bytes, signature } = signed([{ ...file, path }]);
    assert.throws(() => verifyManifest(bytes, signature, publicPem), undefined, path);
  }
  const { bytes, signature } = signed([file, { ...file, path: 'resourcepacks/CREATE RUSSIFIED V2.5.zip' }]);
  assert.throws(() => verifyManifest(bytes, signature, publicPem), /duplicate/i);
});

test('installs and verifies a signed file but refuses to repair a changed file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kayvel-test-'));
  const root = join(directory, 'game');
  const { bytes, signature } = signed();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (request) => {
    if (request === manifestUrl) return new Response(bytes, { status: 200 });
    if (request === manifestUrl + '.sig') return new Response(signature, { status: 200 });
    if (request === url) return new Response(content, { status: 200 });
    throw new Error('Unexpected download');
  };
  try {
    assert.equal(await installRelease(root, manifestUrl, publicPem), 'v1');
    assert.deepEqual(await readFile(join(root, 'mods', 'mod.jar')), content);
    assert.equal(await installRelease(root, manifestUrl, publicPem), 'v1');
    await writeFile(join(root, 'mods', 'mod.jar'), 'corrupt');
    await assert.rejects(installRelease(root, manifestUrl, publicPem), /восстановление отключено/);
    assert.equal(await readFile(join(root, 'mods', 'mod.jar'), 'utf8'), 'corrupt');
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});

test('installs signed resource packs without changing unrelated packs, settings or worlds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kayvel-test-'));
  const root = join(directory, 'game');
  const pack = Buffer.from('mock resource pack bytes');
  const packUrl = 'https://github.com/example/kayvel/releases/download/v1/pack.zip';
  const packPath = 'resourcepacks/Create Russified v2.5.zip';
  const { bytes, signature } = signed([
    { path: 'mods/mod.jar', size: content.length, sha256, url },
    { path: packPath, size: pack.length, sha256: createHash('sha256').update(pack).digest('hex'), url: packUrl }
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async request => {
    if (request === manifestUrl) return new Response(bytes);
    if (request === manifestUrl + '.sig') return new Response(signature);
    if (request === url) return new Response(content);
    if (request === packUrl) return new Response(pack);
    throw new Error('Unexpected download');
  };
  try {
    await mkdir(join(root, 'resourcepacks'), { recursive: true });
    await mkdir(join(root, 'saves', 'world'), { recursive: true });
    await writeFile(join(root, 'resourcepacks', 'personal.zip'), 'personal pack');
    await writeFile(join(root, 'options.txt'), 'user settings');
    await writeFile(join(root, 'saves', 'world', 'level.dat'), 'user world');
    assert.equal(await installRelease(root, manifestUrl, publicPem), 'v1');
    assert.deepEqual(await readFile(join(root, 'mods', 'mod.jar')), content);
    assert.deepEqual(await readFile(join(root, packPath)), pack);
    assert.equal(await readFile(join(root, 'resourcepacks', 'personal.zip'), 'utf8'), 'personal pack');
    assert.equal(await readFile(join(root, 'options.txt'), 'utf8'), 'user settings');
    assert.equal(await readFile(join(root, 'saves', 'world', 'level.dat'), 'utf8'), 'user world');
    await writeFile(join(root, packPath), 'corrupt');
    await assert.rejects(installRelease(root, manifestUrl, publicPem), /восстановление отключено/);
    assert.equal(await readFile(join(root, packPath), 'utf8'), 'corrupt');
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});

test('rejects a resource pack with an invalid hash before installing staged files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kayvel-test-'));
  const root = join(directory, 'game');
  const pack = Buffer.from('mock resource pack bytes');
  const packUrl = 'https://github.com/example/kayvel/releases/download/v1/pack.zip';
  const { bytes, signature } = signed([
    { path: 'mods/mod.jar', size: content.length, sha256, url },
    { path: 'resourcepacks/pack.zip', size: pack.length, sha256: createHash('sha256').update(pack).digest('hex'), url: packUrl }
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async request => {
    if (request === manifestUrl) return new Response(bytes);
    if (request === manifestUrl + '.sig') return new Response(signature);
    if (request === url) return new Response(content);
    if (request === packUrl) return new Response(Buffer.alloc(pack.length));
    throw new Error('Unexpected download');
  };
  try {
    await assert.rejects(installRelease(root, manifestUrl, publicPem), /SHA-256/);
    assert.deepEqual(await readdir(join(root, 'mods')), []);
    assert.deepEqual(await readdir(join(root, 'resourcepacks')), []);
    assert.equal((await readdir(join(root, '.kayvel'))).includes('signed-manifest.json'), false);
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});

test('refuses an unmanaged resource pack with the same name', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kayvel-test-'));
  const root = join(directory, 'game');
  const path = 'resourcepacks/pack.zip';
  const { bytes, signature } = signed([{ path, size: content.length, sha256, url }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async request => new Response(request === manifestUrl ? bytes : request === manifestUrl + '.sig' ? signature : content);
  try {
    await mkdir(join(root, 'resourcepacks'), { recursive: true });
    await writeFile(join(root, path), 'user pack');
    await assert.rejects(installRelease(root, manifestUrl, publicPem), /unmanaged/i);
    assert.equal(await readFile(join(root, path), 'utf8'), 'user pack');
    await writeFile(join(root, path), content);
    await assert.rejects(installRelease(root, manifestUrl, publicPem), /unmanaged/i);
    assert.deepEqual(await readFile(join(root, path)), content);
    assert.equal((await readdir(join(root, '.kayvel'))).includes('signed-manifest.json'), false);
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});

test('refuses a linked resource-pack directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kayvel-test-'));
  const root = join(directory, 'game');
  const outside = join(directory, 'outside');
  const { bytes, signature } = signed([{ path: 'resourcepacks/pack.zip', size: content.length, sha256, url }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async request => new Response(request === manifestUrl ? bytes : signature);
  try {
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, 'resourcepacks'), 'junction');
    await assert.rejects(installRelease(root, manifestUrl, publicPem), /Unsafe installation directory/);
    assert.deepEqual(await readdir(outside), []);
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});

test('restarts an interrupted download without changing the previous partial file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kayvel-test-'));
  const root = join(directory, 'game');
  const { bytes, signature } = signed();
  const originalFetch = globalThis.fetch;
  let first = true;
  globalThis.fetch = async (request, options) => {
    if (request === manifestUrl) return new Response(bytes);
    if (request === manifestUrl + '.sig') return new Response(signature);
    if (request === url && first) {
      first = false;
      let reads = 0;
      return new Response(new ReadableStream({
        pull(controller) {
          if (reads++ === 0) controller.enqueue(content.subarray(0, 5));
          else controller.error(new Error('Connection lost'));
        }
      }), { status: 200 });
    }
    if (request === url) {
      assert.equal(options?.headers?.Range, undefined);
      return new Response(content);
    }
    throw new Error('Unexpected download');
  };
  try {
    await mkdir(join(root, 'mods'), { recursive: true });
    await writeFile(join(root, 'mods', 'personal.jar'), 'mine');
    await assert.rejects(installRelease(root, manifestUrl, publicPem));
    const staging = join(root, '.kayvel', 'staging');
    const [attempt] = await readdir(staging);
    const [part] = await readdir(join(staging, attempt));
    const oldPartial = join(staging, attempt, part);
    assert.deepEqual(await readFile(oldPartial), content.subarray(0, 5));
    assert.equal(await installRelease(root, manifestUrl, publicPem), 'v1');
    assert.deepEqual(await readFile(oldPartial), content.subarray(0, 5));
    assert.deepEqual(await readFile(join(root, 'mods', 'mod.jar')), content);
    assert.equal(await readFile(join(root, 'mods', 'personal.jar'), 'utf8'), 'mine');
    assert.equal((await readdir(join(root, '.kayvel'))).includes('signed-manifest.json'), true);
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});

test('refuses a linked mods directory without writing outside the game folder', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kayvel-test-'));
  const root = join(directory, 'game');
  const outside = join(directory, 'outside');
  const { bytes, signature } = signed();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async request => new Response(request === manifestUrl ? bytes : signature);
  try {
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, 'mods'), 'junction');
    await assert.rejects(installRelease(root, manifestUrl, publicPem), /Unsafe installation directory/);
    assert.deepEqual(await readdir(outside), []);
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});

test('does not overwrite unmanaged mods or install invalid signatures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kayvel-test-'));
  const root = join(directory, 'game');
  await mkdir(join(root, 'mods'), { recursive: true });
  await writeFile(join(root, 'mods', 'mod.jar'), 'user mod');
  const { bytes, signature } = signed();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async request => new Response(request === manifestUrl ? bytes : request === manifestUrl + '.sig' ? signature : content);
  try {
    await assert.rejects(installRelease(root, manifestUrl, publicPem), /unmanaged/i);
    assert.equal((await readFile(join(root, 'mods', 'mod.jar'))).toString(), 'user mod');
    await writeFile(join(root, 'mods', 'mod.jar'), content);
    await assert.rejects(installRelease(root, manifestUrl, publicPem), /unmanaged/i);
    assert.deepEqual(await readFile(join(root, 'mods', 'mod.jar')), content);
    globalThis.fetch = async request => new Response(request === manifestUrl ? bytes : 'not signed');
    await assert.rejects(installRelease(root, manifestUrl, publicPem), /signature/i);
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});

test('legacy signed records authorize verification only, never repair or update', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kayvel-test-'));
  const root = join(directory, 'game');
  const old = signed();
  let next = old;
  let fileDownloads = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async request => {
    if (request === manifestUrl) return new Response(next.bytes);
    if (request === manifestUrl + '.sig') return new Response(next.signature);
    fileDownloads++;
    throw new Error('A verification must not download files');
  };
  try {
    await mkdir(join(root, '.kayvel'), { recursive: true });
    await mkdir(join(root, 'mods'));
    const record = JSON.stringify({ bytes: old.bytes.toString('base64'), signature: old.signature });
    await writeFile(join(root, '.kayvel', 'signed-manifest.json'), record);
    await writeFile(join(root, 'mods', 'mod.jar'), content);
    await writeFile(join(root, 'mods', 'personal.jar'), 'personal');
    assert.equal(await installRelease(root, manifestUrl, publicPem), 'v1');

    await writeFile(join(root, 'mods', 'mod.jar'), 'changed user data');
    await assert.rejects(installRelease(root, manifestUrl, publicPem), /восстановление отключено/);
    assert.equal(await readFile(join(root, 'mods', 'mod.jar'), 'utf8'), 'changed user data');
    await writeFile(join(root, 'mods', 'mod.jar'), content);

    const file = { path: 'mods/mod.jar', size: content.length, sha256, url };
    for (const candidate of [
      signed([file], 'v2'),
      signed([]),
      signed([file, { ...file, path: 'mods/added.jar' }]),
      signed([{ ...file, path: 'mods/renamed.jar' }]),
      signed([{ ...file, sha256: 'a'.repeat(64) }])
    ]) {
      next = candidate;
      await assert.rejects(installRelease(root, manifestUrl, publicPem), /изменение установленного модпака пока отключено/);
      assert.deepEqual(await readFile(join(root, 'mods', 'mod.jar')), content);
      assert.equal(await readFile(join(root, 'mods', 'personal.jar'), 'utf8'), 'personal');
      assert.equal(await readFile(join(root, '.kayvel', 'signed-manifest.json'), 'utf8'), record);
    }
    assert.equal(fileDownloads, 0);
    next = old;
    await rm(join(root, 'mods'), { recursive: true });
    await assert.rejects(installRelease(root, manifestUrl, publicPem), /Каталог установленного модпака отсутствует/);
    await assert.rejects(readFile(join(root, 'mods', 'mod.jar')), { code: 'ENOENT' });
    assert.equal((await readdir(root)).includes('mods'), false);
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});

test('a damaged installed record fails closed without adopting existing files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kayvel-test-'));
  const root = join(directory, 'game');
  const release = signed();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async request => new Response(request === manifestUrl ? release.bytes : release.signature);
  try {
    await mkdir(join(root, '.kayvel'), { recursive: true });
    await mkdir(join(root, 'mods'));
    await writeFile(join(root, 'mods', 'mod.jar'), 'user file');
    const recordFile = join(root, '.kayvel', 'signed-manifest.json');
    for (const record of ['{', JSON.stringify({ bytes: release.bytes.toString('base64'), signature: 'invalid' })]) {
      await writeFile(recordFile, record);
      await assert.rejects(installRelease(root, manifestUrl, publicPem));
      assert.equal(await readFile(recordFile, 'utf8'), record);
      assert.equal(await readFile(join(root, 'mods', 'mod.jar'), 'utf8'), 'user file');
    }
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});

test('does not reuse or modify old staging files, including hard links', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kayvel-test-'));
  const root = join(directory, 'game');
  const outside = join(directory, 'outside.txt');
  const release = signed();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async request => new Response(request === manifestUrl ? release.bytes : request === manifestUrl + '.sig' ? release.signature : content);
  try {
    const staging = join(root, '.kayvel', 'staging');
    await mkdir(staging, { recursive: true });
    await writeFile(outside, 'user data');
    const oldPart = join(staging, createHash('sha256').update('mods/mod.jar').digest('hex') + '.part');
    await link(outside, oldPart);
    assert.equal(await installRelease(root, manifestUrl, publicPem), 'v1');
    assert.equal(await readFile(outside, 'utf8'), 'user data');
    assert.equal(await readFile(oldPart, 'utf8'), 'user data');
    assert.deepEqual(await readFile(join(root, 'mods', 'mod.jar')), content);
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});

test('a target appearing during installation is not overwritten and the incomplete marker blocks work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kayvel-test-'));
  const root = join(directory, 'game');
  const file = { size: content.length, sha256, url };
  const release = signed([{ ...file, path: 'mods/first.jar' }, { ...file, path: 'mods/second.jar' }]);
  const originalFetch = globalThis.fetch;
  let downloads = 0;
  globalThis.fetch = async request => {
    if (request === manifestUrl) return new Response(release.bytes);
    if (request === manifestUrl + '.sig') return new Response(release.signature);
    if (request === url) {
      if (++downloads === 2) await writeFile(join(root, 'mods', 'second.jar'), 'new user file');
      return new Response(content);
    }
    throw new Error('Unexpected download');
  };
  try {
    await assert.rejects(installRelease(root, manifestUrl, publicPem), /EEXIST|already exists/i);
    assert.deepEqual(await readFile(join(root, 'mods', 'first.jar')), content);
    assert.equal(await readFile(join(root, 'mods', 'second.jar'), 'utf8'), 'new user file');
    assert.ok((await readdir(join(root, '.kayvel'))).includes('install-incomplete.json'));
    assert.equal((await readdir(join(root, '.kayvel'))).includes('signed-manifest.json'), false);
    await assert.rejects(acquireGameDirectoryLock(root), /незавершённая установка/);
    await assert.rejects(installRelease(root, manifestUrl, publicPem), /незавершённая установка/);
    assert.equal(await readFile(join(root, 'mods', 'second.jar'), 'utf8'), 'new user file');
    assert.equal((await readdir(join(root, '.kayvel'))).includes('lock'), false);
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});

test('an incomplete marker of any type blocks acquisition without being removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kayvel-test-'));
  const root = join(directory, 'game');
  const marker = join(root, '.kayvel', 'install-incomplete.json');
  try {
    await mkdir(marker, { recursive: true });
    await assert.rejects(acquireGameDirectoryLock(root), /незавершённая установка/);
    assert.ok((await readdir(join(root, '.kayvel'))).includes('install-incomplete.json'));
    assert.equal((await readdir(join(root, '.kayvel'))).includes('lock'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

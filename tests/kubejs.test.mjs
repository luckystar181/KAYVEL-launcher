import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { verifyManifest } from '../dist/main/manifest.js';
import { installRelease, verifyInstalledRelease } from '../dist/main/installer.js';
import { instancePath, INSTANCE_FOLDER } from '../dist/main/prepare-instance.js';
import { prepareGithubRelease } from '../scripts/prepare-github-release.mjs';

const paths = [
  'kubejs/assets/kubejs/textures/block/example_block.png',
  'kubejs/assets/kubejs/textures/item/example_item.png',
  'kubejs/client_scripts/hide_duplicate_metals.js',
  'kubejs/client_scripts/main.js',
  'kubejs/config/client.json',
  'kubejs/config/common.json',
  'kubejs/config/web_server.json',
  'kubejs/startup_scripts/main.js'
];
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const url = 'https://github.com/example/kayvel/releases/download/test2/manifest.json';
const content = Buffer.from('{"enabled":true,"port":61423,"auth":"fictional-test-value"}\r\n');
const file = path => ({ path, size: content.length, sha256: createHash('sha256').update(content).digest('hex'), url: url.replace('manifest.json', 'fixture.json') });
function signed(files) {
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, buildVersion: 'test2', minecraftVersion: '1.21.1', neoforgeVersion: '21.1.252', files }));
  return { bytes, signature: sign(null, bytes, privateKey).toString('base64') };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'kayvel-kubejs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, root: join(directory, 'game'), outside: join(directory, 'outside') };
}
function downloads(t, release, asset = () => content) {
  const previous = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async request => {
    requests.push(request);
    if (request === url) return new Response(release.bytes);
    if (request === url + '.sig') return new Response(release.signature);
    return new Response(await asset(request));
  };
  t.after(() => { globalThis.fetch = previous; });
  return requests;
}

test('v3S targets a separate instance instead of reusing v1 or v2', () => {
  assert.equal(INSTANCE_FOLDER, 'kayvel-1.21.1-neoforge-21.1.252-v3S');
  assert.equal(instancePath('profile'), join('profile', 'instances', INSTANCE_FOLDER));
});

test('accepts all eight selected KubeJS paths but rejects traversal, devices and other executable paths', () => {
  const release = signed(paths.map(file));
  assert.deepEqual(verifyManifest(release.bytes, release.signature, publicPem).files.map(item => item.path), paths);
  for (const path of [
    'kubejs/../escape.js', 'kubejs/client_scripts/../main.js', 'kubejs/client_scripts/sub/main.js',
    'kubejs/client_scripts/main.js:stream', 'kubejs/client_scripts/main\\test.js',
    'kubejs/client_scripts/con.js', 'kubejs/config/NUL.txt.json', 'kubejs/config/.hidden.json',
    'kubejs/config/main.js', 'kubejs/client_scripts/main.json', 'kubejs/server_scripts/main.js',
    'kubejs/assets/kubejs/textures/block/main.jar', 'kubejs/assets/other/textures/block/main.png',
    'kubejs/config/secret.pem', 'kubejs/config/main .json', 'kubejs/config/main.json.', '/kubejs/config/main.json'
  ]) {
    const invalid = signed([file(path)]);
    assert.throws(() => verifyManifest(invalid.bytes, invalid.signature, publicPem), /managed file/, path);
  }
  const duplicate = signed([file(paths[4]), file('kubejs/config/CLIENT.json')]);
  assert.throws(() => verifyManifest(duplicate.bytes, duplicate.signature, publicPem), /duplicate/i);
});

test('prepares, signs, installs and verifies nested KubeJS bytes without executing or rewriting them', async t => {
  const f = await fixture(t);
  const source = join(f.directory, 'source');
  for (const path of paths) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), content);
  }
  const key = join(f.directory, 'private.pem');
  await writeFile(key, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const prepared = await prepareGithubRelease({ source, repo: 'example/kayvel', tag: 'test2', privateKeyPath: key, output: join(f.directory, 'release'), confirmRights: true });
  const bytes = await readFile(join(prepared.assets, 'manifest.json'));
  const signature = await readFile(join(prepared.assets, 'manifest.json.sig'), 'utf8');
  const manifest = verifyManifest(bytes, signature, publicPem);
  assert.equal(manifest.files.length, 8);
  for (const item of manifest.files) assert.equal(item.url.endsWith(item.path.slice(item.path.lastIndexOf('.'))), true);
  const requests = downloads(t, { bytes, signature }, request => readFile(join(prepared.assets, basename(new URL(request).pathname))));
  await mkdir(join(f.root, 'saves', 'world'), { recursive: true });
  await writeFile(join(f.root, 'saves', 'world', 'level.dat'), 'personal world');
  assert.equal(await installRelease(f.root, url, publicPem), 'test2');
  for (const path of paths) {
    assert.deepEqual(await readFile(join(f.root, path)), content);
    assert.deepEqual(await readFile(join(source, path)), content);
  }
  await verifyInstalledRelease(f.root, publicPem);
  assert.equal(await installRelease(f.root, url, publicPem), 'test2');
  assert.equal(requests.length, 12);
  assert.equal(await readFile(join(f.root, 'saves', 'world', 'level.dat'), 'utf8'), 'personal world');
  await writeFile(join(f.root, paths[6]), 'user change');
  await assert.rejects(verifyInstalledRelease(f.root, publicPem), /восстановление отключено/);
  await assert.rejects(installRelease(f.root, url, publicPem), /восстановление отключено/);
  assert.equal(await readFile(join(f.root, paths[6]), 'utf8'), 'user change');
});

for (const parent of ['kubejs', 'kubejs/assets', 'kubejs/assets/kubejs', 'kubejs/assets/kubejs/textures', 'kubejs/assets/kubejs/textures/block']) {
  test(`rejects a linked KubeJS parent at ${parent} before downloading assets`, async t => {
    const f = await fixture(t);
    const requests = downloads(t, signed([file(paths[0])]));
    await mkdir(dirname(join(f.root, parent)), { recursive: true });
    await mkdir(f.outside);
    await symlink(f.outside, join(f.root, parent), 'junction');
    await assert.rejects(installRelease(f.root, url, publicPem), /Unsafe installation directory/);
    assert.equal(requests.length, 2);
    assert.deepEqual(await readdir(f.outside), []);
  });
}

test('refuses a file occupying a parent and an unmanaged nested target without overwriting either', async t => {
  const f = await fixture(t);
  const requests = downloads(t, signed([file(paths[6])]));
  await mkdir(join(f.root, 'kubejs'), { recursive: true });
  await writeFile(join(f.root, 'kubejs', 'config'), 'personal file');
  await assert.rejects(installRelease(f.root, url, publicPem), /Unsafe installation directory/);
  assert.equal(await readFile(join(f.root, 'kubejs', 'config'), 'utf8'), 'personal file');
  await rename(join(f.root, 'kubejs', 'config'), join(f.root, 'personal-config'));
  await mkdir(join(f.root, 'kubejs', 'config'));
  await writeFile(join(f.root, paths[6]), 'personal configuration');
  await assert.rejects(installRelease(f.root, url, publicPem), /unmanaged/i);
  assert.equal(await readFile(join(f.root, paths[6]), 'utf8'), 'personal configuration');
  assert.equal(requests.length, 4);
});

test('checks nested parents again after downloading and during installed verification', async t => {
  const f = await fixture(t);
  const release = signed([file(paths[6])]);
  downloads(t, release, async () => {
    await rename(join(f.root, 'kubejs', 'config'), join(f.root, 'original-config'));
    await mkdir(f.outside);
    await symlink(f.outside, join(f.root, 'kubejs', 'config'), 'junction');
    return content;
  });
  await assert.rejects(installRelease(f.root, url, publicPem), /Unsafe installation directory/);
  assert.deepEqual(await readdir(f.outside), []);
  await mkdir(join(f.root, '.kayvel'), { recursive: true });
  await writeFile(join(f.root, '.kayvel', 'signed-manifest.json'), JSON.stringify({ bytes: release.bytes.toString('base64'), signature: release.signature }));
  await writeFile(join(f.outside, 'web_server.json'), content);
  await assert.rejects(verifyInstalledRelease(f.root, publicPem), /Unsafe installation directory/);
  assert.deepEqual(await readFile(join(f.outside, 'web_server.json')), content);
});

test('rejects corrupted KubeJS downloads before placing any files', async t => {
  const f = await fixture(t);
  const requests = downloads(t, signed([file(paths[6])]), () => Buffer.alloc(content.length));
  await assert.rejects(installRelease(f.root, url, publicPem), /SHA-256/);
  assert.deepEqual(await readdir(join(f.root, 'kubejs', 'config')), []);
  assert.equal((await readdir(join(f.root, '.kayvel'))).includes('signed-manifest.json'), false);
  assert.equal(requests.length, 3);
});

test('missing installed KubeJS directories are not recreated or downloaded', async t => {
  const f = await fixture(t);
  const requests = downloads(t, signed([file(paths[6])]));
  await installRelease(f.root, url, publicPem);
  await rename(join(f.root, 'kubejs', 'config'), join(f.root, 'preserved-config'));
  await assert.rejects(verifyInstalledRelease(f.root, publicPem), /Каталог установленного модпака отсутствует/);
  await assert.rejects(installRelease(f.root, url, publicPem), /Каталог установленного модпака отсутствует/);
  assert.deepEqual(await readFile(join(f.root, 'preserved-config', 'web_server.json')), content);
  assert.deepEqual(await readdir(join(f.root, 'kubejs')), []);
  assert.equal(requests.length, 5);
});

test('publication rejects nested directory links and unapproved KubeJS trees', async t => {
  const f = await fixture(t);
  const source = join(f.directory, 'source');
  await mkdir(join(source, 'kubejs'), { recursive: true });
  await mkdir(f.outside);
  const key = join(f.directory, 'private.pem');
  await writeFile(key, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const args = { source, repo: 'example/kayvel', tag: 'test2', privateKeyPath: key, output: join(f.directory, 'release'), confirmRights: true };
  await symlink(f.outside, join(source, 'kubejs', 'config'), 'junction');
  await assert.rejects(prepareGithubRelease(args), /regular file/);
  await rm(join(source, 'kubejs', 'config'));
  await mkdir(join(source, 'kubejs', 'server_scripts'));
  await assert.rejects(prepareGithubRelease(args), /regular file/);
  assert.deepEqual(await readdir(f.outside), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { prepareGithubRelease } from '../scripts/prepare-github-release.mjs';
import { installRelease } from '../dist/main/installer.js';
import { verifyManifest } from '../dist/main/manifest.js';

const executeFile = promisify(execFile);
const cli = fileURLToPath(new URL('../scripts/prepare-github-release.mjs', import.meta.url));
const contents = new Map([
  ['mods/mock-mod-1.0.jar', Buffer.from('fictional mod, not a real jar')],
  ['resourcepacks/Mock Resource Pack.zip', Buffer.from('fictional resource pack, not a real zip')]
]);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'kayvel release test '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'selected');
  await mkdir(join(source, 'mods'), { recursive: true });
  await mkdir(join(source, 'resourcepacks'));
  for (const [path, bytes] of contents) await writeFile(join(source, path), bytes);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privateKeyPath = join(root, 'private-key.pem');
  await writeFile(privateKeyPath, privatePem, { flag: 'wx', mode: 0o600 });
  const args = { source, repo: 'example/KAYVEL', tag: 'test-v1.2', privateKeyPath, output: join(root, 'result'), confirmRights: true };
  return { root, source, privateKeyPath, privatePem, publicPem, args };
}

async function absent(path) {
  await assert.rejects(lstat(path), { code: 'ENOENT' });
}

async function prepared(f) {
  const result = await prepareGithubRelease(f.args);
  const bytes = await readFile(join(result.assets, 'manifest.json'));
  const signature = await readFile(join(result.assets, 'manifest.json.sig'), 'utf8');
  const config = await readFile(join(result.output, 'release-config.txt'), 'utf8');
  assert.ok(config.startsWith('// Copy these two lines into src/main/release.ts.\n'));
  const keyMatch = /export const MANIFEST_PUBLIC_KEY_PEM = (.+);/.exec(config);
  assert.ok(keyMatch);
  assert.equal(JSON.parse(keyMatch[1]), f.publicPem);
  assert.match(config, /https:\/\/github\.com\/example\/KAYVEL\/releases\/download\/test-v1\.2\/manifest\.json/);
  const manifest = verifyManifest(bytes, signature, f.publicPem);
  return { ...result, bytes, signature, config, manifest };
}

function mockDownloads(release, mutate = bytes => bytes) {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    requests.push(url);
    if (url === release.manifestUrl) return new Response(release.bytes);
    if (url === release.manifestUrl + '.sig') return new Response(release.signature);
    const file = release.manifest.files.find(item => item.url === url);
    if (!file) throw new Error('Unexpected network request: ' + url);
    return new Response(mutate(await readFile(join(release.assets, basename(new URL(file.url).pathname))), file));
  };
  return { requests, restore: () => { globalThis.fetch = original; } };
}

test('prepares a signed offline release and installs its exact assets without changing other files', async t => {
  const f = await fixture(t);
  const release = await prepared(f);
  assert.equal(release.files, 2);
  assert.equal(release.bytes.length > 0, true);
  assert.deepEqual(release.manifest.files.map(file => file.path), [...contents.keys()]);
  assert.throws(() => verifyManifest(Buffer.concat([release.bytes, Buffer.from(' ')]), release.signature, f.publicPem), /signature/i);
  assert.deepEqual((await readdir(release.assets)).sort(), ['kayvel-0001.jar', 'kayvel-0002.zip', 'manifest.json', 'manifest.json.sig']);
  assert.deepEqual((await readdir(release.output)).sort(), ['assets', 'release-config.txt']);
  for (const file of release.manifest.files) {
    const asset = await readFile(join(release.assets, basename(new URL(file.url).pathname)));
    assert.deepEqual(asset, contents.get(file.path));
    assert.equal(file.size, asset.length);
    assert.equal(file.sha256, createHash('sha256').update(asset).digest('hex'));
    assert.equal(asset.includes(Buffer.from('PRIVATE KEY')), false);
    assert.deepEqual(await readFile(join(f.source, file.path)), contents.get(file.path));
  }
  assert.equal(release.config.includes('PRIVATE KEY'), false);
  assert.deepEqual(await readFile(f.privateKeyPath), Buffer.from(f.privatePem));

  const game = join(f.root, 'game');
  await mkdir(join(game, 'mods'), { recursive: true });
  await mkdir(join(game, 'resourcepacks'));
  await mkdir(join(game, 'saves', 'world'), { recursive: true });
  await writeFile(join(game, 'mods', 'personal.jar'), 'personal mod');
  await writeFile(join(game, 'resourcepacks', 'personal.zip'), 'personal pack');
  await writeFile(join(game, 'options.txt'), 'personal options');
  await writeFile(join(game, 'saves', 'world', 'level.dat'), 'personal world');
  const fake = mockDownloads(release);
  try {
    assert.equal(await installRelease(game, release.manifestUrl, f.publicPem), f.args.tag);
    for (const [path, bytes] of contents) assert.deepEqual(await readFile(join(game, path)), bytes);
    assert.equal(await readFile(join(game, 'mods', 'personal.jar'), 'utf8'), 'personal mod');
    assert.equal(await readFile(join(game, 'resourcepacks', 'personal.zip'), 'utf8'), 'personal pack');
    assert.equal(await readFile(join(game, 'options.txt'), 'utf8'), 'personal options');
    assert.equal(await readFile(join(game, 'saves', 'world', 'level.dat'), 'utf8'), 'personal world');
    assert.equal(await installRelease(game, release.manifestUrl, f.publicPem), f.args.tag);
    assert.equal(fake.requests.filter(url => release.manifest.files.some(file => file.url === url)).length, 2);
  } finally { fake.restore(); }
});

test('refuses a changed downloaded asset before installing any release files', async t => {
  const f = await fixture(t);
  const release = await prepared(f);
  const game = join(f.root, 'game');
  const fake = mockDownloads(release, bytes => Buffer.alloc(bytes.length, 0x78));
  try {
    await assert.rejects(installRelease(game, release.manifestUrl, f.publicPem), /SHA-256/);
    assert.deepEqual(await readdir(join(game, 'mods')), []);
    assert.deepEqual(await readdir(join(game, 'resourcepacks')), []);
    await absent(join(game, '.kayvel', 'signed-manifest.json'));
  } finally { fake.restore(); }
});

test('rejects invalid Git tags and repository names before creating output', async t => {
  const f = await fixture(t);
  for (const tag of ['', 'v1..2', 'v1.', 'v1.lock', '../v1', 'v1/2', 'v@{1', '.v1', 'v'.repeat(65)]) {
    await assert.rejects(prepareGithubRelease({ ...f.args, tag }), /tag/i, tag);
    await absent(f.args.output);
  }
  for (const repo of ['../repo', 'https://github.com/example/KAYVEL', 'example/..', 'example/repo/extra', '-owner/repo']) {
    await assert.rejects(prepareGithubRelease({ ...f.args, repo }), /repository/i, repo);
    await absent(f.args.output);
  }
});

test('requires an explicit rights confirmation and blocks known restricted filenames by default', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareGithubRelease({ ...f.args, confirmRights: false }), /rights/i);
  for (const name of ['RAGDOLL_CORPSE-1.21.1-0.3.0.jar', 'sable_player_ragdoll-1.21.1-0.7.5.jar']) {
    const path = join(f.source, 'mods', name);
    await writeFile(path, 'fictional file');
    await assert.rejects(prepareGithubRelease(f.args), /no-redistribution/i);
    assert.equal(await readFile(path, 'utf8'), 'fictional file');
    await rm(path);
    await absent(f.args.output);
  }
});

test('includes the two restricted filenames only with both explicit confirmations', async t => {
  const f = await fixture(t);
  const names = ['RAGDOLL_CORPSE-1.21.1-0.3.0.jar', 'sable_player_ragdoll-1.21.1-0.7.5.jar'];
  for (const name of names) await writeFile(join(f.source, 'mods', name), `fictional ${name}`);
  await assert.rejects(prepareGithubRelease({ ...f.args, confirmRagdollPermissions: 'true' }), /no-redistribution/i);
  await assert.rejects(prepareGithubRelease({ ...f.args, confirmRights: 'true', confirmRagdollPermissions: true }), /rights/i);
  await assert.rejects(prepareGithubRelease({ ...f.args, confirmRights: false, confirmRagdollPermissions: true }), /rights/i);
  await absent(f.args.output);
  f.args.confirmRagdollPermissions = true;
  const release = await prepared(f);
  assert.equal(release.files, 4);
  for (const name of names) {
    const file = release.manifest.files.find(item => item.path === `mods/${name}`);
    assert.ok(file);
    const asset = await readFile(join(release.assets, basename(new URL(file.url).pathname)));
    assert.deepEqual(asset, Buffer.from(`fictional ${name}`));
    assert.equal(file.sha256, createHash('sha256').update(asset).digest('hex'));
    assert.equal(await readFile(join(f.source, 'mods', name), 'utf8'), `fictional ${name}`);
  }
});

test('rejects unexpected directories, unsafe names, empty files, and linked directories', async t => {
  const f = await fixture(t);
  const extra = join(f.source, 'saves');
  await mkdir(extra);
  await writeFile(join(extra, 'keep.txt'), 'user data');
  await assert.rejects(prepareGithubRelease(f.args), /only mods and resourcepacks/i);
  assert.equal(await readFile(join(extra, 'keep.txt'), 'utf8'), 'user data');
  await rm(extra, { recursive: true });

  const invalid = join(f.source, 'mods', 'name with spaces.jar');
  await writeFile(invalid, 'fictional');
  await assert.rejects(prepareGithubRelease(f.args), /invalid managed file/i);
  await rm(invalid);
  const empty = join(f.source, 'mods', 'empty.jar');
  await writeFile(empty, '');
  await assert.rejects(prepareGithubRelease(f.args), /file size/i);
  await rm(empty);

  const nested = join(f.source, 'mods', 'nested');
  await mkdir(nested);
  await assert.rejects(prepareGithubRelease(f.args), /regular file/i);
  await rm(nested, { recursive: true });
  const linkedSource = join(f.root, 'linked-source');
  await mkdir(linkedSource);
  await symlink(join(f.source, 'mods'), join(linkedSource, 'mods'), 'junction');
  await assert.rejects(prepareGithubRelease({ ...f.args, source: linkedSource }), /real directory/i);
  await absent(f.args.output);
});

test('protects existing output and refuses output inside source or project', async t => {
  const f = await fixture(t);
  await mkdir(f.args.output);
  await writeFile(join(f.args.output, 'keep.txt'), 'do not overwrite');
  await assert.rejects(prepareGithubRelease(f.args), /already exists/i);
  assert.equal(await readFile(join(f.args.output, 'keep.txt'), 'utf8'), 'do not overwrite');
  await assert.rejects(prepareGithubRelease({ ...f.args, output: join(f.source, 'output') }), /outside the source/i);
  await absent(join(f.source, 'output'));
  const projectOutput = join(fileURLToPath(new URL('../', import.meta.url)), 'release-test-' + basename(f.root));
  await assert.rejects(prepareGithubRelease({ ...f.args, output: projectOutput }), /outside the project/i);
  await absent(projectOutput);
});

test('refuses a private key in the project or source and detects a copied or hard-linked key', async t => {
  const f = await fixture(t);
  const projectFile = fileURLToPath(new URL('../package.json', import.meta.url));
  await assert.rejects(prepareGithubRelease({ ...f.args, privateKeyPath: projectFile }), /outside the project/i);
  const selectedKey = join(f.source, 'mods', 'key.jar');
  await writeFile(selectedKey, f.privatePem);
  await assert.rejects(prepareGithubRelease({ ...f.args, privateKeyPath: selectedKey }), /outside the selected source/i);
  await assert.rejects(prepareGithubRelease(f.args), /private key.*copies/i);
  await rm(selectedKey);
  await link(f.privateKeyPath, selectedKey);
  await assert.rejects(prepareGithubRelease(f.args), /hard links/i);
  assert.deepEqual(await readFile(f.privateKeyPath), Buffer.from(f.privatePem));
  await absent(f.args.output);
});

test('CLI prepares only with all required arguments and keeps private material out of output', async t => {
  const f = await fixture(t);
  const args = ['--source', f.source, '--repo', f.args.repo, '--tag', f.args.tag, '--private-key', f.privateKeyPath, '--output', f.args.output];
  await assert.rejects(executeFile(process.execPath, [cli, ...args]), error => /Usage:/.test(error.stderr));
  await absent(f.args.output);
  const { stdout } = await executeFile(process.execPath, [cli, ...args, '--confirm-rights']);
  assert.match(stdout, /No files were uploaded/);
  assert.equal(stdout.includes('PRIVATE KEY'), false);
  const config = await readFile(join(f.args.output, 'release-config.txt'), 'utf8');
  assert.equal(config.includes('PRIVATE KEY'), false);
  assert.equal((await readdir(join(f.args.output, 'assets'))).length, 4);
});

test('CLI requires a separate explicit confirmation for restricted filenames', async t => {
  const f = await fixture(t);
  const names = ['ragdoll_corpse-1.21.1-0.3.0.jar', 'sable_player_ragdoll-1.21.1-0.7.5.jar'];
  for (const name of names) await writeFile(join(f.source, 'mods', name), `fictional ${name}`);
  const args = ['--source', f.source, '--repo', f.args.repo, '--tag', f.args.tag, '--private-key', f.privateKeyPath, '--output', f.args.output];
  await assert.rejects(executeFile(process.execPath, [cli, ...args, '--confirm-rights']), error => /--confirm-ragdoll-permissions/.test(error.stderr));
  await assert.rejects(executeFile(process.execPath, [cli, ...args, '--confirm-ragdoll-permissions']), error => /Usage:/.test(error.stderr));
  await assert.rejects(executeFile(process.execPath, [cli, ...args, '--confirm-rights', '--confirm-ragdoll-permissions', '--confirm-ragdoll-permissions']), error => /Usage:/.test(error.stderr));
  await absent(f.args.output);
  const { stdout } = await executeFile(process.execPath, [cli, ...args, '--confirm-rights', '--confirm-ragdoll-permissions']);
  assert.match(stdout, /No files were uploaded/);
  const bytes = await readFile(join(f.args.output, 'assets', 'manifest.json'));
  const signature = await readFile(join(f.args.output, 'assets', 'manifest.json.sig'), 'utf8');
  const manifest = verifyManifest(bytes, signature, f.publicPem);
  for (const name of names) assert.ok(manifest.files.some(file => file.path === `mods/${name}`));
});

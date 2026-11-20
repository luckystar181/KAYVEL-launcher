import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LAUNCHER_RELEASES, compareLauncherVersions, discoverLauncher, launcherDownloadUrl, stageLauncherUpdate, validateLauncher } from '../dist/main/launcher-update.js';
import { withDownloadSignal } from '../dist/main/download-session.js';
import { prepareLauncherUpdate } from '../scripts/prepare-launcher-update.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const payload = Buffer.from('MZ fictional installer, never executed');
const hash = createHash('sha256').update(payload).digest('hex');
function candidate(change = {}) {
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, version: '0.2.8', platform: 'win32-x64', size: payload.length, sha256: hash,
    url: `${LAUNCHER_RELEASES}/download/v0.2.8-v3S/KAYVEL-Setup-v3S.exe`, ...change }));
  return { bytes, signature: sign(null, bytes, privateKey).toString('base64') };
}
async function workspace(t) {
  const root = await mkdtemp(join(process.env.LOCALAPPDATA, 'Temp', 'opencode', 'kayvel-launcher-update-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('launcher versions compare numerically, stable follows diagnostic, invalid formats fail closed', () => {
  assert.equal(compareLauncherVersions('0.10.0', '0.2.9'), 1);
  assert.equal(compareLauncherVersions('0.2.7', '0.2.7-diagnostic.1'), 1);
  assert.equal(compareLauncherVersions('0.2.7', '0.2.7'), 0);
  for (const version of ['v0.2.7', '01.2.7', '0.2.7-beta', '../0.2.7', '1000000.0.0']) assert.throws(() => compareLauncherVersions(version, '0.2.7'));
});
test('launcher signature binds version, platform, exact installer repository, tag, size and hash', () => {
  const pack = candidate();
  assert.equal(validateLauncher(pack.bytes, pack.signature, pem).manifest.version, '0.2.8');
  assert.throws(() => validateLauncher(Buffer.from(pack.bytes.toString().replace('0.2.8', '0.2.9')), pack.signature, pem), /Подпись/);
  assert.throws(() => validateLauncher(pack.bytes, Buffer.alloc(64).toString('base64'), pem), /Подпись/);
  for (const change of [{ platform: 'linux-x64' }, { version: '0.2.8-beta' }, { size: 0 }, { size: 1.5 }, { sha256: 'x' }, { url: 'https://example.org/a.exe' }, { url: `${LAUNCHER_RELEASES}/download/v0.2.9-v3S/KAYVEL-Setup-v3S.exe` }, { url: `${LAUNCHER_RELEASES.replace('KAYVEL-launcher', 'KAYVEL-mods')}/download/v0.2.8-v3S/KAYVEL-Setup-v3S.exe` }]) {
    const bad = candidate(change);
    assert.throws(() => validateLauncher(bad.bytes, bad.signature, pem));
  }
});
test('launcher discovery gets immutable-tag signature, not moving latest signature', async t => {
  const pack = candidate();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => { calls.push(url); return new Response(url.endsWith('.sig') ? pack.signature : pack.bytes); });
  assert.equal((await discoverLauncher(pem)).manifest.version, '0.2.8');
  assert.deepEqual(calls, [`${LAUNCHER_RELEASES}/latest/download/launcher-update.json`, `${LAUNCHER_RELEASES}/download/v0.2.8-v3S/launcher-update.json.sig`]);
});
test('unpublished launcher metadata is unavailable, never current or an install candidate', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => { calls.push(url); return new Response(null, { status: 404 }); });
  assert.equal(await discoverLauncher(pem), null);
  assert.deepEqual(calls, [`${LAUNCHER_RELEASES}/latest/download/launcher-update.json`]);
});
for (const status of [403, 429, 500]) {
  test(`launcher metadata HTTP ${status} remains an error`, async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response(null, { status }));
    await assert.rejects(discoverLauncher(pem), error => error.status === status);
  });
}
test('missing launcher signature remains an error, not an unpublished channel', async t => {
  const pack = candidate();
  t.mock.method(globalThis, 'fetch', async url => url.endsWith('.sig') ? new Response(null, { status: 404 }) : new Response(pack.bytes));
  await assert.rejects(discoverLauncher(pem), error => error.status === 404);
});
test('CDN 404 and TLS failures are not classified as an unpublished channel', async t => {
  t.mock.method(globalThis, 'fetch', async url => url.includes('github.com') ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/fixture' } }) : new Response(null, { status: 404 }));
  await assert.rejects(discoverLauncher(pem), error => error.status === 404 && error.hostname === 'release-assets.githubusercontent.com');
  t.mock.method(globalThis, 'fetch', async () => { throw Object.assign(new Error('TLS fixture'), { code: 'CERT_HAS_EXPIRED' }); });
  await assert.rejects(discoverLauncher(pem), /CERT_HAS_EXPIRED/);
});
test('launcher transport rejects other repositories, credentials, HTTP and fragments', async t => {
  for (const url of ['http://github.com/luckystar181/KAYVEL-launcher/releases/download/v0.2.8-v3S/a', 'https://github.com/luckystar181/KAYVEL-mods/releases/download/v0.2.8-v3S/a', 'https://evil.invalid/a', LAUNCHER_RELEASES + '/download/v0.2.8-v3S/a#x', 'https://user@release-assets.githubusercontent.com/a']) assert.throws(() => launcherDownloadUrl(url));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://evil.invalid/a' } }); });
  await assert.rejects(discoverLauncher(pem));
  assert.equal(calls, 1);
});
test('staged installer is verified from signed bytes and preserves previous attempts and user data', async t => {
  const root = await workspace(t);
  await writeFile(join(root, 'local-profile.png'), 'keep skin');
  const pack = candidate();
  pack.manifest = { version: '999.0.0' };
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => { urls.push(url); return new Response(payload); });
  const first = await stageLauncherUpdate(root, pack, pem, '0.2.7');
  const second = await stageLauncherUpdate(root, pack, pem, '0.2.7');
  assert.notEqual(first, second);
  assert.deepEqual(await readFile(first), payload);
  assert.deepEqual(await readFile(second), payload);
  assert.equal(await readFile(join(root, 'local-profile.png'), 'utf8'), 'keep skin');
  assert.equal(urls.length, 2);
  await assert.rejects(stageLauncherUpdate(root, pack, pem, '0.2.8'), /запрещены/);
  assert.equal(urls.length, 2);
});
test('bad installer hash, cancellation and partial attempts never become executable update results', async t => {
  const root = await workspace(t);
  const pack = candidate();
  t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.alloc(payload.length)));
  await assert.rejects(stageLauncherUpdate(root, pack, pem, '0.2.7'), /сумма/);
  assert.equal((await readdir(join(root, 'launcher-updates'))).length, 1);
  const controller = new AbortController(); controller.abort(new Error('fixture cancelled'));
  await assert.rejects(withDownloadSignal(controller.signal, () => stageLauncherUpdate(root, pack, pem, '0.2.7')), /cancelled/);
  assert.equal((await readdir(join(root, 'launcher-updates'))).length, 1);
});
test('release metadata signing uses external Ed25519 key, pins installer hash and refuses output overwrite', async t => {
  const root = await workspace(t);
  const installer = join(root, 'KAYVEL-Setup-v3S.exe');
  const privateKeyPath = join(root, 'test-key.pem');
  await writeFile(installer, payload);
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const options = { installer, version: '0.2.8', privateKeyPath, output: join(root, 'metadata'), publicKey: pem };
  await prepareLauncherUpdate(options);
  const bytes = await readFile(join(options.output, 'launcher-update.json'));
  const signature = await readFile(join(options.output, 'launcher-update.json.sig'), 'utf8');
  assert.equal(validateLauncher(bytes, signature, pem).manifest.sha256, hash);
  await assert.rejects(prepareLauncherUpdate(options), /EEXIST/);
  assert.deepEqual(await readFile(join(options.output, 'launcher-update.json')), bytes);
  await assert.rejects(prepareLauncherUpdate({ ...options, output: join(root, 'bad'), version: '0.2.8-beta' }));
});

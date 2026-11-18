import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareModpackVersions, discoverModpack, modpackReleaseUrl, validateModpack } from '../dist/main/modpack-channel.js';
import { signedPack, pinnedUrl, latestUrl, publicKey, mockDownloads } from './helpers/modpack-fixture.mjs';

test('channel compares compatible numeric versions, not lexical values', () => {
  assert.equal(compareModpackVersions('v0.10.0-v3S', 'v0.2.9-v3S'), 1);
  assert.equal(compareModpackVersions('v1.0.0-v3S', 'v0.99.99-v3S'), 1);
  assert.equal(compareModpackVersions('v0.2.1-v3S', 'v0.2.1-v3S'), 0);
  assert.equal(compareModpackVersions('v0.2.0-v3S', 'v0.2.1-v3S'), -1);
  for (const value of ['v01.2.3-v3S', 'v1.2.3', 'v1.2.3-v3s', 'v1.2.3-v3S/..', 'v1.2.3-beta-v3S', 'v1000000.2.3-v3S']) {
    assert.throws(() => compareModpackVersions(value, 'v0.2.0-v3S'));
  }
  assert.equal(modpackReleaseUrl(pinnedUrl, 'v0.2.1-v3S'), pinnedUrl.replace('v0.2.0-v3S', 'v0.2.1-v3S'));
});

test('latest discovery verifies bytes with signature fetched from immutable tag', async t => {
  const pack = signedPack('v0.2.1-v3S');
  const calls = mockDownloads(t, pack);
  const result = await discoverModpack(pinnedUrl, publicKey);
  assert.deepEqual(result.bytes, pack.bytes);
  assert.equal(result.manifest.buildVersion, 'v0.2.1-v3S');
  assert.deepEqual(calls, [latestUrl, pinnedUrl.replace('v0.2.0-v3S', 'v0.2.1-v3S') + '.sig']);
});

for (const scenario of ['signature', 'wrong-repo', 'wrong-tag', 'empty', 'old', 'incompatible', 'query']) {
  test(`discovery rejects ${scenario} without requesting any payload`, async t => {
    const pack = signedPack(scenario === 'old' ? 'v0.1.9-v3S' : 'v0.2.1-v3S', undefined, manifest => {
      if (scenario === 'wrong-repo') manifest.files[0].url = manifest.files[0].url.replace('example/kayvel', 'example/other');
      if (scenario === 'wrong-tag') manifest.files[0].url = manifest.files[0].url.replace('v0.2.1-v3S', 'v0.2.2-v3S');
      if (scenario === 'query') manifest.files[0].url += '?unexpected=1';
      if (scenario === 'empty') manifest.files = [];
      if (scenario === 'incompatible') manifest.minecraftVersion = '1.22';
      return manifest;
    });
    if (scenario === 'signature') pack.signature = Buffer.alloc(64).toString('base64');
    const calls = mockDownloads(t, pack);
    await assert.rejects(discoverModpack(pinnedUrl, publicKey));
    assert.equal(calls.length, 2);
  });
}

for (const target of ['https://github.com/example/other/releases/download/v0.2.1-v3S/manifest.json', 'http://github.com/example/kayvel/releases/download/v0.2.1-v3S/manifest.json', 'https://example.com/manifest.json']) {
  test(`channel refuses untrusted discovery redirect: ${target}`, async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(null, { status: 302, headers: { location: target } }); });
    await assert.rejects(discoverModpack(pinnedUrl, publicKey));
    assert.equal(calls, 1);
  });
}

test('channel preserves download bounds and does not retry network failures', async t => {
  let calls = 0;
  const failure = new Error('fixture network failure');
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw failure; });
  await assert.rejects(discoverModpack(pinnedUrl, publicKey), error => {
    assert.equal(error.cause, failure);
    assert.match(error.message, /github\.com.*NETWORK_ERROR/);
    assert.doesNotMatch(error.message, /fixture network failure/);
    return true;
  });
  assert.equal(calls, 1);
});

test('candidate validation ignores caller-supplied parsed manifest and verifies actual signed bytes', () => {
  const pack = signedPack('v0.2.1-v3S');
  pack.manifest.buildVersion = 'v99.0.0-v3S';
  assert.equal(validateModpack(pack.bytes, pack.signature, publicKey, pinnedUrl).manifest.buildVersion, 'v0.2.1-v3S');
});

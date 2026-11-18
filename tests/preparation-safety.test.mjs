import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMinecraftDownloadAgent, downloadVerified, installVanilla } from '../dist/main/vanilla.js';
import { installNeoForge } from '../dist/main/neoforge.js';
import { gamePreparationUnavailable, PREPARATION_BLOCKED_MESSAGE } from '../dist/main/game-preparation.js';
import { requireAvailableJava21 } from '../dist/main/game-launch-policy.js';

const payload = Buffer.from('fictional Minecraft data');
const hash = bytes => createHash('sha1').update(bytes).digest('hex');
const url = 'https://example.invalid/fictional-resource';

async function fixture(run) {
  const root = await mkdtemp(join(process.env.KAYVEL_TEST_TMPDIR || tmpdir(), 'kayvel-prepare-test-'));
  const originalFetch = globalThis.fetch;
  try { await run(root); }
  finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
}

test('preparation entry points refuse before creating files, fetching, or starting an installer', async () => fixture(async root => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('network must not be used'); };
  assert.deepEqual(gamePreparationUnavailable(), { ok: false, message: PREPARATION_BLOCKED_MESSAGE });
  await assert.rejects(installVanilla(join(root, 'vanilla')), error => error.message === PREPARATION_BLOCKED_MESSAGE);
  await assert.rejects(installNeoForge(join(root, 'game'), join(root, 'cache', 'installer.jar'), 'fictional-java'), error => error.message === PREPARATION_BLOCKED_MESSAGE);
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(root), []);
}));

test('launch entry points do not show a network-isolation confirmation', async () => {
  const source = await readFile(new URL('../dist/main/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /confirmNetworkIsolation|confirmLaunchIsolation|showMessageBox/);
});

test('launch requires already available Java and does not request installation', () => {
  let checked = 0;
  assert.throws(() => requireAvailableJava21('fictional-root', root => { checked++; assert.equal(root, 'fictional-root'); return null; }), /автоматическая загрузка/i);
  assert.equal(checked, 1);
  assert.equal(requireAvailableJava21('fictional-root', () => 'existing-java'), 'existing-java');
});

test('Minecraft transfer agent disables its standard retry handler', async () => {
  const { dispatcher, agent } = createMinecraftDownloadAgent();
  try {
    assert.equal(await agent.retryHandler.retry(new URL(url), 0, new Error('fictional failure')), false);
    assert.equal(await agent.retryHandler.retry(new URL(url), 5, new Error('fictional failure')), false);
  } finally { await dispatcher.close(); }
});

test('verified download uses one request, publishes without overwrite, and reuses a matching file', async () => fixture(async root => {
  const path = join(root, 'assets', 'file');
  let calls = 0;
  globalThis.fetch = async (requested, options) => {
    calls++;
    assert.equal(requested, url);
    assert.equal(options.redirect, 'error');
    return new Response(payload);
  };
  await downloadVerified(url, path, payload.length, hash(payload));
  assert.deepEqual(await readFile(path), payload);
  assert.deepEqual(await readdir(join(root, 'assets')), ['file']);
  await downloadVerified(url, path, payload.length, hash(payload));
  assert.equal(calls, 1);
}));

test('existing different files and directories stop before any network request', async () => fixture(async root => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('network must not be used'); };
  const path = join(root, 'existing');
  await writeFile(path, 'do not replace');
  await assert.rejects(downloadVerified(url, path, payload.length, hash(payload)), /существующий файл/i);
  assert.equal(await readFile(path, 'utf8'), 'do not replace');
  const directory = join(root, 'directory');
  await mkdir(directory);
  await assert.rejects(downloadVerified(url, directory, payload.length, hash(payload)), /существующий файл/i);
  assert.equal(calls, 0);
}));

test('network, interrupted body, and checksum failures are not retried', async () => fixture(async root => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('ambiguous network failure'); };
  await assert.rejects(downloadVerified(url, join(root, 'network'), payload.length, hash(payload)), /ambiguous/);
  assert.equal(calls, 1);
  globalThis.fetch = async () => {
    calls++;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(payload.subarray(0, 2)); controller.error(new Error('interrupted')); } }));
  };
  await assert.rejects(downloadVerified(url, join(root, 'interrupted'), payload.length, hash(payload)), /interrupted/);
  assert.equal(calls, 2);
  globalThis.fetch = async () => { calls++; return new Response(Buffer.alloc(payload.length)); };
  await assert.rejects(downloadVerified(url, join(root, 'checksum'), payload.length, hash(payload)), /контрольная сумма/i);
  assert.equal(calls, 3);
  assert.deepEqual(await readdir(root), []);
}));

test('a destination appearing during download is preserved along with the verified temporary file', async () => fixture(async root => {
  const path = join(root, 'file');
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    await writeFile(path, 'external data', { flag: 'wx' });
    return new Response(payload);
  };
  await assert.rejects(downloadVerified(url, path, payload.length, hash(payload)), /временный файл сохранён/i);
  assert.equal(calls, 1);
  assert.equal(await readFile(path, 'utf8'), 'external data');
  const names = await readdir(root);
  assert.equal(names.length, 2);
  const temporary = names.find(name => name.startsWith('file.') && name.endsWith('.tmp'));
  assert.ok(temporary);
  assert.deepEqual(await readFile(join(root, temporary)), payload);
}));

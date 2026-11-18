import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemorySettingsStore, memoryLaunchOptions, validateMemoryMb } from '../dist/main/memory-settings.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'kayvel-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('memory defaults and limits reserve system RAM and do not write on read', async t => {
  const root = await fixture(t);
  const store = createMemorySettingsStore(root, 16 * 1024 ** 3);
  assert.deepEqual(store.read(), { memoryMb: 6144, minMemoryMb: 2048, maxMemoryMb: 14336, totalMemoryMb: 16384 });
  assert.deepEqual(await readdir(root), []);
  assert.equal(createMemorySettingsStore(root, 4 * 1024 ** 3).read().memoryMb, 2048);
  assert.equal(createMemorySettingsStore(root, 128 * 1024 ** 3).read().maxMemoryMb, 32768);
});

test('memory selection persists across stores and adapts to a smaller computer', async t => {
  const root = await fixture(t);
  const store = createMemorySettingsStore(root, 16 * 1024 ** 3);
  assert.equal(store.save(8192).memoryMb, 8192);
  assert.equal(createMemorySettingsStore(root, 16 * 1024 ** 3).read().memoryMb, 8192);
  const smaller = createMemorySettingsStore(root, 8 * 1024 ** 3);
  assert.equal(smaller.read().memoryMb, 6144);
  assert.equal(JSON.parse(await readFile(join(root, 'game-memory.json'), 'utf8')).memoryMb, 8192);
  assert.equal(store.save(4608).memoryMb, 4608);
  assert.deepEqual(await readdir(root), ['game-memory.json']);
});

test('invalid, fractional, injected and excessive RAM values are rejected without changing the file', async t => {
  const root = await fixture(t);
  const store = createMemorySettingsStore(root, 8 * 1024 ** 3);
  store.save(4096);
  const original = await readFile(join(root, 'game-memory.json'));
  for (const value of [null, undefined, '4096', '--jvm-arg', 0, 1024, -2048, 2048.5, 3000, NaN, Infinity, 8192, 999999]) {
    assert.throws(() => store.save(value), /ОЗУ/);
    assert.deepEqual(await readFile(join(root, 'game-memory.json')), original);
  }
  assert.throws(() => validateMemoryMb(33280), /ОЗУ/);
  assert.deepEqual(memoryLaunchOptions(8192), { minMemory: 1024, maxMemory: 8192 });
});

test('corrupt memory records stop launch settings reads without automatic repair', async t => {
  const root = await fixture(t);
  const store = createMemorySettingsStore(root);
  for (const text of ['{', 'null', '{"version":2,"memoryMb":4096}', '{"version":1,"memoryMb":"4096"}', 'x'.repeat(1025)]) {
    await writeFile(join(root, 'game-memory.json'), text);
    assert.throws(() => store.read());
    assert.equal(await readFile(join(root, 'game-memory.json'), 'utf8'), text);
  }
});

test('memory settings refuse symbolic links without changing their targets', async t => {
  const root = await fixture(t);
  const outside = join(root, 'original.json');
  await writeFile(outside, '{"version":1,"memoryMb":4096}');
  try { await symlink(outside, join(root, 'game-memory.json'), 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('File symlinks require Windows developer mode'); return; } throw error; }
  const store = createMemorySettingsStore(root, 16 * 1024 ** 3);
  assert.throws(() => store.read(), /ссылкой/);
  assert.throws(() => store.save(8192), /ссылкой/);
  assert.equal(await readFile(outside, 'utf8'), '{"version":1,"memoryMb":4096}');
});

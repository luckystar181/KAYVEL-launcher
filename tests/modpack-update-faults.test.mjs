import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { updateModpack } from '../dist/main/modpack-update.js';
import { preparedFixture, signedPack, publicKey, pinnedUrl, mockDownloads } from './helpers/modpack-fixture.mjs';

const update = (root, pack, report = () => {}, processes = async () => {}) => updateModpack(root, pack, publicKey, report, processes, pinnedUrl);
const noMarker = root => assert.rejects(fs.lstat(join(root, '.kayvel/update-incomplete.json')), { code: 'ENOENT' });
const transaction = async root => {
  const path = join(root, '.kayvel/updates');
  const names = await fs.readdir(path);
  assert.equal(names.length, 1);
  return join(path, names[0]);
};

test('insufficient free space refuses update before downloads without filling the disk', async t => {
  const { root } = await preparedFixture(t);
  const next = signedPack('v0.2.1-v3S');
  const calls = mockDownloads(t, next);
  const original = fs.statfs;
  try {
    fs.statfs = async () => ({ bavail: 0, bsize: 4096 });
    syncBuiltinESMExports();
    await assert.rejects(update(root, next), /Недостаточно места/);
  } finally {
    fs.statfs = original;
    syncBuiltinESMExports();
  }
  assert.equal(calls.length, 0);
  await noMarker(root);
  assert.equal(await fs.readFile(join(root, 'mods/fixture.jar'), 'utf8'), 'old fictional mod, never executed');
});

for (const target of ['metadata', 'backup-file', 'backup-metadata', 'staging-file', 'staging-metadata', 'journal']) {
  test(`mutation of ${target} before application refuses changes and retains original managed data`, async t => {
    const { root } = await preparedFixture(t);
    const oldRecord = await fs.readFile(join(root, '.kayvel/signed-manifest.json'));
    const next = signedPack('v0.2.1-v3S', { 'mods/fixture.jar': 'replacement' });
    mockDownloads(t, next);
    let checks = 0;
    await assert.rejects(update(root, next, () => {}, async () => {
      if (++checks !== 2) return;
      const txn = await transaction(root);
      const path = {
        metadata: join(root, '.kayvel/signed-manifest.json'),
        'backup-file': join(txn, 'backup/files/0'),
        'backup-metadata': join(txn, 'backup/signed-manifest.json'),
        'staging-file': join(txn, 'staging/0.part'),
        'staging-metadata': join(txn, 'staging/manifest.json'),
        journal: join(txn, 'backup/transaction.json')
      }[target];
      await fs.writeFile(path, 'fixture external modification');
    }));
    assert.equal(await fs.readFile(join(root, 'mods/fixture.jar'), 'utf8'), 'old fictional mod, never executed');
    if (target !== 'metadata') assert.deepEqual(await fs.readFile(join(root, '.kayvel/signed-manifest.json')), oldRecord);
    await noMarker(root);
  });
}

test('backup damage during application keeps the durable marker instead of declaring success', async t => {
  const { root } = await preparedFixture(t);
  const next = signedPack('v0.2.1-v3S', { 'mods/fixture.jar': 'replacement' });
  mockDownloads(t, next);
  let txn;
  let checks = 0;
  await assert.rejects(update(root, next, progress => {
    if (progress.stage === 'modpack' && progress.file === 'mods/fixture.jar' && progress.total === null) {
      writeFileSync(join(txn, 'backup/files/0'), 'fixture external modification');
    }
  }, async () => { if (++checks === 2) txn = await transaction(root); }), /Обновление прервано/);
  assert.ok((await fs.lstat(join(root, '.kayvel/update-incomplete.json'))).isFile());
  assert.equal(await fs.readFile(join(root, 'mods/fixture.jar'), 'utf8'), 'replacement');
});

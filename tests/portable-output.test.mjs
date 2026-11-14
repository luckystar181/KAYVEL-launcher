import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyPortableRuntime, portableOutputName, reservePortableOutput } from '../scripts/portable-output.mjs';

test('portable output names are optional and cannot escape their directory', () => {
  assert.equal(portableOutputName([]), 'KAYVEL-win32-x64');
  assert.equal(portableOutputName(['--output-name', 'KAYVEL-prepared-20261108']), 'KAYVEL-prepared-20261108');
  for (const name of ['', '.', '..', '../other', 'a/b', 'a\\b', 'C:other', 'name.', 'NUL', 'com1.txt', 'a'.repeat(81)]) {
    assert.throws(() => portableOutputName(['--output-name', name]));
  }
  for (const args of [['--output-name'], ['name'], ['--output-name', 'ok', 'extra']]) {
    assert.throws(() => portableOutputName(args));
  }
});

test('reserves a new output directory without modifying existing builds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kayvel-portable-output-'));
  try {
    const base = join(root, 'portable');
    const original = await reservePortableOutput(base, 'existing');
    await writeFile(join(original, 'keep.txt'), 'original build');
    await assert.rejects(reservePortableOutput(base, 'existing'), /Output already exists/);
    assert.equal(await readFile(join(original, 'keep.txt'), 'utf8'), 'original build');

    const attempts = await Promise.allSettled([
      reservePortableOutput(base, 'new-build'),
      reservePortableOutput(base, 'new-build')
    ]);
    const successful = attempts.filter(result => result.status === 'fulfilled');
    assert.equal(successful.length, 1);
    assert.equal(attempts.filter(result => result.status === 'rejected').length, 1);
    await writeFile(join(original, 'ignore.log'), 'not included');
    await copyPortableRuntime(original, successful[0].value);
    assert.equal(await readFile(join(successful[0].value, 'keep.txt'), 'utf8'), 'original build');
    await assert.rejects(readFile(join(successful[0].value, 'ignore.log')), { code: 'ENOENT' });
    await assert.rejects(copyPortableRuntime(original, successful[0].value), { code: 'ERR_FS_CP_EEXIST' });
    assert.equal(await readFile(join(original, 'keep.txt'), 'utf8'), 'original build');
  } finally { await rm(root, { recursive: true, force: true }); }
});

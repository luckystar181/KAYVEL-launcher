import { test } from 'node:test';
import assert from 'node:assert/strict';
import { link, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sameKnownFile } from '../dist/main/file-identity.js';

test('file identity comparisons retain integers that round to the same JavaScript number', () => {
  const first = { dev: 5n, ino: 9_007_199_254_740_992n };
  const second = { dev: 5n, ino: 9_007_199_254_740_993n };
  assert.equal(Number(first.ino), Number(second.ino));
  assert.equal(sameKnownFile(first, second), false);
  assert.equal(sameKnownFile(first, { ...first }), true);
  assert.equal(sameKnownFile(first, { ...first, dev: 6n }), false);
  assert.equal(sameKnownFile({ dev: 5n, ino: 0n }, { dev: 5n, ino: 0n }), false);
});

test('exact filesystem identities distinguish separate files and detect hard links', async () => {
  const root = await mkdtemp(join(process.env.KAYVEL_TEST_TMPDIR || tmpdir(), 'kayvel-identity-test-'));
  try {
    const first = join(root, 'first');
    const second = join(root, 'second');
    const alias = join(root, 'alias');
    await writeFile(first, 'fictional data');
    await writeFile(second, 'fictional data');
    await link(first, alias);
    const [one, two, linked] = await Promise.all([first, second, alias].map(path => lstat(path, { bigint: true })));
    assert.equal(typeof one.ino, 'bigint');
    assert.equal(sameKnownFile(one, two), false);
    assert.equal(sameKnownFile(one, linked), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

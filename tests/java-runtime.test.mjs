import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installManagedJava21, managedJavaPath, validJava21 } from '../dist/main/java-runtime.js';

test('managed Java path stays in the launcher data directory', () => {
  assert.equal(managedJavaPath('root'), join('root', 'java', 'temurin-21.0.13+9', 'jdk-21.0.13+9-jre', 'bin', 'java.exe'));
  assert.equal(validJava21(join('missing', 'java.exe')), false);
});

test('invalid Java download is rejected and temporary files are removed', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kayvel-java-download-'));
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('invalid archive');
    await assert.rejects(installManagedJava21(root), /Контрольная сумма Java не совпадает/);
    assert.deepEqual(await readdir(join(root, 'java')), []);
  } finally {
    globalThis.fetch = original;
    await rm(root, { recursive: true, force: true });
  }
});

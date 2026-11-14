import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { neoForgeReady, NEOFORGE_PROFILE, NEOFORGE_VERSION } from '../dist/main/neoforge.js';

test('NeoForge readiness requires the version, vanilla jar, patched client, and completion marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kayvel-neo-'));
  try {
    const files = [
      join(root, 'versions', NEOFORGE_PROFILE, `${NEOFORGE_PROFILE}.json`),
      join(root, 'versions', '1.21.1', '1.21.1.jar'),
      join(root, 'libraries', 'net', 'neoforged', 'neoforge', NEOFORGE_VERSION, `${NEOFORGE_PROFILE}-client.jar`),
      join(root, '.kayvel-neoforge-ready')
    ];
    for (const file of files) {
      assert.equal(neoForgeReady(root), false);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, 'test');
    }
    assert.equal(neoForgeReady(root), true);
    await rm(files[2]);
    assert.equal(neoForgeReady(root), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

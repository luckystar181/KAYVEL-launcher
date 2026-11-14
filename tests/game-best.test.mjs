import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGameBestStore } from '../dist/main/game-best.js';

test('mini-game record survives a new process without an account', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kayvel-best-'));
  try {
    const store = createGameBestStore(directory);
    assert.equal(store.read(), 0);
    assert.equal(store.save(7), 7);
    assert.equal(store.save(3), 7);
    assert.throws(() => store.save(-1));
    assert.throws(() => store.save('100'));
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', 'import { createGameBestStore } from "./dist/main/game-best.js"; console.log(createGameBestStore(process.argv[1]).read())', directory], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), '7');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireGameDirectoryLock } from '../dist/main/installer.js';
import { verifyPreparation } from '../dist/main/prepare-instance.js';
import { readModSwitches } from '../dist/main/mod-switches.js';
import { writeNewFile } from '../dist/main/install-files.js';
import { preparedFixture, signedPack, publicKey, pinnedUrl } from './helpers/modpack-fixture.mjs';

for (const phase of ['after-first-unlink', 'after-first-link', 'after-metadata-unlink', 'before-marker-unlink']) {
  test(`forced termination ${phase} retains backup, marker and stale lock; recovery stays blocked`, { timeout: 30000 }, async t => {
    const { root } = await preparedFixture(t);
    await writeNewFile(root, 'saves/fixture/level.dat', 'personal world');
    await writeNewFile(root, 'options.txt', 'personal settings');
    const oldRecord = await readFile(join(root, '.kayvel/signed-manifest.json'));
    const next = signedPack('v0.2.1-v3S', { 'mods/fixture.jar': 'after', 'mods/new.jar': 'new' });
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/modpack-update-crash-child.mjs', import.meta.url))], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', value => { stderr += value; });
    const closed = once(child, 'close');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Fixture pause timed out: ' + stderr)), 15000);
      const onClose = () => finish(new Error('Fixture exited before pause: ' + stderr));
      const onMessage = value => value.type === 'paused' && value.phase === phase ? finish() : finish(new Error(JSON.stringify(value)));
      const onError = error => finish(error);
      function finish(error) {
        clearTimeout(timer);
        child.off('close', onClose);
        child.off('message', onMessage);
        child.off('error', onError);
        if (error) reject(error); else resolve();
      }
      child.once('close', onClose);
      child.once('error', onError);
      child.on('message', onMessage);
      child.send({ root, phase, publicKey, pinnedUrl, bytes: next.bytes.toString('base64'), signature: next.signature,
        payloads: [...next.payloads].map(([url, bytes]) => [url, bytes.toString('base64')]) }, error => { if (error) finish(error); });
    });
    assert.equal(child.kill('SIGKILL'), true);
    const [code] = await closed;
    assert.notEqual(code, 0);
    const markerPath = join(root, '.kayvel/update-incomplete.json');
    const markerBytes = await readFile(markerPath);
    const journal = JSON.parse(markerBytes.toString('utf8'));
    const backup = join(root, journal.transaction, 'backup');
    assert.deepEqual(await readFile(join(backup, 'signed-manifest.json')), oldRecord);
    assert.equal(await readFile(join(backup, 'files/0'), 'utf8'), 'old fictional mod, never executed');
    assert.deepEqual(await readFile(join(backup, 'transaction.json')), markerBytes);
    if (phase === 'after-first-unlink') await assert.rejects(lstat(join(root, 'mods/fixture.jar')), { code: 'ENOENT' });
    else assert.equal(await readFile(join(root, 'mods/fixture.jar'), 'utf8'), 'after');
    if (phase === 'after-first-link') assert.equal((await lstat(join(root, 'mods/fixture.jar'))).nlink, 2);
    const lock = join(root, '.kayvel/lock');
    const owners = await readdir(lock);
    await assert.rejects(acquireGameDirectoryLock(root), /заблокирована/);
    assert.deepEqual(await readdir(lock), owners);
    await assert.rejects(verifyPreparation(root, publicKey));
    assert.ok((await readModSwitches(root, publicKey)).every(mod => mod.state === 'unavailable'));
    await rm(lock, { recursive: true });
    await assert.rejects(acquireGameDirectoryLock(root), /Обновление сборки не завершено/);
    await assert.rejects(lstat(lock), { code: 'ENOENT' });
    assert.deepEqual(await readFile(markerPath), markerBytes);
    assert.equal(await readFile(join(root, 'saves/fixture/level.dat'), 'utf8'), 'personal world');
    assert.equal(await readFile(join(root, 'options.txt'), 'utf8'), 'personal settings');
    assert.equal(await readFile(join(backup, 'files/0'), 'utf8'), 'old fictional mod, never executed');
  });
}

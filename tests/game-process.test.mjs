import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireGameDirectoryLock } from '../dist/main/installer.js';
import { createGameExitReporter, watchLockedGame } from '../dist/main/game-process.js';

test('game exit reports the original game folder exactly once, even after state is cleared', () => {
  for (const folder of ['C:\\KAYVEL\\game', 'C:\\KAYVEL\\vanilla']) {
    let activeGamePath = folder;
    const exits = [];
    const report = createGameExitReporter(activeGamePath, exit => exits.push(exit));
    activeGamePath = null;
    report(3221225786);
    report(0);
    assert.equal(activeGamePath, null);
    assert.deepEqual(exits, [{ code: -1073741510, gamePath: folder }]);
  }
  const exits = [];
  createGameExitReporter('game', exit => exits.push(exit))(null);
  assert.deepEqual(exits, [{ code: null, gamePath: 'game' }]);
});

test('only one concurrent operation can hold the game lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kayvel-lock-'));
  const root = join(directory, 'game');
  try {
    const results = await Promise.allSettled([acquireGameDirectoryLock(root), acquireGameDirectoryLock(root)]);
    const acquired = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');
    assert.equal(acquired.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason.message, /заблокирована/);
    await acquired[0].value();
    await acquired[0].value();
    const release = await acquireGameDirectoryLock(root);
    await release();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('holds the lock for an actual child process and releases it on exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kayvel-lock-'));
  const root = join(directory, 'game');
  let child;
  try {
    const release = await acquireGameDirectoryLock(root);
    child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
    const errors = [];
    const stopped = new Promise(resolve => watchLockedGame(child, release, resolve, error => errors.push(error)));
    await once(child, 'spawn');
    await assert.rejects(acquireGameDirectoryLock(root), /заблокирована/);
    child.stdin.end();
    assert.equal(await stopped, 0);
    assert.deepEqual(errors, []);
    const next = await acquireGameDirectoryLock(root);
    await next();
  } finally {
    child?.kill();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed process spawn releases the lock and reports failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kayvel-lock-'));
  const root = join(directory, 'game');
  try {
    const release = await acquireGameDirectoryLock(root);
    const child = spawn(join(directory, 'missing-executable'), [], { stdio: 'ignore' });
    const errors = [];
    const stopped = new Promise(resolve => watchLockedGame(child, release, resolve, error => errors.push(error)));
    assert.equal(await stopped, -1);
    assert.equal(errors[0].code, 'ENOENT');
    const next = await acquireGameDirectoryLock(root);
    await next();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a process error after spawn does not release the lock before exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kayvel-lock-'));
  const root = join(directory, 'game');
  try {
    const release = await acquireGameDirectoryLock(root);
    const child = new EventEmitter();
    Object.assign(child, { pid: 1234, exitCode: null, signalCode: null });
    const errors = [];
    const stopped = new Promise(resolve => watchLockedGame(child, release, resolve, error => errors.push(error)));
    child.emit('error', new Error('non-exit process error'));
    await assert.rejects(acquireGameDirectoryLock(root), /заблокирована/);
    child.emit('exit', 0);
    assert.equal(await stopped, 0);
    assert.match(errors[0].message, /non-exit/);
    const next = await acquireGameDirectoryLock(root);
    await next();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a lock release error is reported and leaves the lock in place', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kayvel-lock-'));
  const root = join(directory, 'game');
  let release;
  try {
    release = await acquireGameDirectoryLock(root);
    const child = new EventEmitter();
    Object.assign(child, { pid: 1234, exitCode: null, signalCode: null });
    const errors = [];
    const stopped = new Promise(resolve => watchLockedGame(child, async () => { throw new Error('release failed'); }, resolve, error => errors.push(error)));
    child.emit('exit', 0);
    assert.equal(await stopped, 0);
    assert.match(errors[0].message, /release failed/);
    await assert.rejects(acquireGameDirectoryLock(root), /заблокирована/);
  } finally {
    if (release) await release();
    await rm(directory, { recursive: true, force: true });
  }
});

test('closing a lock-owning process leaves the lock while its child can still run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kayvel-lock-'));
  const root = join(directory, 'game');
  let pid;
  try {
    const moduleUrl = new URL('../dist/main/installer.js', import.meta.url).href;
    const script = `
      import { spawn } from 'node:child_process';
      import { acquireGameDirectoryLock } from ${JSON.stringify(moduleUrl)};
      import { watchLockedGame } from ${JSON.stringify(new URL('../dist/main/game-process.js', import.meta.url).href)};
      const release = await acquireGameDirectoryLock(${JSON.stringify(root)});
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' });
      watchLockedGame(child, release, () => {}, () => {});
      child.unref();
      console.log(child.pid);
    `;
    const launcher = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    launcher.stdout.on('data', chunk => { output += chunk; });
    launcher.stderr.on('data', chunk => { errors += chunk; });
    const [code] = await once(launcher, 'close');
    assert.equal(code, 0, errors);
    pid = Number(output.trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    process.kill(pid, 0);
    await assert.rejects(acquireGameDirectoryLock(root), /заблокирована/);
  } finally {
    if (pid) { try { process.kill(pid); } catch {} }
    await rm(directory, { recursive: true, force: true });
  }
});

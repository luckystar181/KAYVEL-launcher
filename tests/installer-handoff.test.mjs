import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { openUpdateInstaller } from '../dist/main/installer-handoff.js';

const ready = 'KAYVEL_SETUP_READY_V1\n';
const ack = 'KAYVEL_SETUP_QUIT_V1\n';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture({ canQuit = async () => {}, writeError = false } = {}) {
  const child = new EventEmitter();
  const events = [];
  const errors = [];
  let writes = '';
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    writes += chunk.toString(); events.push('ack'); done(writeError ? new Error('fixture write failure') : undefined);
  } });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const promise = openUpdateInstaller('C:\\fictional folder\\verified.exe', {
    canQuit: async () => { events.push('check'); await canQuit(); },
    quit: () => events.push('quit'), ended: error => errors.push(error)
  }, (path, args, options) => {
    assert.equal(path, 'C:\\fictional folder\\verified.exe');
    assert.deepEqual(args, ['--kayvel-update', `--parent-pid=${process.pid}`]);
    assert.deepEqual(options, { shell: false, detached: true, windowsHide: false, stdio: ['pipe', 'pipe', 'pipe'] });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  await promise;
  return { child, events, errors, writes: () => writes };
}

test('private installer handoff accepts split READY and writes ACK only after safety checks, before quit', async () => {
  const check = deferred();
  const f = await fixture({ canQuit: () => check.promise });
  f.child.stdout.write(ready.slice(0, 7));
  await tick();
  assert.deepEqual(f.events, []);
  f.child.stdout.write(ready.slice(7));
  await tick();
  assert.deepEqual(f.events, ['check']);
  assert.equal(f.writes(), '');
  check.resolve();
  await tick();
  assert.deepEqual(f.events, ['check', 'ack', 'quit']);
  assert.equal(f.writes(), ack);
  f.child.emit('exit', 0);
  f.child.stdout.write(ready);
  f.child.stdout.end();
  f.child.stdout.emit('error', new Error('late error'));
  await tick();
  assert.equal(f.events.filter(x => x === 'quit').length, 1);
  assert.equal(f.errors.length, 0);
});

for (const response of ['wrong\n', 'x'.repeat(65), ready + ready, 'bad\r\n', '\u0080\n', ready + 'extra']) {
  test(`installer handoff rejects invalid or overlong response ${JSON.stringify(response)}`, async () => {
    const f = await fixture();
    f.child.stdout.write(Buffer.from(response));
    await tick();
    assert.equal(f.errors.length, 1);
    assert.deepEqual(f.events, []);
    assert.equal(f.writes(), '');
    assert.equal(f.child.stdin.destroyed, true);
    f.child.emit('exit', 1);
    assert.equal(f.errors.length, 1);
  });
}

for (const point of ['exit', 'error', 'stdin', 'stdout', 'stderr', 'end', 'repeat']) {
  test(`installer channel failure during checks prevents quit: ${point}`, async () => {
    const check = deferred();
    const f = await fixture({ canQuit: () => check.promise });
    f.child.stdout.write(ready);
    await tick();
    if (point === 'exit') f.child.emit('exit', 1);
    else if (point === 'error') f.child.emit('error', new Error('fixture error'));
    else if (point === 'end') f.child.stdout.end();
    else if (point === 'repeat') f.child.stdout.write(ready);
    else f.child[point].emit('error', new Error('fixture stream error'));
    await tick();
    check.resolve();
    await tick();
    assert.equal(f.errors.length, 1);
    assert.deepEqual(f.events, ['check']);
    assert.equal(f.writes(), '');
  });
}

test('rejected safety check and ACK write failure preserve old launcher', async () => {
  for (const options of [{ canQuit: async () => { throw new Error('busy'); } }, { writeError: true }]) {
    const f = await fixture(options);
    f.child.stdout.write(ready);
    await tick();
    assert.equal(f.errors.length, 1);
    assert.equal(f.events.includes('quit'), false);
  }
});

test('a safety check that finishes after the confirmation deadline cannot quit the launcher', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const check = deferred();
  const f = await fixture({ canQuit: () => check.promise });
  f.child.stdout.write(ready);
  await tick();
  t.mock.timers.tick(10_000);
  check.resolve();
  await tick();
  assert.equal(f.errors.length, 1);
  assert.equal(f.writes(), '');
  assert.deepEqual(f.events, ['check']);
});

test('synchronous and asynchronous spawn failures reject without closing the launcher', async () => {
  let called = false;
  const callbacks = { canQuit: async () => { called = true; }, quit: () => { called = true; }, ended: () => { called = true; } };
  await assert.rejects(openUpdateInstaller('missing.exe', callbacks, () => { throw new Error('fixture spawn'); }), /spawn/);
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  await assert.rejects(openUpdateInstaller('missing.exe', callbacks, () => {
    queueMicrotask(() => child.emit('error', new Error('missing')));
    return child;
  }), /установщик/);
  assert.equal(called, false);
});

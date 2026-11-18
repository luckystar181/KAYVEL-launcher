import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../src/renderer/launcher-status.ts', import.meta.url), 'utf8');
const exports = {};
runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports });
const { watchLauncherStatus } = exports;
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(status) {
  const callbacks = { statuses: [], progressValues: [], exits: [], errors: 0 };
  let interval, focus, onProgress, onExit;
  let cleaned = 0;
  const stop = watchLauncherStatus({
    status,
    onPreparationProgress: fn => { onProgress = fn; return () => { cleaned++; }; },
    onGameExit: fn => { onExit = fn; return () => { cleaned++; }; }
  }, {
    status: value => callbacks.statuses.push(value), progress: value => callbacks.progressValues.push(value),
    exit: value => callbacks.exits.push(value), error: () => { callbacks.errors++; }
  }, {
    setInterval: (fn, ms) => { assert.equal(ms, 1000); interval = fn; return 123; },
    clearInterval: id => { assert.equal(id, 123); cleaned++; },
    addEventListener: (name, fn) => { assert.equal(name, 'focus'); focus = fn; },
    removeEventListener: (name, fn) => { assert.equal(name, 'focus'); assert.equal(fn, focus); cleaned++; }
  });
  return { callbacks, stop, interval: () => interval(), focus: () => focus(), progress: value => onProgress(value), exit: value => onExit(value), cleaned: () => cleaned };
}

test('status polling follows preparation, running and exit even if an exit notification is lost', async () => {
  let value = { gameRunning: false, preparationProgress: { stage: 'launch' } };
  const f = fixture(async () => value);
  await tick();
  assert.equal(f.callbacks.progressValues.at(-1).stage, 'launch');
  value = { gameRunning: true, preparationProgress: null };
  f.interval();
  await tick();
  assert.equal(f.callbacks.statuses.at(-1).gameRunning, true);
  assert.equal(f.callbacks.progressValues.at(-1), null);
  value = { gameRunning: false, preparationProgress: null };
  f.focus();
  await tick();
  assert.equal(f.callbacks.statuses.at(-1).gameRunning, false);
  assert.equal(f.callbacks.progressValues.at(-1), null);
  f.stop();
  assert.equal(f.cleaned(), 4);
});

test('a stale in-flight status cannot restore launch progress after exit or a newer progress event', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  f.progress({ stage: 'launch' });
  f.exit({ code: 0, gamePath: 'fixture' });
  resolve({ gameRunning: true, preparationProgress: { stage: 'launch' } });
  await tick();
  assert.equal(f.callbacks.statuses.length, 0);
  assert.equal(f.callbacks.progressValues.at(-1), null);
  assert.equal(f.callbacks.exits.length, 1);
  f.interval();
  resolve({ gameRunning: false, preparationProgress: null });
  await tick();
  assert.equal(f.callbacks.statuses.at(-1).gameRunning, false);
  f.stop();
});

test('polling does not overlap requests and ignores late results after disposal', async () => {
  let resolve, calls = 0;
  const f = fixture(() => { calls++; return new Promise(done => { resolve = done; }); });
  f.interval(); f.focus();
  assert.equal(calls, 1);
  f.stop();
  resolve({ gameRunning: true, preparationProgress: null });
  await tick();
  assert.equal(f.callbacks.statuses.length, 0);
});

test('polling recovers from IPC failures without starting or retrying a game launch', async () => {
  let fail = true;
  const f = fixture(async () => {
    if (fail) throw new Error('fixture');
    return { gameRunning: false, preparationProgress: null };
  });
  await tick();
  assert.equal(f.callbacks.errors, 1);
  fail = false;
  f.interval();
  await tick();
  assert.equal(f.callbacks.statuses.length, 1);
  f.stop();
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { acquireGameDirectoryLock } from '../dist/main/game-directory-lock.js';
import { assertNoGameProcesses, processMayBeAlive } from '../dist/main/lock-processes.js';

const require = createRequire(import.meta.url);
const source = await fs.readFile(new URL('../dist/main/game-directory-lock.js', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });

function isolatedLock({ snapshot = async () => {}, alive = processMayBeAlive, files = fs } = {}) {
  const exports = {};
  runInNewContext(outputText, { exports, process, Error, require(name) {
    if (name === './lock-processes.js') return { assertRecoveryProcessesStopped: snapshot, processMayBeAlive: alive };
    if (name === 'node:fs/promises') return files;
    return require(name);
  } });
  return exports.acquireGameDirectoryLock;
}

async function fixture(action) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'kayvel-lock-recovery-'));
  const root = join(directory, 'game');
  const meta = join(root, '.kayvel');
  const lock = join(meta, 'lock');
  await fs.mkdir(lock, { recursive: true });
  await fs.mkdir(join(root, 'saves', 'world'), { recursive: true });
  await fs.writeFile(join(root, 'saves', 'world', 'level.dat'), 'unchanged world');
  await fs.writeFile(join(root, 'options.txt'), 'unchanged settings');
  try {
    await action({ root, meta, lock, directory });
    assert.equal(await fs.readFile(join(root, 'saves', 'world', 'level.dat'), 'utf8'), 'unchanged world');
    assert.equal(await fs.readFile(join(root, 'options.txt'), 'utf8'), 'unchanged settings');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

async function owner(lock, pid = 12345, childPid) {
  const id = randomUUID();
  const name = `owner-${id}.json`;
  const value = { schema: 1, id, pid };
  await fs.writeFile(join(lock, name), JSON.stringify(value));
  if (childPid) await fs.writeFile(join(lock, `child-${id}-${childPid}.json`), JSON.stringify({ ...value, pid: childPid }));
  return name;
}

const self = { pid: 10, parentPid: 1, name: 'KAYVEL.exe' };
for (const name of ['java.exe', 'javaw.exe', 'KAYVEL.exe', 'KAYVEL-Setup-v3S.exe', 'electron.exe']) {
  test(`process snapshot refuses recovery while ${name} is present`, () => {
    assert.throws(() => assertNoGameProcesses([self, { pid: 20, parentPid: 1, name }], 10), /заблокирована/);
  });
}

test('own Electron renderers and unrelated Node processes do not block recovery, but own Java does', () => {
  const renderer = { pid: 11, parentPid: 10, name: 'KAYVEL.exe' };
  assertNoGameProcesses([self, renderer, { pid: 12, parentPid: 11, name: 'KAYVEL.exe' }, { pid: 20, parentPid: 1, name: 'node.exe' }], 10);
  assert.throws(() => assertNoGameProcesses([self, { pid: 20, parentPid: 10, name: 'java.exe' }], 10), /заблокирована/);
});

test('unavailable or malformed process snapshots cannot authorize recovery', () => {
  for (const entries of [null, {}, [], [null], [{ ...self, pid: 11 }], [self, { ...self }],
    [self, { pid: 20, parentPid: -1, name: 'node.exe' }],
    ...[null, 12, {}, ['java.exe'], '  '].map(name => [self, { pid: 20, parentPid: 1, name }])]) {
    assert.throws(() => assertNoGameProcesses(entries, 10), /проверить/);
  }
});

test('dead owner and dead registered child are recovered without changing the game', async () => {
  await fixture(async ({ root, lock }) => {
    await owner(lock, 12345, 12346);
    let scans = 0;
    const acquire = isolatedLock({ alive: pid => pid === process.pid, snapshot: async () => { scans++; } });
    const release = await acquire(root);
    assert.equal(scans, 1);
    const names = await fs.readdir(lock);
    assert.equal(names.length, 1);
    assert.equal(JSON.parse(await fs.readFile(join(lock, names[0]), 'utf8')).pid, process.pid);
    await Promise.all([release(), release()]);
    await assert.rejects(fs.lstat(lock), { code: 'ENOENT' });
    const next = await acquire(root);
    await release();
    await assert.rejects(acquire(root), /заблокирована/);
    await next();
  });
});

test('a live owner or orphan child prevents recovery before the system scan', async () => {
  for (const child of [undefined, process.pid]) {
    await fixture(async ({ root, lock }) => {
      await owner(lock, child ? 12345 : process.pid, child);
      const before = await fs.readdir(lock);
      const acquire = isolatedLock({ alive: pid => pid === process.pid, snapshot: async () => assert.fail('Live processes must be checked first') });
      await assert.rejects(acquire(root), /заблокирована/);
      assert.deepEqual(await fs.readdir(lock), before);
    });
  }
});

test('an empty legacy lock is recovered only after a successful process scan', async () => {
  await fixture(async ({ root, lock }) => {
    const failed = isolatedLock({ snapshot: async () => { throw new Error('CIM unavailable'); } });
    await assert.rejects(failed(root), /заблокирована/);
    assert.deepEqual(await fs.readdir(lock), []);
    let scans = 0;
    const release = await isolatedLock({ snapshot: async () => { scans++; } })(root);
    assert.equal(scans, 1);
    await release();
  });
});

for (const marker of ['install', 'preparation']) {
  test(`an unfinished ${marker} keeps a dead owner's lock and all records`, async () => {
    await fixture(async ({ root, lock, meta }) => {
      const name = await owner(lock);
      const markerPath = marker === 'install' ? join(meta, 'install-incomplete.json') : join(root, '.preparation', 'incomplete.json');
      await fs.mkdir(join(markerPath, '..'), { recursive: true });
      await fs.writeFile(markerPath, 'unfinished work');
      const acquire = isolatedLock({ alive: () => false, snapshot: async () => assert.fail('Incomplete work must block before a scan') });
      await assert.rejects(acquire(root), /заблокирована/);
      assert.deepEqual(await fs.readdir(lock), [name]);
      assert.equal(await fs.readFile(markerPath, 'utf8'), 'unfinished work');
    });
  });
}

test('only explicit preparation recovery may acquire a stale preparation lock without removing its marker', async () => {
  await fixture(async ({ root, lock }) => {
    await owner(lock);
    await fs.mkdir(join(root, '.preparation'));
    const marker = join(root, '.preparation/incomplete.json');
    await fs.writeFile(marker, 'preserved marker');
    let scans = 0;
    const acquire = isolatedLock({ alive: pid => pid === process.pid, snapshot: async () => { scans++; } });
    await assert.rejects(acquire(root), /заблокирована/);
    assert.equal(scans, 0);
    const release = await acquire(root, { preparationRecovery: true });
    assert.equal(scans, 1);
    assert.equal(await fs.readFile(marker, 'utf8'), 'preserved marker');
    await release();
    await assert.rejects(fs.lstat(lock), { code: 'ENOENT' });
    assert.equal(await fs.readFile(marker, 'utf8'), 'preserved marker');
  });
});

for (const marker of ['install', 'update']) {
  test(`explicit preparation recovery never authorizes an incomplete ${marker}`, async () => {
    await fixture(async ({ root, lock, meta }) => {
      const name = await owner(lock);
      await fs.mkdir(join(root, '.preparation'));
      await fs.writeFile(join(root, '.preparation/incomplete.json'), 'preparation');
      await fs.writeFile(join(meta, `${marker}-incomplete.json`), 'preserve');
      const acquire = isolatedLock({ alive: () => false, snapshot: async () => assert.fail('Incomplete modpack must block before a scan') });
      await assert.rejects(acquire(root, { preparationRecovery: true }), /заблокирована/);
      assert.deepEqual(await fs.readdir(lock), [name]);
      assert.equal(await fs.readFile(join(meta, `${marker}-incomplete.json`), 'utf8'), 'preserve');
    });
  });
}

test('explicit preparation recovery still refuses a live registered child', async () => {
  await fixture(async ({ root, lock }) => {
    await owner(lock, 12345, process.pid);
    await fs.mkdir(join(root, '.preparation'));
    await fs.writeFile(join(root, '.preparation/incomplete.json'), 'preserve');
    const before = await fs.readdir(lock);
    const acquire = isolatedLock({ alive: pid => pid === process.pid, snapshot: async () => assert.fail('Live child must block before a scan') });
    await assert.rejects(acquire(root, { preparationRecovery: true }), /заблокирована/);
    assert.deepEqual(await fs.readdir(lock), before);
  });
});

for (const problem of ['json', 'schema', 'filename', 'unknown-entry', 'hard-link', 'child-pid']) {
  test(`damaged lock metadata is preserved and cannot authorize recovery: ${problem}`, async () => {
    await fixture(async ({ root, lock, directory }) => {
      const name = await owner(lock, 12345, problem === 'child-pid' ? 12346 : undefined);
      const path = join(lock, name);
      if (problem === 'json') await fs.writeFile(path, '{');
      if (problem === 'schema') await fs.writeFile(path, JSON.stringify({ schema: 2, pid: 12345, id: randomUUID() }));
      if (problem === 'filename') await fs.rename(path, join(lock, 'owner.json'));
      if (problem === 'unknown-entry') await fs.writeFile(join(lock, 'unrecognized.txt'), 'preserve');
      if (problem === 'hard-link') await fs.link(path, join(directory, 'outside.json'));
      if (problem === 'child-pid') {
        const child = (await fs.readdir(lock)).find(name => name.startsWith('child-'));
        const value = JSON.parse(await fs.readFile(join(lock, child), 'utf8'));
        await fs.writeFile(join(lock, child), JSON.stringify({ ...value, pid: 12347 }));
      }
      const before = new Map(await Promise.all((await fs.readdir(lock)).map(async name => [name, await fs.readFile(join(lock, name), 'utf8')])));
      const acquire = isolatedLock({ alive: () => false, snapshot: async () => assert.fail('Malformed records must not reach the scan') });
      await assert.rejects(acquire(root), /заблокирована/);
      assert.deepEqual(new Map(await Promise.all((await fs.readdir(lock)).map(async name => [name, await fs.readFile(join(lock, name), 'utf8')]))), before);
    });
  });
}

test('a directory junction is never followed during recovery', async () => {
  await fixture(async ({ root, lock, directory }) => {
    const outside = join(directory, 'outside');
    await fs.mkdir(outside);
    const name = await owner(outside);
    await fs.rmdir(lock);
    await fs.symlink(outside, lock, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(isolatedLock({ alive: () => false })(root), /заблокирована/);
    assert.deepEqual(await fs.readdir(outside), [name]);
  });
});

for (const component of ['root', 'meta', 'lock']) {
  for (const operation of ['recovery', 'release']) {
    test(`${operation} refuses a ${component} junction substituted before cleanup`, async () => {
      await fixture(async ({ root, meta, lock, directory }) => {
        const target = { root, meta, lock }[component];
        const saved = join(directory, 'saved-directory');
        const outside = join(directory, 'outside');
        const outsideLock = component === 'root' ? join(outside, '.kayvel', 'lock') : component === 'meta' ? join(outside, 'lock') : outside;
        await fs.mkdir(outsideLock, { recursive: true });
        let name;
        let release;
        if (operation === 'release') {
          await fs.rmdir(lock);
          release = await acquireGameDirectoryLock(root);
          [name] = await fs.readdir(lock);
        } else name = await owner(lock);
        await fs.copyFile(join(lock, name), join(outsideLock, name));
        const original = await fs.readFile(join(outsideLock, name), 'utf8');
        const substitute = async () => {
          await fs.rename(target, saved);
          await fs.symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
        };
        try {
          if (release) {
            await substitute();
            await assert.rejects(release(), /заблокирована/);
          } else {
            const acquire = isolatedLock({ alive: () => false, snapshot: substitute });
            await assert.rejects(acquire(root), /заблокирована/);
          }
          assert.equal(await fs.readFile(join(outsideLock, name), 'utf8'), original);
        } finally {
          if (await fs.lstat(saved).catch(() => undefined)) {
            await fs.rm(target, { recursive: true, force: true });
            await fs.rename(saved, target);
          }
          if (release) await release();
        }
      });
    });
  }
}

test('a child registered while the owner was stopping is checked again before recovery', async () => {
  await fixture(async ({ root, lock }) => {
    await owner(lock);
    let reads = 0;
    const acquire = isolatedLock({ alive: pid => pid === process.pid, files: { ...fs, readFile: async (...args) => {
      const contents = await fs.readFile(...args);
      if (++reads === 1) {
        const value = JSON.parse(contents);
        await fs.writeFile(join(lock, `child-${value.id}-${process.pid}.json`), JSON.stringify({ ...value, pid: process.pid }));
      }
      return contents;
    } }, snapshot: async () => assert.fail('The second read must find the live child') });
    await assert.rejects(acquire(root), /заблокирована/);
    assert.equal((await fs.readdir(lock)).length, 2);
  });
});

for (const marker of ['install', 'preparation']) {
  test(`an ${marker} marker appearing during the process scan prevents cleanup`, async () => {
    await fixture(async ({ root, lock, meta }) => {
      const name = await owner(lock);
      const acquire = isolatedLock({ alive: () => false, snapshot: async () => {
        const path = marker === 'install' ? join(meta, 'install-incomplete.json') : join(root, '.preparation', 'incomplete.json');
        await fs.mkdir(join(path, '..'), { recursive: true });
        await fs.writeFile(path, 'unfinished');
      } });
      await assert.rejects(acquire(root), /заблокирована/);
      assert.deepEqual(await fs.readdir(lock), [name]);
    });
  });
}

test('many concurrent recoverers publish exactly one nonempty generation', async () => {
  await fixture(async ({ root, lock, meta }) => {
    await owner(lock);
    const acquire = isolatedLock({ alive: pid => pid === process.pid });
    const results = await Promise.allSettled(Array.from({ length: 16 }, () => acquire(root)));
    const winners = results.filter(result => result.status === 'fulfilled');
    assert.equal(winners.length, 1);
    assert.equal((await fs.readdir(lock)).length, 1);
    assert.deepEqual(await fs.readdir(meta), ['lock']);
    await winners[0].value();
  });
});

test('a delayed stale cleanup cannot remove a successor lock', async () => {
  await fixture(async ({ root, lock }) => {
    const name = await owner(lock);
    let entered;
    let resume;
    const paused = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { resume = resolve; });
    const slow = isolatedLock({ alive: pid => pid === process.pid, files: { ...fs, unlink: async path => {
      if (path === join(lock, name)) { entered(); await gate; }
      return fs.unlink(path);
    } } });
    const oldAttempt = slow(root);
    const rejected = assert.rejects(oldAttempt, /заблокирована/);
    await paused;
    const next = await isolatedLock({ alive: pid => pid === process.pid })(root);
    const before = await fs.readdir(lock);
    resume();
    await rejected;
    assert.deepEqual(await fs.readdir(lock), before);
    await next();
  });
});

test('child PID registration is synchronous, unique, and removed with its generation', async () => {
  await fixture(async ({ root, lock }) => {
    await fs.rmdir(lock);
    const release = await acquireGameDirectoryLock(root);
    release.trackChild(process.pid);
    release.trackChild(process.pid);
    assert.equal((await fs.readdir(lock)).length, 2);
    await release();
    assert.throws(() => release.trackChild(process.pid), /заблокирована/);
    await assert.rejects(fs.lstat(lock), { code: 'ENOENT' });
  });
});

test('native Windows snapshot preserves an unregistered Java orphan after its owner is killed', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  await fixture(async ({ root, lock, directory }) => {
    await fs.rmdir(lock);
    const java = join(directory, 'java.exe');
    await fs.copyFile(process.execPath, java);
    const moduleUrl = new URL('../dist/main/game-directory-lock.js', import.meta.url).href;
    const script = `
      import { spawn } from 'node:child_process';
      import { acquireGameDirectoryLock } from ${JSON.stringify(moduleUrl)};
      await acquireGameDirectoryLock(${JSON.stringify(root)});
      const game = spawn(${JSON.stringify(java)}, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      game.once('spawn', () => { game.unref(); process.send({ pid: game.pid }); });
      setInterval(() => {}, 1000);
    `;
    const launcher = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const closed = once(launcher, 'close');
    let gamePid;
    try {
      [{ pid: gamePid }] = await once(launcher, 'message');
      assert.ok(Number.isSafeInteger(gamePid) && gamePid > 0);
      assert.equal((await fs.readdir(lock)).length, 1);
      launcher.kill('SIGKILL');
      await closed;
      const before = await fs.readdir(lock);
      await assert.rejects(acquireGameDirectoryLock(root), /заблокирована/);
      assert.deepEqual(await fs.readdir(lock), before);
      assert.equal(processMayBeAlive(gamePid), true);
      process.kill(gamePid, 'SIGKILL');
      for (let attempt = 0; attempt < 100 && processMayBeAlive(gamePid); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(processMayBeAlive(gamePid), false);
      gamePid = undefined;
      const release = await acquireGameDirectoryLock(root);
      await release();
    } finally {
      if (gamePid && processMayBeAlive(gamePid)) process.kill(gamePid, 'SIGKILL');
      if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL');
      await closed;
    }
  });
});

test('native Windows process check recovers a lock after its actual owner is terminated', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  await fixture(async ({ root, lock }) => {
    await fs.rmdir(lock);
    const moduleUrl = new URL('../dist/main/game-directory-lock.js', import.meta.url).href;
    const script = `import { acquireGameDirectoryLock } from ${JSON.stringify(moduleUrl)}; await acquireGameDirectoryLock(${JSON.stringify(root)}); console.log('locked'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    try {
      await once(child.stdout, 'data');
      child.kill('SIGKILL');
      await closed;
      const release = await acquireGameDirectoryLock(root);
      await release();
      await assert.rejects(fs.lstat(lock), { code: 'ENOENT' });
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; }
  });
});

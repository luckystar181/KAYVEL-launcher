import test from 'node:test';
import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { mkdtemp, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

function marker(root, name) {
  let watcher, timer;
  const promise = new Promise((resolve, reject) => {
    watcher = watch(root, (_event, file) => { if (file === name) resolve(); });
    watcher.on('error', reject);
    timer = setTimeout(() => reject(new Error(`Missing native handoff fixture result: ${name}`)), 20_000);
  });
  return { promise, close: () => { watcher.close(); clearTimeout(timer); } };
}

test('real .NET WinExe uses private stdio, waits for the fixture parent to exit and refuses a rejected handoff', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(process.env.KAYVEL_TEST_TMPDIR ?? tmpdir(), 'kayvel-handoff-native-'));
  const executable = join(root, 'handoff-fixture.exe');
  const compiler = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const compiled = spawnSync(compiler, ['/nologo', '/target:winexe', '/main:InstallerHandoffFixture', `/out:${executable}`, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll', fileURLToPath(new URL('../installer/Bootstrap.cs', import.meta.url)), fileURLToPath(new URL('./installer-handoff-fixture.cs', import.meta.url))], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  for (const mode of ['success', 'reject', 'no-ack', 'parent-alive']) {
    const directory = join(root, mode);
    await mkdir(directory);
    const result = mode === 'success' ? 'completed.txt' : 'rejected.txt';
    const expected = marker(directory, result);
    try {
      const parent = spawn(process.execPath, [fileURLToPath(new URL('./installer-handoff-parent.mjs', import.meta.url)), executable, directory, mode], {
        windowsHide: true, env: { ...process.env, KAYVEL_HANDOFF_FIXTURE_ROOT: directory }, stdio: ['ignore', 'pipe', 'pipe']
      });
      let output = '';
      parent.stdout.on('data', data => { output += data; });
      parent.stderr.on('data', data => { output += data; });
      const exit = new Promise((resolve, reject) => {
        parent.once('error', reject);
        parent.once('exit', (code, signal) => { if (code === 0 && !signal) resolve(); else reject(new Error(`Fixture parent exited ${code}/${signal}: ${output}`)); });
      });
      await Promise.all([exit, expected.promise]);
      assert.equal((await stat(join(directory, result))).isFile(), true);
      if (mode === 'success') assert.equal((await stat(join(directory, 'quit-requested.txt'))).isFile(), true);
      else {
        await assert.rejects(stat(join(directory, 'quit-requested.txt')), { code: 'ENOENT' });
        await assert.rejects(stat(join(directory, 'completed.txt')), { code: 'ENOENT' });
        if (mode !== 'reject') assert.equal((await stat(join(directory, 'parent-alive.txt'))).isFile(), true);
      }
    } finally { expected.close(); }
  }
});

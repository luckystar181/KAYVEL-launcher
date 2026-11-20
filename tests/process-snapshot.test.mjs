import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const helper = fileURLToPath(new URL('../dist/main/KAYVEL-ProcessSnapshot.exe', import.meta.url));
test('native Toolhelp snapshot enumerates real PID ancestry without PowerShell, WMI or elevation', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync(helper, [], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4_000_000, env: { ...process.env, PATH: '' } });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stderr, '');
  assert.notEqual(result.stdout.charCodeAt(0), 0xFEFF);
  const records = JSON.parse(result.stdout);
  assert.ok(Array.isArray(records) && records.length > 0);
  assert.equal(new Set(records.map(record => record.ProcessId)).size, records.length);
  assert.ok(records.some(record => record.ProcessId === process.pid));
  const child = records.find(record => record.Name === 'KAYVEL-ProcessSnapshot.exe' && record.ParentProcessId === process.pid);
  assert.ok(child, 'snapshot must retain the actual parent PID of the helper');
  for (const record of records) {
    assert.ok(Number.isSafeInteger(record.ProcessId) && record.ProcessId >= 0);
    assert.ok(Number.isSafeInteger(record.ParentProcessId) && record.ParentProcessId >= 0);
    assert.equal(typeof record.Name, 'string');
    assert.ok(record.Name.trim());
  }
});

test('native helper refuses unexpected arguments without printing a partial snapshot', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync(helper, ['unexpected'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
});

test('portable packaging includes the native process helper next to the querying module', async () => {
  const script = await readFile(new URL('../scripts/package-portable.mjs', import.meta.url), 'utf8');
  assert.match(script, /await cp\(join\(root, 'dist', 'main', 'KAYVEL-ProcessSnapshot\.exe'\), join\(app, 'dist', 'main', 'KAYVEL-ProcessSnapshot\.exe'\)/);
});

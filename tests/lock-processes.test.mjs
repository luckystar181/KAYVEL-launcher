import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = await readFile(new URL('../dist/main/lock-processes.js', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const self = { ProcessId: 10, ParentProcessId: 1, Name: 'KAYVEL.exe' };
function isolatedProcesses(query, platform = 'win32') {
  const exports = {};
  runInNewContext(outputText, { exports, Error, process: { platform, pid: 10, env: { SystemRoot: 'C:\\Windows' } }, require(name) {
    if (name === 'node:util') return { promisify: () => query };
    return require(name);
  } });
  return exports.assertRecoveryProcessesStopped;
}

const cases = [
  [{ code: 1 }, /код выхода 1/],
  [{ code: 'ENOENT' }, /код ENOENT/],
  [{ code: 'EACCES' }, /код EACCES/],
  [{ killed: true, signal: 'SIGTERM', code: null }, /принудительно; лимит ожидания 15 с; сигнал SIGTERM/],
  [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }, /код ERR_CHILD_PROCESS_STDIO_MAXBUFFER/],
  [{ code: 1, stderr: 'PermissionDenied: failed 0x80041003\n FullyQualifiedErrorId : HRESULTAccessDenied,Microsoft.Management.Infrastructure.CimCmdlets.GetCimInstanceCommand' }, /код выхода 1; HRESULT 0x80041003; PermissionDenied; PowerShell HRESULTAccessDenied/],
  [{}, /причина не распознана/]
];
for (const [detail, expected] of cases) {
  test(`process query reports bounded diagnostics without the command: ${String(detail.code ?? detail.signal ?? 'unknown')}`, async () => {
    const original = Object.assign(new Error('Command failed: PRIVATE_COMMAND'), detail, { stdout: 'PRIVATE_PROCESS_LIST' });
    let calls = 0;
    const check = isolatedProcesses(async () => { calls++; throw original; });
    await assert.rejects(check(), error => {
      assert.match(error.message, expected);
      assert.match(error.message, /Блокировка сохранена/);
      assert.doesNotMatch(error.message, /PRIVATE_|Get-CimInstance|C:\\/);
      assert.ok(error.message.length < 400);
      assert.equal(error.cause, original);
      return true;
    });
    assert.equal(calls, 1);
  });
}

test('process query ignores arbitrary child output and unsafe diagnostic fields', async () => {
  for (const detail of [null, undefined, 'PRIVATE_ERROR', {
    code: 'PRIVATE_COMMAND OR PASSWORD', signal: 'SIGTERM PRIVATE_SECRET',
    stderr: 'PRIVATE_PROFILE C:\\Users\\PRIVATE_NAME\nFullyQualifiedErrorId : PRIVATE_TOKEN&secret',
    message: 'PRIVATE_MESSAGE', stdout: 'PRIVATE_PROCESS_LIST'
  }]) {
    await assert.rejects(isolatedProcesses(async () => { throw detail; })(), error => {
      assert.doesNotMatch(error.message, /PRIVATE_|C:\\/);
      assert.match(error.message, /Блокировка сохранена/);
      return true;
    });
  }
});

test('process query retains the original command, timeout, buffer limit and hidden child', async () => {
  let calls = 0;
  const check = isolatedProcesses(async (exe, args, options) => {
    calls++;
    assert.equal(exe, join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    assert.deepEqual(Array.from(args), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name) | ConvertTo-Json -Compress']);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 15000);
    assert.equal(options.maxBuffer, 4_000_000);
    assert.equal(options.encoding, 'utf8');
    return { stdout: '\uFEFF' + JSON.stringify([{ ProcessId: 0, ParentProcessId: 0, Name: 'System Idle Process' }, self]) };
  });
  await check();
  assert.equal(calls, 1);
});

for (const stdout of ['PRIVATE_BAD_JSON', '{}', 'null', '[]', '[null]', '[42]', JSON.stringify([{ ...self, ProcessId: 20 }]), JSON.stringify([self, self])]) {
  test(`process query rejects malformed or untrusted snapshots: ${stdout.slice(0, 30)}`, async () => {
    await assert.rejects(isolatedProcesses(async () => ({ stdout }))(), error => {
      assert.match(error.message, /блокировка сохранена/i);
      assert.doesNotMatch(error.message, /PRIVATE_/);
      return true;
    });
  });
}

for (const name of ['java.exe', 'javaw.exe', 'KAYVEL.exe', 'electron.exe']) {
  test(`process query still refuses a successful snapshot containing another ${name}`, async () => {
    const stdout = JSON.stringify([self, { ProcessId: 20, ParentProcessId: 1, Name: name }]);
    await assert.rejects(isolatedProcesses(async () => ({ stdout }))(), /Папка игры заблокирована/);
  });
}

test('process query never starts PowerShell outside Windows', async () => {
  await assert.rejects(isolatedProcesses(async () => assert.fail('Unexpected query'), 'linux')(), /только в Windows/);
});

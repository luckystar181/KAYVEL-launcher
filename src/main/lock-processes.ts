import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
export type ProcessEntry = { pid: number; parentPid: number; name: string };

export function processMayBeAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export function assertNoGameProcesses(entries: ProcessEntry[], currentPid = process.pid): void {
  if (!Array.isArray(entries) || !entries.length || entries.some(entry =>
    !entry || !Number.isSafeInteger(entry.pid) || entry.pid <= 0 || !Number.isSafeInteger(entry.parentPid) || entry.parentPid < 0 ||
    typeof entry.name !== 'string' || !entry.name.trim()) ||
      new Set(entries.map(entry => entry.pid)).size !== entries.length || !entries.some(entry => entry.pid === currentPid)) {
    throw new Error('Не удалось проверить список процессов; блокировка сохранена.');
  }
  const ownProcesses = new Set([currentPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (ownProcesses.has(entry.parentPid) && !ownProcesses.has(entry.pid)) {
        ownProcesses.add(entry.pid);
        changed = true;
      }
    }
  }
  for (const entry of entries) {
    if (/^javaw?(?:\.exe)?$/i.test(entry.name) ||
        (!ownProcesses.has(entry.pid) && /^(?:kayvel[^\\/]*|electron)(?:\.exe)?$/i.test(entry.name))) {
      throw new Error('Папка игры заблокирована: работает Java, Minecraft или другой лаунчер. Закройте их и повторите попытку.');
    }
  }
}

function processQueryFailure(error: unknown): Error {
  const detail = error && typeof error === 'object' ? error as {
    code?: unknown; signal?: unknown; killed?: unknown; stderr?: unknown;
  } : {};
  const reasons: string[] = [];
  if (Number.isSafeInteger(detail.code)) reasons.push(`код выхода ${detail.code}`);
  else if (typeof detail.code === 'string' && /^(?:E[A-Z0-9_]{1,63}|ERR_[A-Z0-9_]{1,63})$/.test(detail.code)) reasons.push(`код ${detail.code}`);
  if (detail.killed === true) reasons.push('процесс завершён принудительно; лимит ожидания 15 с');
  if (typeof detail.signal === 'string' && /^SIG[A-Z0-9]{1,16}$/.test(detail.signal)) reasons.push(`сигнал ${detail.signal}`);
  if (typeof detail.stderr === 'string') {
    const stderr = detail.stderr.slice(0, 16_000);
    const hresult = /\b0x[0-9a-f]{8}\b/i.exec(stderr)?.[0];
    if (hresult) reasons.push(`HRESULT ${hresult}`);
    const category = /\b(?:PermissionDenied|UnauthorizedAccessException|PSSecurityException|CommandNotFoundException|CimException|InvalidNamespace|InvalidClass)\b/.exec(stderr)?.[0];
    if (category) reasons.push(category);
    const id = /FullyQualifiedErrorId\s*:\s*([A-Za-z][A-Za-z0-9_.-]{0,79})(?=[,\s]|$)/.exec(stderr)?.[1];
    if (id) reasons.push(`PowerShell ${id}`);
  }
  return new Error(`Не удалось проверить процессы Windows (PowerShell: ${reasons.join('; ') || 'причина не распознана'}). Блокировка сохранена.`, { cause: error });
}

export async function assertRecoveryProcessesStopped(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Проверка старой блокировки поддерживается только в Windows; блокировка сохранена.');
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let stdout: string;
  try {
    ({ stdout } = await executeFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference="Stop"; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name) | ConvertTo-Json -Compress'],
    { windowsHide: true, timeout: 15000, maxBuffer: 4_000_000, encoding: 'utf8' }));
  } catch (error) { throw processQueryFailure(error); }
  let records: unknown;
  try { records = JSON.parse(stdout.replace(/^\uFEFF/, '')); }
  catch (error) { throw new Error('Не удалось проверить процессы Windows: PowerShell вернул неверный JSON; блокировка сохранена.', { cause: error }); }
  if (!Array.isArray(records) || records.some(record => !record || typeof record !== 'object')) throw new Error('Не удалось проверить процессы; блокировка сохранена.');
  const entries = records.map((record: { ProcessId?: unknown; ParentProcessId?: unknown; Name?: unknown }) => ({
    pid: record?.ProcessId as number, parentPid: record?.ParentProcessId as number, name: record?.Name as string
  }));
  // Windows includes the idle process (PID 0); it cannot own a game lock.
  assertNoGameProcesses(entries.filter(entry => entry.pid !== 0));
}

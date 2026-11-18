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

export async function assertRecoveryProcessesStopped(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Проверка старой блокировки поддерживается только в Windows; блокировка сохранена.');
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await executeFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name) | ConvertTo-Json -Compress'],
  { windowsHide: true, timeout: 15000, maxBuffer: 4_000_000, encoding: 'utf8' });
  const records: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  if (!Array.isArray(records)) throw new Error('Не удалось проверить процессы; блокировка сохранена.');
  const entries = records.map((record: { ProcessId?: unknown; ParentProcessId?: unknown; Name?: unknown }) => ({
    pid: record?.ProcessId as number, parentPid: record?.ParentProcessId as number, name: record?.Name as string
  }));
  // Windows includes the idle process (PID 0); it cannot own a game lock.
  assertNoGameProcesses(entries.filter(entry => entry.pid !== 0));
}

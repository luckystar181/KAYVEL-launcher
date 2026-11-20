import { spawnSync } from 'node:child_process';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function buildProcessSnapshot(output = join(root, 'dist/main/KAYVEL-ProcessSnapshot.exe')) {
  if (process.platform !== 'win32') return;
  await mkdir(dirname(output), { recursive: true });
  const pending = output + '.building.exe';
  const compiler = join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  try {
    const result = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', `/out:${pending}`, '/reference:System.Web.Extensions.dll', join(root, 'native/ProcessSnapshot.cs')], { encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0) throw new Error('Process snapshot compilation failed: ' + (result.error?.message ?? result.stdout + result.stderr));
    await rename(pending, output);
  } finally { await rm(pending, { force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildProcessSnapshot();

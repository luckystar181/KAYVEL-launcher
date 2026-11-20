import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
export const setupVersion = 'v0.2.7-v3S';
export const payloadName = 'KAYVEL-v3S-windows-x64.zip';

export function installerSettings(bytes, sha256) {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 1_000_000_000 || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid payload size or SHA-256.');
  return { Version: setupVersion, Url: `https://github.com/luckystar181/KAYVEL-launcher/releases/download/${setupVersion}/${payloadName}`, Bytes: bytes, Sha256: sha256 };
}

async function plainTree(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error('Payload must contain only regular files and directories: ' + path);
  if (info.isDirectory()) for (const name of await readdir(path)) await plainTree(join(path, name));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error || result.status !== 0) throw new Error('Packaging failed: ' + (result.error?.message ?? result.status));
}

export async function reserveSetupOutput(output) {
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
}

export async function packageSetup(portable, output) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Setup packaging requires Windows x64.');
  portable = resolve(portable);
  output = resolve(output);
  await plainTree(portable);
  for (const file of ['KAYVEL.exe', 'resources/app/dist/main/main.js', 'resources/app/package.json']) {
    if (!(await lstat(join(portable, file))).isFile()) throw new Error('Incomplete portable: ' + file);
  }
  const app = JSON.parse(await readFile(join(portable, 'resources/app/package.json'), 'utf8'));
  if (app.version !== '0.2.7') throw new Error('Setup requires launcher 0.2.7.');
  const release = await readFile(join(portable, 'resources/app/dist/main/release.js'), 'utf8');
  if (!release.includes('/releases/download/v0.2.0-v3S/manifest.json')) throw new Error('Portable must target the v3S modpack.');
  await reserveSetupOutput(output);
  const zip = join(output, payloadName);
  run(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = $env:KAYVEL_PAYLOAD_SOURCE.TrimEnd('\\') + '\\'
$stream = [IO.File]::Open($env:KAYVEL_PAYLOAD_ZIP, [IO.FileMode]::CreateNew)
try {
  $archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
  try {
    Get-ChildItem -LiteralPath $root -Recurse -File | Sort-Object FullName | ForEach-Object {
      $relative = $_.FullName.Substring($root.Length).Replace('\\', '/')
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $relative, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally { $archive.Dispose() }
} finally { $stream.Dispose() }
`], { env: { ...process.env, KAYVEL_PAYLOAD_SOURCE: portable, KAYVEL_PAYLOAD_ZIP: zip } });
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(zip)) hash.update(chunk);
  const settings = installerSettings(Number((await lstat(zip)).size), hash.digest('hex'));
  const config = join(output, 'installer-settings.json');
  await writeFile(config, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx' });
  const exe = join(output, 'KAYVEL-Setup-v3S.exe');
  const compiler = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  run(compiler, ['/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', `/out:${exe}`, `/win32manifest:${join(root, 'installer/app.manifest')}`, `/resource:${config},installer-settings.json`, `/resource:${zip},launcher-payload.zip`, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll', join(root, 'installer/Bootstrap.cs')]);
  const setupHash = createHash('sha256');
  for await (const chunk of createReadStream(exe)) setupHash.update(chunk);
  await writeFile(join(output, 'SHA256SUMS.txt'), `${setupHash.digest('hex')}  KAYVEL-Setup-v3S.exe\n${settings.Sha256}  ${payloadName}\n`, { flag: 'wx' });
  console.log(`Setup: ${exe}\nPayload: ${zip}\nUsers need only the setup EXE: the verified payload is embedded. The separate ZIP is a diagnostic/portable asset. Authenticode signing is not configured.`);
  return { exe, zip, settings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [portable, output, ...extra] = process.argv.slice(2);
  if (!portable || !output || extra.length) throw new Error('Usage: node scripts/package-setup.mjs PORTABLE_FOLDER NEW_OUTPUT_FOLDER');
  await packageSetup(portable, output);
}

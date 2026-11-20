import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installerSettings, packageSetup, reserveSetupOutput } from '../scripts/package-setup.mjs';

test('setup creates missing output parents but never reuses an existing build', async () => {
  const root = await mkdtemp(join(process.env.KAYVEL_TEST_TMPDIR ?? tmpdir(), 'kayvel-setup-output-'));
  const output = join(root, 'dist', 'setup', 'KAYVEL-v3S');
  await reserveSetupOutput(output);
  assert.equal((await stat(output)).isDirectory(), true);
  const marker = join(output, 'preserve.txt');
  await writeFile(marker, 'existing build', { flag: 'wx' });
  await assert.rejects(reserveSetupOutput(output), { code: 'EEXIST' });
  assert.equal(await readFile(marker, 'utf8'), 'existing build');
  const occupied = join(root, 'occupied');
  await writeFile(occupied, 'existing file', { flag: 'wx' });
  await assert.rejects(reserveSetupOutput(occupied), { code: 'EEXIST' });
  assert.equal(await readFile(occupied, 'utf8'), 'existing file');
});

test('setup payload is pinned to a separate v3S launcher release, size and SHA-256', () => {
  const settings = installerSettings(123, 'a'.repeat(64));
  assert.equal(settings.Url, 'https://github.com/luckystar181/KAYVEL-launcher/releases/download/v0.2.7-v3S/KAYVEL-v3S-windows-x64.zip');
  assert.equal(settings.Version, 'v0.2.7-v3S');
  assert.equal(settings.Bytes, 123);
  assert.equal(settings.Sha256, 'a'.repeat(64));
  for (const bytes of [0, -1, 1.5, NaN, 1_000_000_001]) assert.throws(() => installerSettings(bytes, 'a'.repeat(64)));
  assert.throws(() => installerSettings(123, 'bad'));
});

test('setup packages a minimal fixture with Windows PowerShell and embeds the verified payload settings', { skip: process.platform !== 'win32' || process.arch !== 'x64', timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(process.env.KAYVEL_TEST_TMPDIR ?? tmpdir(), 'kayvel-setup-package-'));
  const portable = join(root, 'portable');
  const main = join(portable, 'resources', 'app', 'dist', 'main');
  await mkdir(main, { recursive: true });
  await writeFile(join(portable, 'KAYVEL.exe'), 'fixture-not-executable', { flag: 'wx' });
  await writeFile(join(main, 'main.js'), '// fixture', { flag: 'wx' });
  await writeFile(join(main, 'release.js'), '// /releases/download/v0.2.0-v3S/manifest.json', { flag: 'wx' });
  await writeFile(join(portable, 'resources', 'app', 'package.json'), JSON.stringify({ version: '0.2.7' }), { flag: 'wx' });
  const output = join(root, 'missing-parent', 'setup');
  const result = await packageSetup(portable, output);
  const zip = await readFile(result.zip);
  const exe = await readFile(result.exe);
  assert.equal(exe.subarray(0, 2).toString(), 'MZ');
  assert.equal(zip.subarray(0, 2).toString(), 'PK');
  assert.equal(result.settings.Bytes, zip.length);
  assert.equal(result.settings.Sha256, createHash('sha256').update(zip).digest('hex'));
  assert.equal(exe.includes(Buffer.from(JSON.stringify(result.settings, null, 2))), true);
  assert.equal(exe.includes(zip), true, 'the entire payload must be embedded, not downloaded');
  const checksums = await readFile(join(output, 'SHA256SUMS.txt'), 'utf8');
  assert.match(checksums, new RegExp(createHash('sha256').update(exe).digest('hex') + '  KAYVEL-Setup-v3S.exe'));
  assert.ok(checksums.includes(result.settings.Sha256));
  await assert.rejects(packageSetup(portable, output), { code: 'EEXIST' });
  assert.deepEqual(await readFile(result.exe), exe);
});

test('native installer rejects bad ZIPs, preserves occupied paths and creates an independent shortcut offline', { skip: process.platform !== 'win32', timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(process.env.KAYVEL_TEST_TMPDIR ?? tmpdir(), 'kayvel-setup-test-'));
  const executable = join(root, 'installer-tests.exe');
  const compiler = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const result = spawnSync(compiler, ['/nologo', '/target:exe', '/main:InstallerTests', `/out:${executable}`, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll', fileURLToPath(new URL('../installer/Bootstrap.cs', import.meta.url)), fileURLToPath(new URL('./installer-core.cs', import.meta.url))], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const tests = spawnSync(executable, [join(root, 'fixtures')], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(tests.status, 0, tests.stdout + tests.stderr);
  assert.match(tests.stdout, /assertions passed/);
  const source = await readFile(new URL('../installer/Bootstrap.cs', import.meta.url), 'utf8');
  assert.match(source, /GetManifestResourceStream\("launcher-payload\.zip"\)/);
  assert.doesNotMatch(source, /HttpWebRequest|WebRequest\.Create|InstallerCore\.Download|GetResponseAsync/);
  assert.match(source, /ExtractVerified\(Stream file/);
  assert.match(source, /FileMode\.CreateNew/);
  assert.match(source, /Directory\.Move\(staging, installed\)/);
  assert.doesNotMatch(source, /Directory\.Delete\([^)]*,\s*true\)/);
});

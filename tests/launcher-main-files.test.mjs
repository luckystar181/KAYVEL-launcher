import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyLauncherMain, launcherMainFiles } from '../scripts/launcher-main-files.mjs';

async function fixture(run) {
  const root = await mkdtemp(join(process.env.KAYVEL_TEST_TMPDIR || tmpdir(), 'kayvel-main-files-'));
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  await mkdir(source);
  await writeFile(join(source, 'main.js'), "import './profile.js';\n");
  await writeFile(join(source, 'profile.js'), "export { value } from './value.js';\n");
  await writeFile(join(source, 'value.js'), 'export const value = 1;\n');
  await writeFile(join(source, 'preload.cjs'), "const electron = require('electron');\n");
  try { await run({ root, source, destination }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('portable main files include only active dependencies and preload, not historical or stale modules', async () => fixture(async ({ source, destination }) => {
  for (const name of ['auth.js', 'game-bridge-session.js', 'ticket-bridge.js', 'stale.js']) await writeFile(join(source, name), 'historical prototype');
  const files = await copyLauncherMain(source, destination);
  assert.deepEqual(files, ['main.js', 'preload.cjs', 'profile.js', 'value.js']);
  assert.deepEqual((await readdir(destination)).sort(), files);
  assert.equal(await readFile(join(destination, 'value.js'), 'utf8'), 'export const value = 1;\n');
  assert.equal(await readFile(join(source, 'auth.js'), 'utf8'), 'historical prototype');
}));

test('portable main collection rejects direct and transitive historical account dependencies', async () => fixture(async ({ source, destination }) => {
  for (const name of ['auth.js', 'game-bridge-session.js', 'ticket-bridge.js']) {
    await writeFile(join(source, 'value.js'), `import './${name}';\n`);
    await assert.rejects(copyLauncherMain(source, destination), /Historical account module/);
    await assert.rejects(readdir(destination), { code: 'ENOENT' });
  }
  await writeFile(join(source, 'main.js'), "import './auth.js';\n");
  await assert.rejects(launcherMainFiles(source), /Historical account module/);
}));

test('portable main collection follows literal dynamic imports and preload require dependencies', async () => fixture(async ({ source }) => {
  await writeFile(join(source, 'main.js'), "export const load = () => import('./profile.js');\n");
  await writeFile(join(source, 'preload.cjs'), "require('./preload-helper.cjs');\n");
  await writeFile(join(source, 'preload-helper.cjs'), 'module.exports = {};\n');
  assert.deepEqual(await launcherMainFiles(source), ['main.js', 'preload-helper.cjs', 'preload.cjs', 'profile.js', 'value.js']);
}));

test('portable main collection refuses missing and escaping imports before copying', async () => fixture(async ({ source, destination }) => {
  await writeFile(join(source, 'main.js'), "import './missing.js';\n");
  await assert.rejects(copyLauncherMain(source, destination), { code: 'ENOENT' });
  await writeFile(join(source, 'main.js'), "import '../outside.js';\n");
  await assert.rejects(copyLauncherMain(source, destination), /Unsupported local launcher import/);
  await assert.rejects(readdir(destination), { code: 'ENOENT' });
}));

test('portable main copy never replaces an existing output file', async () => fixture(async ({ source, destination }) => {
  await mkdir(destination);
  await writeFile(join(destination, 'main.js'), 'keep this output');
  await assert.rejects(copyLauncherMain(source, destination), { code: 'EEXIST' });
  assert.equal(await readFile(join(destination, 'main.js'), 'utf8'), 'keep this output');
}));

test('the current launcher main dependency graph contains no account or ticket prototype', async () => {
  const files = await launcherMainFiles(fileURLToPath(new URL('../dist/main/', import.meta.url)));
  for (const required of ['main.js', 'preload.cjs', 'local-profile.js', 'manifest.js', 'installer.js', 'release-download.js']) assert.ok(files.includes(required), required);
  for (const historical of ['auth.js', 'game-bridge-session.js', 'ticket-bridge.js']) assert.ok(!files.includes(historical), historical);
});

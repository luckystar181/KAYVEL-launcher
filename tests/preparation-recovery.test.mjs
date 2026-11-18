import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as downloadSession from '../dist/main/download-session.js';
import * as installFiles from '../dist/main/install-files.js';
import { INSTANCE_FOLDER } from '../dist/main/prepare-instance.js';

const require = createRequire(import.meta.url);
const source = await fs.readFile(new URL('../dist/main/preparation-recovery.js', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
export function isolatedRecovery({ snapshot = async () => {}, files = fs } = {}) {
  const exports = {};
  runInNewContext(outputText, { exports, Buffer, Error, require(name) {
    if (name === './lock-processes.js') return { assertRecoveryProcessesStopped: snapshot };
    if (name === './download-session.js') return downloadSession;
    if (name === './install-files.js') return installFiles;
    if (name === 'node:fs/promises') return files;
    return require(name);
  } });
  return exports.backupIncompletePreparation;
}
async function fixture(t) {
  const root = await fs.mkdtemp(join(process.env.LOCALAPPDATA, 'Temp', 'opencode', 'kayvel-retry-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const originals = { 'saves/world/level.dat': 'world', 'screenshots/a.png': 'screenshot', 'options.txt': 'options',
    'servers.dat': 'servers', 'mods/fixture.jar': 'mod', 'config/fixture.toml': 'config', '.kayvel/signed-manifest.json': 'signed modpack',
    'runtime/java/bin/java.exe': 'partial java', 'libraries/fixture.jar': 'partial library', 'assets/fixture': 'partial asset',
    'versions/fixture/fixture.json': 'partial version', '.preparation/neoforge-installer.jar': 'partial installer',
    '.preparation/incomplete.json': JSON.stringify({ schema: 1, instance: INSTANCE_FOLDER }) };
  for (const [name, content] of Object.entries(originals)) await installFiles.writeNewFile(root, name, content);
  return { root, originals };
}

test('explicit retry backs up only incomplete components and preserves worlds, settings, mods and marker', async t => {
  const { root, originals } = await fixture(t);
  let scans = 0;
  const relative = await isolatedRecovery({ snapshot: async () => { scans++; } })(root, INSTANCE_FOLDER);
  assert.equal(scans, 1);
  assert.match(relative, /^\.kayvel\/preparation-backups\/[a-f0-9-]+$/);
  for (const [name, content] of Object.entries(originals)) {
    const moved = /^(runtime|libraries|assets|versions)\//.test(name);
    const prep = name.startsWith('.preparation/');
    if (moved || prep) {
      const backup = moved ? 'components/' + name : 'preparation/' + name.slice('.preparation/'.length);
      assert.equal(await fs.readFile(join(root, relative, backup), 'utf8'), content);
    }
    if (!moved && (!prep || name.endsWith('incomplete.json'))) assert.equal(await fs.readFile(join(root, name), 'utf8'), content);
    else await assert.rejects(fs.lstat(join(root, name)), { code: 'ENOENT' });
  }
});

for (const refusal of ['ready', 'install', 'update', 'wrong-instance', 'bad-schema', 'process', 'component-junction', 'preparation-junction', 'backup-junction', 'marker-link']) {
  test(`retry refuses unsafe state and preserves original components: ${refusal}`, async t => {
    const { root } = await fixture(t);
    const outside = await fs.mkdtemp(join(process.env.LOCALAPPDATA, 'Temp', 'opencode', 'kayvel-retry-outside-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    if (refusal === 'ready') await installFiles.writeNewFile(root, '.preparation/ready.json', '{}');
    if (['install', 'update'].includes(refusal)) await installFiles.writeNewFile(root, `.kayvel/${refusal}-incomplete.json`, '{}');
    if (refusal === 'wrong-instance' || refusal === 'bad-schema') await fs.writeFile(join(root, '.preparation/incomplete.json'), JSON.stringify({ schema: refusal === 'bad-schema' ? 2 : 1, instance: refusal === 'wrong-instance' ? 'other' : INSTANCE_FOLDER }));
    if (refusal === 'component-junction') {
      await fs.rename(join(root, 'runtime'), join(root, 'saved-runtime'));
      await fs.symlink(outside, join(root, 'runtime'), 'junction');
    }
    if (refusal === 'preparation-junction') await fs.symlink(outside, join(root, '.preparation/linked'), 'junction');
    if (refusal === 'backup-junction') await fs.symlink(outside, join(root, '.kayvel/preparation-backups'), 'junction');
    if (refusal === 'marker-link') await fs.link(join(root, '.preparation/incomplete.json'), join(outside, 'marker.json'));
    const backup = isolatedRecovery({ snapshot: async () => { if (refusal === 'process') throw new Error('process running'); } });
    await assert.rejects(backup(root, INSTANCE_FOLDER));
    assert.equal(await fs.readFile(join(root, 'libraries/fixture.jar'), 'utf8'), 'partial library');
    assert.equal(await fs.readFile(join(root, 'saves/world/level.dat'), 'utf8'), 'world');
    assert.ok(await fs.lstat(join(root, '.preparation/incomplete.json')));
    assert.deepEqual(await fs.readdir(outside), refusal === 'marker-link' ? ['marker.json'] : []);
  });
}

test('cancel between backup moves retains marker and all bytes, and a later explicit retry can continue', async t => {
  const { root } = await fixture(t);
  const controller = new AbortController();
  let moves = 0;
  const backup = isolatedRecovery({ files: { ...fs, rename: async (...args) => {
    await fs.rename(...args);
    if (++moves === 1) controller.abort(new Error('fixture cancelled'));
  } } });
  await assert.rejects(downloadSession.withDownloadSignal(controller.signal, () => backup(root, INSTANCE_FOLDER)), /fixture cancelled/);
  assert.ok(await fs.readFile(join(root, '.preparation/incomplete.json')));
  const [first] = await fs.readdir(join(root, '.kayvel/preparation-backups'));
  assert.equal(await fs.readFile(join(root, '.kayvel/preparation-backups', first, 'components/runtime/java/bin/java.exe'), 'utf8'), 'partial java');
  const second = await isolatedRecovery()(root, INSTANCE_FOLDER);
  assert.equal(await fs.readFile(join(root, second, 'components/libraries/fixture.jar'), 'utf8'), 'partial library');
  assert.ok(await fs.readFile(join(root, '.preparation/incomplete.json')));
  assert.equal(await fs.readFile(join(root, 'options.txt'), 'utf8'), 'options');
});

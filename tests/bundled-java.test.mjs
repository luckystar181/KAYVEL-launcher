import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { BUNDLED_JAVA_SIZE, BUNDLED_JAVA_ROOT, readBundledJava } from '../dist/main/bundled-java.js';
import * as session from '../dist/main/download-session.js';

const require = createRequire(import.meta.url);
const source = await fs.readFile(new URL('../dist/main/prepare-java.js', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
function isolated({ existing = null, bundle = async () => Buffer.from('verified fixture'), entries, valid = true } = {}) {
  const writes = [];
  const reports = [];
  const exports = {};
  runInNewContext(outputText, { exports, Buffer, Error, process: { platform: 'win32', arch: 'x64' }, require(name) {
    if (name === './java-runtime.js') return { availableJava21: () => existing, validJava21: () => valid };
    if (name === './bundled-java.js') return { BUNDLED_JAVA_ROOT, readBundledJava: bundle };
    if (name === './download-session.js') return session;
    if (name === './install-files.js') return { readZipFiles: async () => entries ?? new Map([
      [BUNDLED_JAVA_ROOT + '/bin/java.exe', Buffer.from('fixture, never executed')],
      [BUNDLED_JAVA_ROOT + '/legal/java.base/LICENSE', Buffer.from('fixture license')]
    ]) };
    if (name === './preparation-progress.js') return { stageProgress: (...args) => reports.push(args.slice(1)) };
    return require(name);
  } });
  const files = { root: 'fictional-instance', path: value => value, write: async (path, bytes) => { session.checkDownloadCancelled(); writes.push([path, bytes]); }, downloads: () => { throw new Error('Network forbidden'); } };
  return { run: () => exports.prepareJava(files, 'fictional-user-data', () => {}), writes, reports };
}

test('bundled Java rejects absent, wrong-sized and changed archives without networking', async t => {
  const root = await fs.mkdtemp(join(process.env.KAYVEL_TEST_TMPDIR ?? tmpdir(), 'kayvel-java-bundle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const path = join(root, 'java.zip');
  await assert.rejects(readBundledJava(path), /нет архива Java/);
  await fs.writeFile(path, 'invalid');
  await assert.rejects(readBundledJava(path), /размер/);
  const file = await fs.open(path, 'r+');
  try { await file.truncate(BUNDLED_JAVA_SIZE); } finally { await file.close(); }
  await assert.rejects(readBundledJava(path), /SHA-256/);
  const controller = new AbortController();
  controller.abort(new Error('fixture cancelled'));
  await assert.rejects(session.withDownloadSignal(controller.signal, () => readBundledJava(path)), /fixture cancelled/);
});

test('Java preparation uses a verified local snapshot, retains licenses and never requests a download', async () => {
  const f = isolated();
  assert.match(await f.run(), /runtime[\\/]jdk-21\.0\.13\+9-jre[\\/]bin[\\/]java.exe$/);
  assert.deepEqual(f.writes.map(([path]) => path), ['.preparation/java.zip', `runtime/${BUNDLED_JAVA_ROOT}/bin/java.exe`, `runtime/${BUNDLED_JAVA_ROOT}/legal/java.base/LICENSE`]);
  assert.doesNotMatch(source, /releaseDownloadUrl|\.downloads\(|https:\/\//);
});

test('existing Java is reused without reading the bundled archive', async () => {
  const f = isolated({ existing: 'existing-java', bundle: () => { throw new Error('must not read'); } });
  assert.equal(await f.run(), 'existing-java');
  assert.equal(f.writes.length, 0);
});

test('bundle verification failure is fail-closed without partial Java writes or fallback', async () => {
  const f = isolated({ bundle: async () => { throw new Error('bad pinned SHA-256'); } });
  await assert.rejects(f.run(), /bad pinned SHA-256/);
  assert.equal(f.writes.length, 0);
});

for (const problem of ['outside', 'missing-license', 'invalid-java', 'canceled']) {
  test(`bundled Java preparation stops safely: ${problem}`, async () => {
    const entries = new Map([[BUNDLED_JAVA_ROOT + '/bin/java.exe', Buffer.from('not executable')], [BUNDLED_JAVA_ROOT + '/legal/java.base/LICENSE', Buffer.from('license')]]);
    if (problem === 'outside') entries.set('outside/file', Buffer.from('bad'));
    if (problem === 'missing-license') entries.delete(BUNDLED_JAVA_ROOT + '/legal/java.base/LICENSE');
    const f = isolated({ entries, valid: problem !== 'invalid-java' });
    if (problem === 'canceled') {
      const controller = new AbortController(); controller.abort(new Error('fixture cancelled'));
      await assert.rejects(session.withDownloadSignal(controller.signal, f.run), /fixture cancelled/);
      assert.equal(f.writes.length, 0);
    } else {
      await assert.rejects(f.run(), problem === 'invalid-java' ? /проверку запуска/ : /структура/);
      if (problem !== 'invalid-java') assert.equal(f.writes.length, 1, 'only verified archive snapshot may be written');
    }
  });
}

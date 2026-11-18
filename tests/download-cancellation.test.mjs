import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cancelDownload, cancellationMessage, checkDownloadCancelled, configureDownloadRequest, downloadSignal, withDownloadSignal } from '../dist/main/download-session.js';
import { readReleaseBody, withTrustedDownload } from '../dist/main/release-download.js';
import { officialDownloadUrl } from '../dist/main/official-download.js';
import { PreparationFiles } from '../dist/main/preparation-files.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const url = 'https://libraries.minecraft.net/fixture.jar';

test('scoped cancellation is isolated from concurrent work and is restored after failure', async () => {
  const a = new AbortController();
  const b = new AbortController();
  const barrier = deferred();
  const cancelled = withDownloadSignal(a.signal, async () => {
    assert.equal(downloadSignal(), a.signal);
    await barrier.promise;
    assert.equal(downloadSignal(), a.signal);
    checkDownloadCancelled();
  });
  const rejected = assert.rejects(cancelled, new RegExp(cancellationMessage));
  const unaffected = withDownloadSignal(b.signal, async () => {
    await barrier.promise;
    assert.equal(downloadSignal(), b.signal);
    checkDownloadCancelled();
  });
  cancelDownload(a);
  barrier.resolve();
  await Promise.all([rejected, unaffected]);
  assert.equal(downloadSignal(), undefined);
  checkDownloadCancelled();
});

test('user cancellation aborts transport but waits for an in-flight local write before releasing its caller', async () => {
  const started = deferred();
  const finishWrite = deferred();
  const controller = new AbortController();
  let settled = false;
  let transportSignal;
  const pending = withDownloadSignal(controller.signal, () => withTrustedDownload(url, officialDownloadUrl,
    (response, signal) => readReleaseBody(response, 10, signal, async () => {
      started.resolve();
      await finishWrite.promise;
    }), { request: async (_url, init) => { transportSignal = init.signal; return new Response('fixture'); } }));
  const rejected = assert.rejects(pending, new RegExp(cancellationMessage)).then(() => { settled = true; });
  await started.promise;
  cancelDownload(controller);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transportSignal.aborted, true);
  assert.equal(settled, false);
  finishWrite.resolve();
  await rejected;
});

test('cancelled download workers abort every active request without scheduling remaining files', async t => {
  const root = await mkdtemp(join(process.env.LOCALAPPDATA, 'Temp', 'opencode', 'kayvel-cancel-workers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = deferred();
  const unwind = deferred();
  const bytes = Buffer.from('fixture worker');
  const hash = createHash('sha256').update(bytes).digest('hex');
  let requests = 0;
  let active = 0;
  let finished = false;
  const signals = [];
  const request = async (_url, init) => {
    active++;
    requests++;
    signals.push(init.signal);
    if (requests === 6) started.resolve();
    return new Response(new ReadableStream({
      async pull(stream) {
        await unwind.promise;
        active--;
        stream.close();
      }
    }));
  };
  configureDownloadRequest(request);
  t.after(() => configureDownloadRequest((...args) => fetch(...args)));
  const files = new PreparationFiles(root);
  const plan = Array.from({ length: 10 }, (_, index) => ({ path: `libraries/${index}.jar`, url, size: bytes.length, hash, algorithm: 'sha256' }));
  const controller = new AbortController();
  const pending = withDownloadSignal(controller.signal, () => files.downloads(plan, 'libraries', () => {}));
  const rejected = assert.rejects(pending, /Загрузка отменена/).then(() => { finished = true; });
  await started.promise;
  cancelDownload(controller);
  unwind.resolve();
  await rejected;
  assert.equal(requests, 6);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(finished, true);
  assert.equal(files.receipts.size, 0);
  const names = await readdir(join(root, 'libraries'));
  assert.equal(names.length, 6);
  for (const name of names) assert.equal((await readFile(join(root, 'libraries', name))).length, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(active, 0);
});

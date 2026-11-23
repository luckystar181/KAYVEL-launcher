import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FFMPEG_ARCHIVE, prepareFFmpeg } from '../dist/main/prepare-ffmpeg.js';
import { ReleaseHttpError } from '../dist/main/release-download.js';
import { withDownloadSignal } from '../dist/main/download-session.js';

async function workspace(t) {
  const root = await mkdtemp(join(process.env.LOCALAPPDATA, 'Temp', 'opencode', 'kayvel-ffmpeg-single-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

for (const status of [403, 404, 408, 429, 500, 502, 503, 504]) test(`FFmpeg HTTP ${status} is not retried and retains partial bytes`, async t => {
  const root = await workspace(t);
  const calls = [];
  const failure = new ReleaseHttpError(status, 'github.com');
  await assert.rejects(prepareFFmpeg(root, undefined, async (file, progress, validate) => {
    calls.push(file);
    assert.equal(file.url, FFMPEG_ARCHIVE.url);
    assert.equal(validate(file.url), file.url);
    assert.equal(file.hash, FFMPEG_ARCHIVE.hash);
    assert.equal(file.size, FFMPEG_ARCHIVE.size);
    assert.equal(file.algorithm, 'sha256');
    await writeFile(file.path, 'keep partial');
    throw failure;
  }), error => error === failure);
  assert.equal(calls.length, 1);
  assert.equal(await readFile(calls[0].path, 'utf8'), 'keep partial');
  assert.ok(!(await readdir(root)).includes('vista_ffmpeg_bin'));
});

for (const failure of [new Error('checksum mismatch'), new Error('untrusted redirect'), Object.assign(new Error('disk full'), { code: 'ENOSPC' }), Object.assign(new Error('fixture network failure'), { name: 'DownloadTransportError' })]) test(`FFmpeg failure is not retried: ${failure.message}`, async t => {
  const root = await workspace(t);
  let calls = 0;
  await assert.rejects(prepareFFmpeg(root, undefined, async () => { calls++; throw failure; }), error => error === failure);
  assert.equal(calls, 1);
});

test('FFmpeg cancellation during an HTTP failure prevents any further request', async t => {
  const root = await workspace(t);
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(withDownloadSignal(controller.signal, () => prepareFFmpeg(root, undefined, async () => {
    calls++; controller.abort(new Error('fixture cancelled during transfer')); throw new ReleaseHttpError(503, 'github.com');
  })), /fixture cancelled during transfer/);
  assert.equal(calls, 1);
  assert.ok(!(await readdir(root)).includes('vista_ffmpeg_bin'));
});

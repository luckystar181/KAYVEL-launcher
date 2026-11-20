import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FFMPEG_ARCHIVE, FFMPEG_MIRROR_URL, prepareFFmpeg } from '../dist/main/prepare-ffmpeg.js';
import { ReleaseHttpError } from '../dist/main/release-download.js';
import { withDownloadSignal } from '../dist/main/download-session.js';

async function workspace(t) {
  const root = await mkdtemp(join(process.env.LOCALAPPDATA, 'Temp', 'opencode', 'kayvel-ffmpeg-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

for (const status of [408, 429, 500, 502, 503, 504]) test(`FFmpeg HTTP ${status} uses the identical pinned mirror once and retains primary partial bytes`, async t => {
  const root = await workspace(t);
  const calls = [];
  await assert.rejects(prepareFFmpeg(root, undefined, async (file, progress, validate) => {
    calls.push(file);
    assert.equal(validate(file.url), file.url);
    assert.equal(file.hash, FFMPEG_ARCHIVE.hash);
    assert.equal(file.size, FFMPEG_ARCHIVE.size);
    assert.equal(file.algorithm, 'sha256');
    if (calls.length === 1) { await writeFile(file.path, 'keep partial'); throw new ReleaseHttpError(status, 'www.gyan.dev'); }
    assert.equal(file.url, FFMPEG_MIRROR_URL);
    assert.notEqual(file.path, calls[0].path);
    throw new Error('fixture backup failure');
  }), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.equal(error.cause.message, 'fixture backup failure');
    return true;
  });
  assert.equal(calls.length, 2);
  assert.equal(await readFile(calls[0].path, 'utf8'), 'keep partial');
  assert.ok(!(await readdir(root)).includes('vista_ffmpeg_bin'));
});

for (const failure of [new Error('checksum mismatch'), new ReleaseHttpError(403, 'www.gyan.dev'), new Error('untrusted redirect'), Object.assign(new Error('disk full'), { code: 'ENOSPC' })]) test(`FFmpeg safety failure does not request a mirror: ${failure.message}`, async t => {
  const root = await workspace(t);
  let calls = 0;
  await assert.rejects(prepareFFmpeg(root, undefined, async () => { calls++; throw failure; }), error => error === failure);
  assert.equal(calls, 1);
});

test('FFmpeg cancellation after primary HTTP failure prevents mirror requests', async t => {
  const root = await workspace(t);
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(withDownloadSignal(controller.signal, () => prepareFFmpeg(root, undefined, async () => {
    calls++; controller.abort(new Error('fixture cancelled between sources')); throw new ReleaseHttpError(503, 'www.gyan.dev');
  })), /fixture cancelled between sources/);
  assert.equal(calls, 1);
});

test('FFmpeg network failure tries the mirror but never retries it', async t => {
  const root = await workspace(t);
  let calls = 0;
  await assert.rejects(prepareFFmpeg(root, undefined, async () => {
    calls++; throw Object.assign(new Error('fixture network failure'), { name: 'DownloadTransportError' });
  }), AggregateError);
  assert.equal(calls, 2);
});

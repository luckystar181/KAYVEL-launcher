import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { FFMPEG_ARCHIVE, FFMPEG_FILES, prepareFFmpeg, verifyFFmpeg } from '../dist/main/prepare-ffmpeg.js';
import { fileDigest } from '../dist/main/official-download.js';
import { acquireGameDirectoryLock } from '../dist/main/installer.js';
import { configureDownloadRequest, withDownloadSignal } from '../dist/main/download-session.js';

const archive = resolve(process.argv[2] ?? '');
assert.equal((await lstat(archive)).size, FFMPEG_ARCHIVE.size);
assert.equal(await fileDigest(archive), FFMPEG_ARCHIVE.hash);
const root = await mkdtemp(join(process.env.LOCALAPPDATA, 'Temp', 'opencode', 'kayvel-ffmpeg-smoke-'));
const game = join(root, 'instance'); await mkdir(game);
const fixtures = ['saves/fixture/level.dat', 'screenshots/fixture.png', 'servers.dat', 'options.txt', 'local-profile.png'];
for (const path of fixtures) {
  const full = join(game, path); await mkdir(resolve(full, '..'), { recursive: true });
  await writeFile(full, 'fictional preserved user bytes: ' + path, { flag: 'wx' });
}
let calls = 0;
configureDownloadRequest(async (url, options) => {
  calls++; assert.equal(url, FFMPEG_ARCHIVE.url); assert.equal(options.redirect, 'manual');
  return new Response(Readable.toWeb(createReadStream(archive)), { headers: { 'content-length': String(FFMPEG_ARCHIVE.size) } });
});
const release = await acquireGameDirectoryLock(game);
try {
  await prepareFFmpeg(game);
  await verifyFFmpeg(game);
  assert.equal(calls, 1);
  configureDownloadRequest(async () => assert.fail('Verified FFmpeg must be reused offline'));
  await prepareFFmpeg(game);
  assert.equal(calls, 1);
  assert.deepEqual((await readdir(join(game, 'vista_ffmpeg_bin'))).sort(), FFMPEG_FILES.map(file => file.name).sort());
  for (const file of FFMPEG_FILES) assert.equal(await fileDigest(join(game, 'vista_ffmpeg_bin', file.name)), file.hash);
  await appendFile(join(game, 'vista_ffmpeg_bin', 'README.txt'), '\nfixture corruption');
  await assert.rejects(prepareFFmpeg(game), /Файл FFmpeg изменён/);
  assert.ok((await readFile(join(game, 'vista_ffmpeg_bin', 'README.txt'), 'utf8')).endsWith('fixture corruption'));
  for (const path of fixtures) assert.equal(await readFile(join(game, path), 'utf8'), 'fictional preserved user bytes: ' + path);
} finally { await release(); }
const cancelled = join(root, 'cancelled'); await mkdir(cancelled);
const controller = new AbortController(); controller.abort(new Error('fixture cancellation'));
await assert.rejects(withDownloadSignal(controller.signal, () => prepareFFmpeg(cancelled)), /fixture cancellation/);
assert.deepEqual(await readdir(cancelled), []);
const result = { root, archiveSha256: FFMPEG_ARCHIVE.hash, requests: calls, passed: ['real ZIP install', 'binary/license hashes', 'offline reuse', 'modified file preserved and blocked', 'worlds/screenshots/settings/profile preserved', 'cancellation before writes'], minecraftStarted: false };
await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FFMPEG_ARCHIVE, FFMPEG_MIRROR_URL, FFMPEG_FILES, ffmpegDownloadUrl, prepareFFmpeg, verifyFFmpeg } from '../dist/main/prepare-ffmpeg.js';
import { withDownloadSignal } from '../dist/main/download-session.js';

async function workspace(t) {
  const root = await mkdtemp(join(process.env.LOCALAPPDATA, 'Temp', 'opencode', 'kayvel-ffmpeg-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const noDownload = async () => assert.fail('No network allowed');

test('FFmpeg pins identical archives on the author HTTPS sources and includes licensing', () => {
  assert.equal(ffmpegDownloadUrl(FFMPEG_MIRROR_URL), FFMPEG_MIRROR_URL);
  const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/306803927/ec41afc5-b8db-4147-92b5-ad9b9672e9b5?fixture=signature';
  assert.equal(ffmpegDownloadUrl(cdn), cdn);
  for (const url of [cdn.replace('306803927', '123'), cdn.replace('https:', 'http:'), cdn + '#fragment', cdn.replace('https://', 'https://user@'), FFMPEG_MIRROR_URL + '?query', FFMPEG_MIRROR_URL.replace('GyanD', 'other')]) assert.throws(() => ffmpegDownloadUrl(url));
  assert.equal(ffmpegDownloadUrl(FFMPEG_ARCHIVE.url), FFMPEG_ARCHIVE.url);
  assert.equal(FFMPEG_ARCHIVE.algorithm, 'sha256');
  assert.match(FFMPEG_ARCHIVE.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(FFMPEG_FILES.map(file => file.name), ['ffmpeg.exe', 'ffprobe.exe', 'LICENSE', 'README.txt']);
  for (const file of FFMPEG_FILES) { assert.match(file.hash, /^[a-f0-9]{64}$/); assert.ok(file.size > 0); }
  for (const url of [FFMPEG_ARCHIVE.url.replace('https:', 'http:'), FFMPEG_ARCHIVE.url + '?x', FFMPEG_ARCHIVE.url + '#x', FFMPEG_ARCHIVE.url.replace('www.gyan.dev', 'evil.invalid')]) assert.throws(() => ffmpegDownloadUrl(url));
});
test('FFmpeg refuses occupied or damaged folders without downloading, overwriting or adopting them', async t => {
  const root = await workspace(t);
  await mkdir(join(root, 'vista_ffmpeg_bin'));
  await writeFile(join(root, 'vista_ffmpeg_bin', 'ffmpeg.exe'), 'keep user executable');
  await writeFile(join(root, 'options.txt'), 'keep options');
  await assert.rejects(prepareFFmpeg(root, undefined, noDownload), /Файл FFmpeg изменён/);
  assert.equal(await readFile(join(root, 'vista_ffmpeg_bin', 'ffmpeg.exe'), 'utf8'), 'keep user executable');
  assert.equal(await readFile(join(root, 'options.txt'), 'utf8'), 'keep options');
  assert.deepEqual((await readdir(root)).sort(), ['options.txt', 'vista_ffmpeg_bin']);
});
test('FFmpeg refuses a linked destination and linked attempt parent without writing outside the instance', async t => {
  const base = await workspace(t);
  const outside = join(base, 'outside');
  await mkdir(outside);
  for (const scenario of ['destination', 'attempts']) {
    const root = join(base, scenario); await mkdir(root);
    if (scenario === 'attempts') await mkdir(join(root, '.kayvel'));
    await symlink(outside, join(root, scenario === 'destination' ? 'vista_ffmpeg_bin' : '.kayvel/ffmpeg-attempts'), 'junction');
    await assert.rejects(prepareFFmpeg(root, undefined, noDownload), /Небезопасный/);
  }
  assert.deepEqual(await readdir(outside), []);
});
test('failed FFmpeg transfer retains separate attempts and personal files, with no installed destination', async t => {
  const root = await workspace(t);
  await writeFile(join(root, 'skin.png'), 'keep skin');
  let calls = 0;
  const fail = async file => { calls++; await writeFile(file.path + '.partial', 'partial archive'); throw new Error('fixture transfer failure'); };
  for (let i = 0; i < 2; i++) await assert.rejects(prepareFFmpeg(root, undefined, fail), /fixture transfer failure/);
  assert.equal(calls, 2);
  const attempts = await readdir(join(root, '.kayvel', 'ffmpeg-attempts'));
  assert.equal(attempts.length, 2);
  for (const attempt of attempts) assert.equal(await readFile(join(root, '.kayvel', 'ffmpeg-attempts', attempt, 'ffmpeg.zip.partial'), 'utf8'), 'partial archive');
  assert.equal(await readFile(join(root, 'skin.png'), 'utf8'), 'keep skin');
  await assert.rejects(verifyFFmpeg(root), { code: 'ENOENT' });
});
test('FFmpeg cannot publish an empty archive or continue after cancellation', async t => {
  const root = await workspace(t);
  const emptyZip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
  await assert.rejects(prepareFFmpeg(root, undefined, async file => writeFile(file.path, emptyZip)), /Неверный файл/);
  const controller = new AbortController(); controller.abort(new Error('fixture cancelled'));
  await assert.rejects(withDownloadSignal(controller.signal, () => prepareFFmpeg(root, undefined, noDownload)), /fixture cancelled/);
  assert.equal((await readdir(join(root, '.kayvel', 'ffmpeg-attempts'))).length, 1);
  await assert.rejects(verifyFFmpeg(root), { code: 'ENOENT' });
});

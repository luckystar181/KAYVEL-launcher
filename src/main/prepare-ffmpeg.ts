import { createHash } from 'node:crypto';
import { lstat, mkdtemp, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareFileDirectory, readZipFiles, writeNewFile } from './install-files.js';
import { downloadNewFile, fileDigest } from './official-download.js';
import { checkDownloadCancelled } from './download-session.js';
import { stageProgress, type ReportProgress } from './preparation-progress.js';
import { ReleaseHttpError } from './release-download.js';

export const FFMPEG_ARCHIVE = {
  url: 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip',
  size: 114768076, hash: '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba', algorithm: 'sha256' as const
};
export const FFMPEG_MIRROR_URL = 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip';
export const FFMPEG_FILES = [
  { name: 'ffmpeg.exe', entry: 'bin/ffmpeg.exe', size: 105423872, hash: '3256173f3f8bffd7df12227c68adf68025edb1832273a9530688a7bb1ed8edec' },
  { name: 'ffprobe.exe', entry: 'bin/ffprobe.exe', size: 105221120, hash: 'f0d36ecbbdd3bcfac3efa078c96c7271c2e68b3810595552ac3b7f17e9a65c52' },
  { name: 'LICENSE', entry: 'LICENSE', size: 35147, hash: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903' },
  { name: 'README.txt', entry: 'README.txt', size: 41577, hash: '0342de6bb39dd421cbec2c00d89ad274b640d75ad3f2cab09ffd647ce2d8f949' }
];
const folder = 'vista_ffmpeg_bin';
const archiveRoot = 'ffmpeg-9.0.2-essentials_build/';

export function ffmpegDownloadUrl(value: string): string {
  if (value === FFMPEG_ARCHIVE.url || value === FFMPEG_MIRROR_URL) return value;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'release-assets.githubusercontent.com' ||
      url.username || url.password || url.port || url.hash ||
      !/^\/github-production-release-asset\/306803927\/[a-f0-9-]{36}$/.test(url.pathname)) {
    throw new Error('Недоверенный адрес FFmpeg.');
  }
  return url.href;
}

function sourceUnavailable(error: unknown): boolean {
  return error instanceof ReleaseHttpError && (error.status >= 500 && error.status <= 599 || [408, 429].includes(error.status)) ||
    error instanceof Error && error.name === 'DownloadTransportError';
}

async function directory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Небезопасный каталог FFmpeg: ' + path);
}

export async function verifyFFmpeg(root: string): Promise<void> {
  await directory(root);
  await directory(join(root, folder));
  for (const file of FFMPEG_FILES) {
    checkDownloadCancelled();
    const path = join(root, folder, file.name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== file.size || await fileDigest(path) !== file.hash) {
      throw new Error('Файл FFmpeg изменён. Сохраните vista_ffmpeg_bin отдельно для проверки; автоматическая перезапись отключена: ' + file.name);
    }
  }
}

// Caller holds the game-directory lock. Publish both binaries together; failed attempts are retained separately.
export async function prepareFFmpeg(root: string, report: ReportProgress = () => {}, download = downloadNewFile): Promise<void> {
  checkDownloadCancelled();
  await directory(root);
  let present = false;
  try { await lstat(join(root, folder)); present = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (present) { await verifyFFmpeg(root); return; }
  await prepareFileDirectory(root, '.kayvel/ffmpeg-attempts/placeholder');
  const attempt = await mkdtemp(join(root, '.kayvel', 'ffmpeg-attempts', '9.0.2-'));
  let archive = join(attempt, 'ffmpeg.zip');
  stageProgress(report, 'verify', 'Подготовка FFmpeg и FFprobe для Vista');
  const progress = (received: number, total: number) => {
    report({ stage: 'modpack', file: 'FFmpeg 9.0.2 (Vista)', received, total, completedFiles: 0, totalFiles: 1 });
  };
  try {
    await download({ ...FFMPEG_ARCHIVE, path: archive }, progress, ffmpegDownloadUrl);
  } catch (error) {
    checkDownloadCancelled();
    if (!sourceUnavailable(error)) throw error;
    archive = join(attempt, 'ffmpeg-github.zip');
    stageProgress(report, 'verify', 'Основной сервер FFmpeg недоступен; резервная загрузка автора с GitHub');
    try {
      await download({ ...FFMPEG_ARCHIVE, url: FFMPEG_MIRROR_URL, path: archive }, progress, ffmpegDownloadUrl);
    } catch (fallbackError) {
      checkDownloadCancelled();
      throw new AggregateError([error, fallbackError], 'Не удалось загрузить FFmpeg с основного и резервного серверов.', { cause: fallbackError });
    }
  }
  checkDownloadCancelled();
  const selected = new Set(FFMPEG_FILES.map(file => archiveRoot + file.entry));
  const files = await readZipFiles(archive, name => selected.has(name), 220_000_000);
  for (const file of FFMPEG_FILES) {
    const bytes = files.get(archiveRoot + file.entry);
    if (!bytes || bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.hash) throw new Error('Неверный файл в архиве FFmpeg: ' + file.name);
    checkDownloadCancelled();
    await writeNewFile(attempt, folder + '/' + file.name, bytes);
  }
  await verifyFFmpeg(attempt);
  checkDownloadCancelled();
  // A new destination must not have appeared while downloading.
  try { await lstat(join(root, folder)); throw new Error('Каталог Vista уже появился; файлы не изменены.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await rename(join(attempt, folder), join(root, folder));
}

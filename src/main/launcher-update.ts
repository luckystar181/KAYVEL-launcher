import { createPublicKey, verify } from 'node:crypto';
import { lstat, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareFileDirectory } from './install-files.js';
import { downloadNewFile, fileDigest, type ByteProgress } from './official-download.js';
import { readReleaseBody, ReleaseHttpError, withTrustedDownload } from './release-download.js';
import { checkDownloadCancelled } from './download-session.js';

export const LAUNCHER_RELEASES = 'https://github.com/luckystar181/KAYVEL-launcher/releases';
const metadata = 'launcher-update.json';
export type LauncherManifest = { schemaVersion: 1; version: string; platform: 'win32-x64'; size: number; sha256: string; url: string };
export type SignedLauncher = { manifest: LauncherManifest; bytes: Buffer; signature: string };

function versionParts(value: string): number[] {
  const match = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(?:-diagnostic\.[1-9][0-9]{0,5})?$/.exec(value);
  if (!match) throw new Error('Неподдерживаемая версия лаунчера.');
  return match.slice(1, 4).map(Number);
}
export function compareLauncherVersions(left: string, right: string): number {
  const a = versionParts(left), b = versionParts(right);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return Math.sign(a[index] - b[index]);
  return Number(!left.includes('-')) - Number(!right.includes('-'));
}
function stableVersion(value: unknown): string {
  if (typeof value !== 'string' || value.includes('-')) throw new Error('Обновление должно быть стабильным выпуском лаунчера.');
  versionParts(value);
  return value;
}
export function launcherDownloadUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !['github.com', 'release-assets.githubusercontent.com'].includes(url.hostname) ||
      (url.hostname === 'github.com' && (url.search || !url.href.startsWith(LAUNCHER_RELEASES + '/download/') && url.href !== LAUNCHER_RELEASES + '/latest/download/' + metadata))) {
    throw new Error('Недоверенный адрес обновления лаунчера.');
  }
  return url.href;
}
export function validateLauncher(bytes: Buffer, signature: string, publicKey: string): SignedLauncher {
  const key = createPublicKey(publicKey);
  const sig = Buffer.from(signature.trim(), 'base64');
  if (bytes.length > 16_384 || key.asymmetricKeyType !== 'ed25519' || sig.length !== 64 || !verify(null, bytes, key, sig)) throw new Error('Подпись обновления лаунчера недействительна.');
  const data = JSON.parse(bytes.toString('utf8')) as LauncherManifest;
  if (!data || data.schemaVersion !== 1 || data.platform !== 'win32-x64' || !Number.isSafeInteger(data.size) || data.size < 1 || data.size > 1_000_000_000 || typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.sha256)) throw new Error('Неверный манифест обновления лаунчера.');
  const version = stableVersion(data.version);
  if (data.url !== `${LAUNCHER_RELEASES}/download/v${version}-v3S/KAYVEL-Setup-v3S.exe`) throw new Error('Установщик должен принадлежать подписанному выпуску KAYVEL.');
  return { manifest: data, bytes, signature };
}
export async function discoverLauncher(publicKey: string): Promise<SignedLauncher | null> {
  const download = (url: string, limit: number) => withTrustedDownload(url, launcherDownloadUrl, async (response, signal) => {
    const chunks: Uint8Array[] = [];
    const size = await readReleaseBody(response, limit, signal, chunk => { chunks.push(chunk); });
    return Buffer.concat(chunks, size);
  }, { timeoutMs: 20_000 });
  let bytes: Buffer;
  try {
    bytes = await download(`${LAUNCHER_RELEASES}/latest/download/${metadata}`, 16_384);
  } catch (error) {
    if (error instanceof ReleaseHttpError && error.status === 404 && error.hostname === 'github.com') return null;
    throw error;
  }
  const version = stableVersion((JSON.parse(bytes.toString('utf8')) as LauncherManifest)?.version);
  const signature = (await download(`${LAUNCHER_RELEASES}/download/v${version}-v3S/${metadata}.sig`, 1024)).toString('utf8');
  return validateLauncher(bytes, signature, publicKey);
}
export async function stageLauncherUpdate(userData: string, candidate: SignedLauncher, publicKey: string,
    currentVersion: string, progress: ByteProgress = () => {}, download = downloadNewFile): Promise<string> {
  const { manifest } = validateLauncher(candidate.bytes, candidate.signature, publicKey);
  if (compareLauncherVersions(manifest.version, currentVersion) <= 0) throw new Error('Откат или повторная установка лаунчера запрещены.');
  checkDownloadCancelled();
  await prepareFileDirectory(userData, 'launcher-updates/placeholder');
  const attempt = await mkdtemp(join(userData, 'launcher-updates', manifest.version + '-'));
  await writeFile(join(attempt, metadata), candidate.bytes, { flag: 'wx' });
  await writeFile(join(attempt, metadata + '.sig'), candidate.signature, { flag: 'wx' });
  const path = join(attempt, 'KAYVEL-Setup-v3S.exe');
  await download({ path, url: manifest.url, size: manifest.size, hash: manifest.sha256, algorithm: 'sha256' }, progress, launcherDownloadUrl);
  checkDownloadCancelled();
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== manifest.size || await fileDigest(path) !== manifest.sha256) throw new Error('Скачанный установщик изменён; запуск запрещён.');
  return path;
}

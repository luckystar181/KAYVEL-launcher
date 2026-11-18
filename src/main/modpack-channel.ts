import { verifyManifest, type Manifest } from './manifest.js';
import { readReleaseBody, releaseDownloadUrl, withTrustedDownload } from './release-download.js';

export type SignedModpack = { manifest: Manifest; bytes: Buffer; signature: string };
export type { ModpackUpdateStatus } from './modpack-update-status.js';

export function compareModpackVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})-v3S$/.exec(value);
    if (!match) throw new Error('Неподдерживаемая версия сборки; нужен совместимый выпуск vX.Y.Z-v3S.');
    return match.slice(1).map(Number);
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return Math.sign(a[index] - b[index]);
  return 0;
}

export function modpackReleaseUrl(pinnedUrl: string, version: string): string {
  compareModpackVersions(version, version);
  const pinned = new URL(releaseDownloadUrl(pinnedUrl));
  if (pinned.hostname !== 'github.com' || !pinned.pathname.endsWith('/manifest.json') || pinned.search) throw new Error('Неверный адрес канала сборки.');
  const match = /^(\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/releases\/download\/[^/]+\/manifest\.json$/.exec(pinned.pathname);
  if (!match) throw new Error('Неверный адрес канала сборки.');
  return `https://github.com${match[1]}/releases/download/${version}/manifest.json`;
}

export async function discoverModpack(pinnedUrl: string, publicKey: string): Promise<SignedModpack> {
  const canonical = modpackReleaseUrl(pinnedUrl, 'v0.0.0-v3S');
  const prefix = canonical.split('/releases/download/')[0];
  const latest = `${prefix}/releases/latest/download/manifest.json`;
  const download = async (url: string, limit: number) => withTrustedDownload(url, value => {
    const parsed = new URL(value);
    if (parsed.href === latest || parsed.href === latest + '.sig') return parsed.href;
    const trusted = releaseDownloadUrl(value);
    if (parsed.hostname === 'github.com' && (!trusted.startsWith(prefix + '/releases/download/') || parsed.search)) throw new Error('Обновление перенаправлено в другой репозиторий.');
    return trusted;
  }, async (response, signal) => {
    const chunks: Uint8Array[] = [];
    const size = await readReleaseBody(response, limit, signal, chunk => { chunks.push(chunk); });
    return Buffer.concat(chunks, size);
  }, { timeoutMs: 20_000 });
  const bytes = await download(latest, 1_000_000);
  const untrusted = JSON.parse(bytes.toString('utf8')) as { buildVersion?: unknown };
  if (typeof untrusted?.buildVersion !== 'string') throw new Error('Неверная версия обновления.');
  // The signature is fetched by immutable tag, not "latest", which could move between requests.
  const url = modpackReleaseUrl(pinnedUrl, untrusted.buildVersion);
  const signature = (await download(url + '.sig', 1024)).toString('utf8');
  return validateModpack(bytes, signature, publicKey, pinnedUrl);
}

export function validateModpack(bytes: Buffer, signature: string, publicKey: string, pinnedUrl: string): SignedModpack {
  const manifest = verifyManifest(bytes, signature, publicKey);
  const url = modpackReleaseUrl(pinnedUrl, manifest.buildVersion);
  const releasePrefix = url.slice(0, -'manifest.json'.length);
  if (!manifest.files.length || manifest.files.some(file => {
    const asset = new URL(file.url);
    return !asset.href.startsWith(releasePrefix) || asset.search || asset.hash;
  })) throw new Error('Файлы обновления должны принадлежать тому же выпуску сборки.');
  const pinnedVersion = /\/download\/([^/]+)\//.exec(pinnedUrl)![1];
  if (compareModpackVersions(manifest.buildVersion, pinnedVersion) < 0) throw new Error('Сервер предлагает устаревшую сборку; откат запрещён.');
  return { manifest, bytes, signature };
}

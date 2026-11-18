import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readReleaseBody, withTrustedDownload } from './release-download.js';

const officialHosts = new Set(['piston-meta.mojang.com', 'piston-data.mojang.com', 'resources.download.minecraft.net', 'libraries.minecraft.net', 'maven.neoforged.net']);
export function officialDownloadUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !officialHosts.has(url.hostname) || url.username || url.password || url.port || url.hash) {
    throw new Error('Недоверенный адрес загрузки Minecraft/NeoForge.');
  }
  return url.href;
}

export type DownloadFile = { path: string; url: string; size: number; hash: string; algorithm: 'sha1' | 'sha256' };
export type ByteProgress = (received: number, total: number) => void;

export async function fileDigest(path: string, algorithm: 'sha1' | 'sha256' = 'sha256'): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function downloadOfficialBytes(url: string, limit: number): Promise<Buffer> {
  return withTrustedDownload(url, officialDownloadUrl, async (response, signal) => {
    const chunks: Uint8Array[] = [];
    const size = await readReleaseBody(response, limit, signal, chunk => { chunks.push(chunk); });
    return Buffer.concat(chunks, size);
  });
}

export async function downloadNewFile(file: DownloadFile, progress: ByteProgress = () => {},
    validateUrl = officialDownloadUrl): Promise<void> {
  validateUrl(file.url);
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > 1_000_000_000 ||
      !new RegExp(file.algorithm === 'sha1' ? '^[a-f0-9]{40}$' : '^[a-f0-9]{64}$').test(file.hash)) throw new Error('Неверные данные загрузки.');
  try {
    await lstat(file.path);
    throw new Error('Путь уже занят; перезапись отключена: ' + file.path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(dirname(file.path), { recursive: true });
  const handle = await open(file.path, 'wx', 0o600);
  try {
    const hash = createHash(file.algorithm);
    let received = 0;
    progress(0, file.size);
    await withTrustedDownload(file.url, validateUrl, async (response, signal) => {
      const size = await readReleaseBody(response, file.size, signal, async chunk => {
        let offset = 0;
        while (offset < chunk.byteLength) {
          signal.throwIfAborted();
          const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
          if (!bytesWritten) throw new Error('Не удалось записать скачанный файл.');
          offset += bytesWritten;
        }
        hash.update(chunk);
        received += chunk.byteLength;
        progress(received, file.size);
      });
      if (size !== file.size || hash.digest('hex') !== file.hash) throw new Error('Контрольная сумма или размер загрузки не совпадает.');
      await handle.sync();
    });
  } finally { await handle.close(); }
}

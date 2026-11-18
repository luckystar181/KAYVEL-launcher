import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { checkDownloadCancelled } from './download-session.js';

export const BUNDLED_JAVA_SIZE = 49_106_397;
export const BUNDLED_JAVA_SHA256 = '2332c0b4cff6bed722da3567c91d5e47568bcba863fa4945d0a8d6fc76158628';
export const BUNDLED_JAVA_ROOT = 'jdk-21.0.13+9-jre';
export const BUNDLED_JAVA_URL = 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jre_x64_windows_hotspot_21.0.13_9.zip';

export async function readBundledJava(path: string | URL = new URL('../../bundled/java.zip', import.meta.url)): Promise<Buffer> {
  checkDownloadCancelled();
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error('В комплекте нет архива Java. Скачайте новый установщик KAYVEL.', { cause: error });
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink() || info.size !== BUNDLED_JAVA_SIZE) throw new Error('Неверный размер встроенного архива Java. Скачайте новый установщик KAYVEL.');
  const bytes = await readFile(path);
  checkDownloadCancelled();
  if (bytes.length !== BUNDLED_JAVA_SIZE || createHash('sha256').update(bytes).digest('hex') !== BUNDLED_JAVA_SHA256) throw new Error('Встроенный архив Java не прошёл проверку SHA-256. Скачайте новый установщик KAYVEL.');
  return bytes;
}

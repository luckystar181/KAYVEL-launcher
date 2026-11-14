import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { findJava21 } from './vanilla.js';

const execFileAsync = promisify(execFile);
const URL = 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jre_x64_windows_hotspot_21.0.13_9.zip';
const SIZE = 49106397;
const SHA256 = '2332c0b4cff6bed722da3567c91d5e47568bcba863fa4945d0a8d6fc76158628';
const FOLDER = 'jdk-21.0.13+9-jre';

export function managedJavaPath(root: string): string {
  return join(root, 'java', 'temurin-21.0.13+9', FOLDER, 'bin', 'java.exe');
}

export function validJava21(path: string): boolean {
  const result = spawnSync(path, ['-version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  return result.status === 0 && /version "21(?:\.|\")/.test(`${result.stdout ?? ''}${result.stderr ?? ''}`);
}

export function availableJava21(root: string): string | null {
  const managed = managedJavaPath(root);
  return validJava21(managed) ? managed : findJava21();
}

export async function ensureJava21(root: string): Promise<string> {
  return availableJava21(root) ?? await installManagedJava21(root);
}

export async function installManagedJava21(root: string): Promise<string> {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Автоматическая установка Java доступна только для Windows x64.');
  const parent = join(root, 'java');
  const target = join(parent, 'temurin-21.0.13+9');
  const temp = join(parent, `.download-${randomUUID()}`);
  const archive = join(temp, 'java.zip');
  const extracted = join(temp, 'extracted');
  await mkdir(extracted, { recursive: true });
  try {
    const response = await fetch(URL, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) throw new Error(`Ошибка загрузки Java: HTTP ${response.status}.`);
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > SIZE) throw new Error('Размер архива Java не совпадает.');
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    if (length !== SIZE || createHash('sha256').update(bytes).digest('hex') !== SHA256) throw new Error('Контрольная сумма Java не совпадает.');
    await writeFile(archive, bytes);
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:KAYVEL_JAVA_ARCHIVE -DestinationPath $env:KAYVEL_JAVA_DEST -ErrorAction Stop'], {
      env: { ...process.env, KAYVEL_JAVA_ARCHIVE: archive, KAYVEL_JAVA_DEST: extracted }, windowsHide: true, timeout: 180000,
    });
    const candidate = join(extracted, FOLDER, 'bin', 'java.exe');
    if (!validJava21(candidate)) throw new Error('Скачанная Java 21 не запускается.');
    const targetExists = await access(target).then(() => true, () => false);
    if (targetExists && !validJava21(managedJavaPath(root))) {
      await rename(target, join(parent, `.invalid-${randomUUID()}`));
    }
    try { await rename(extracted, target); }
    catch (error) {
      if (!validJava21(managedJavaPath(root))) throw error;
    }
    return managedJavaPath(root);
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 200) : 'Неизвестная ошибка';
    throw new Error(`Не удалось автоматически установить Java 21: ${detail}. Проверьте интернет и повторите попытку.`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

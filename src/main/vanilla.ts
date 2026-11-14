import { launch } from '@xmcl/core';
import { getVersionList, installLibraries, installVersion } from '@xmcl/installer';
import { resolveAgent } from '@xmcl/file-transfer';
import { Agent } from 'undici';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { link, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { sameKnownFile } from './file-identity.js';
import { assertGamePreparationAllowed } from './game-preparation.js';
import { dirname, join } from 'node:path';

export const VANILLA_VERSION = '1.21.1';

export function validateNickname(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(value)) {
    throw new Error('Имя игрока: 3–16 символов, только латинские буквы, цифры и _.');
  }
  return value;
}

export function offlineUUID(name: string): string {
  const bytes = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function javaCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  if (env.JAVA_HOME) candidates.push(join(env.JAVA_HOME, 'bin', 'java.exe'));
  for (const base of [env.ProgramFiles, env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')]) {
    if (!base) continue;
    const adoptium = join(base, 'Eclipse Adoptium');
    if (!existsSync(adoptium)) continue;
    for (const folder of readdirSync(adoptium)) candidates.push(join(adoptium, folder, 'bin', 'java.exe'));
  }
  candidates.push('java.exe');
  return candidates;
}

export function findJava21(): string | null {
  for (const candidate of javaCandidates()) {
    const result = spawnSync(candidate, ['-version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const version = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status === 0 && /version "21(?:\.|\")/.test(version)) return candidate;
  }
  return null;
}

async function sha1File(path: string): Promise<string> {
  const hash = createHash('sha1');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function existingFile(path: string) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function downloadVerified(url: string, destination: string, size: number, hash: string): Promise<void> {
  if (!Number.isSafeInteger(size) || size < 0 || size > 50_000_000 || !/^[a-f0-9]{40}$/.test(hash)) {
    throw new Error('Некорректные данные для загрузки Minecraft.');
  }
  const existing = await existingFile(destination);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== BigInt(size) || await sha1File(destination) !== hash) {
      throw new Error('Существующий файл Minecraft отличается; автоматическое восстановление отключено: ' + destination);
    }
    const after = await existingFile(destination);
    if (!after || !after.isFile() || after.isSymbolicLink() || !sameKnownFile(existing, after) || after.size !== BigInt(size)) {
      throw new Error('Существующий файл Minecraft изменился при проверке: ' + destination);
    }
    return;
  }

  await mkdir(dirname(destination), { recursive: true });
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Ошибка загрузки Minecraft: HTTP ${response.status}.`);
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > size) throw new Error('Размер скачанного файла Minecraft превышает ожидаемый.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = Buffer.concat(chunks, length);
  if (length !== size || createHash('sha1').update(bytes).digest('hex') !== hash) {
    throw new Error('Контрольная сумма скачанного файла не совпадает.');
  }

  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  const before = await lstat(temporary, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || !sameKnownFile(before, before) || before.nlink !== 1n || before.size !== BigInt(size) || await sha1File(temporary) !== hash) {
    throw new Error('Временный файл изменён; сохранён для ручной проверки: ' + temporary);
  }
  try { await link(temporary, destination); }
  catch {
    throw new Error('Не удалось разместить файл без перезаписи; временный файл сохранён для ручной проверки: ' + temporary);
  }
  const sourceAfter = await lstat(temporary, { bigint: true });
  const targetAfter = await lstat(destination, { bigint: true });
  if (!sourceAfter.isFile() || sourceAfter.isSymbolicLink() || !targetAfter.isFile() || targetAfter.isSymbolicLink() ||
      !sameKnownFile(before, sourceAfter) || !sameKnownFile(before, targetAfter) || sourceAfter.nlink !== 2n || targetAfter.nlink !== 2n ||
      sourceAfter.size !== BigInt(size) || targetAfter.size !== BigInt(size) || await sha1File(destination) !== hash) {
    throw new Error('Размещение прервано; оба файла сохранены для ручной проверки: ' + temporary);
  }
  await unlink(temporary);
}

async function installOfficialAssets(directory: string, index: { id: string; url: string; sha1: string; size: number }): Promise<void> {
  if (!/^[A-Za-z0-9._-]{1,50}$/.test(index.id)) throw new Error('Неверный идентификатор индекса Minecraft.');
  const indexPath = join(directory, 'assets', 'indexes', `${index.id}.json`);
  await downloadVerified(index.url, indexPath, index.size, index.sha1);
  const parsed: unknown = JSON.parse(await readFile(indexPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !('objects' in parsed) || !parsed.objects || typeof parsed.objects !== 'object') {
    throw new Error('Неверный индекс ресурсов Minecraft.');
  }
  const objects = Object.values(parsed.objects) as Array<{ hash: string; size: number }>;
  if (objects.length > 10000) throw new Error('Слишком большой индекс ресурсов Minecraft.');
  const unique = new Map<string, number>();
  for (const asset of objects) {
    if (!asset || !/^[a-f0-9]{40}$/.test(asset.hash) || !Number.isSafeInteger(asset.size) || asset.size < 0 || asset.size > 50_000_000) {
      throw new Error('Некорректная запись ресурса Minecraft.');
    }
    unique.set(asset.hash, asset.size);
  }
  const queue = [...unique];
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < queue.length) {
      const [hash, size] = queue[next++];
      const path = join(directory, 'assets', 'objects', hash.slice(0, 2), hash);
      await downloadVerified(`https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`, path, size, hash);
    }
  }));
}

export function createMinecraftDownloadAgent() {
  const dispatcher = new Agent();
  return { dispatcher, agent: resolveAgent({ dispatcher, retryHandler: { retry: () => false } }) };
}

export async function installVanilla(directory: string): Promise<void> {
  assertGamePreparationAllowed();
  const { dispatcher, agent } = createMinecraftDownloadAgent();
  try {
    const metadata = await getVersionList({ dispatcher });
    const version = metadata.versions.find(entry => entry.id === VANILLA_VERSION && entry.type === 'release');
    if (!version) throw new Error('Официальная версия Minecraft 1.21.1 не найдена.');
    const resolved = await installVersion(version, directory, { agent });
    await installLibraries(resolved, { agent, librariesDownloadConcurrency: 4 });
    const log = resolved.logging?.client?.file;
    if (log) {
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(log.id)) throw new Error('Неверное имя конфигурации журналирования.');
      await downloadVerified(log.url, join(directory, 'assets', 'log_configs', log.id), log.size, log.sha1);
    }
    if (!resolved.assetIndex) throw new Error('У версии Minecraft отсутствует индекс ресурсов.');
    await installOfficialAssets(directory, resolved.assetIndex);
  } finally {
    await dispatcher.close();
  }
}

export async function launchVanilla(directory: string, name: string, javaPath: string) {
  return launch({
    gamePath: directory,
    resourcePath: directory,
    version: VANILLA_VERSION,
    javaPath,
    gameProfile: { name: validateNickname(name), id: offlineUUID(name) },
    accessToken: '0',
    userType: 'legacy',
    launcherName: 'KAYVEL',
    extraExecOption: { windowsHide: false, stdio: 'ignore' }
  });
}

import { Version } from '@xmcl/core';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { downloadOfficialBytes } from './official-download.js';
import { safeRelativePath } from './install-files.js';
import { PreparationFiles, type PlannedDownload } from './preparation-files.js';
import { stageProgress, type ReportProgress } from './preparation-progress.js';
import { VANILLA_VERSION } from './vanilla.js';

type Artifact = { url: string; size: number; sha1: string };
export type MinecraftMetadata = Version & {
  downloads: { client: Artifact; client_mappings: Artifact };
  assetIndex: Artifact & { id: string };
  logging?: { client?: { file: Artifact & { id: string } } };
};
const metadataHash = '9aa86ea608c3ec777dcdc09e6c5a06c85b53599e';
const metadataUrl = `https://piston-meta.mojang.com/v1/packages/${metadataHash}/1.21.1.json`;

export function artifactDownload(path: string, artifact: Artifact): PlannedDownload {
  if (!artifact || typeof artifact.url !== 'string' || !Number.isSafeInteger(artifact.size) || artifact.size < 0 ||
      artifact.size > 1_000_000_000 || !/^[a-f0-9]{40}$/.test(artifact.sha1)) throw new Error('Неверная запись официального файла.');
  return { path: safeRelativePath(path), url: artifact.url, size: artifact.size, hash: artifact.sha1, algorithm: 'sha1' };
}

export function libraryDownloads(libraries: Version['libraries']): PlannedDownload[] {
  if (!Array.isArray(libraries) || libraries.length > 2000) throw new Error('Неверный список библиотек.');
  return Version.resolveLibraries(libraries).map(library => artifactDownload('libraries/' + safeRelativePath(library.download.path), library.download));
}

export function assetDownloads(index: unknown): PlannedDownload[] {
  if (!index || typeof index !== 'object' || !('objects' in index) || !index.objects || typeof index.objects !== 'object' || Array.isArray(index.objects)) throw new Error('Неверный индекс ресурсов.');
  const objects = Object.values(index.objects) as { hash: string; size: number }[];
  if (objects.length > 20_000) throw new Error('Слишком большой индекс ресурсов.');
  return objects.map(asset => {
    if (!asset || !/^[a-f0-9]{40}$/.test(asset.hash)) throw new Error('Неверный ресурс Minecraft.');
    return artifactDownload(`assets/objects/${asset.hash.slice(0, 2)}/${asset.hash}`, {
      url: `https://resources.download.minecraft.net/${asset.hash.slice(0, 2)}/${asset.hash}`, size: asset.size, sha1: asset.hash
    });
  });
}

export async function prepareMinecraft(files: PreparationFiles, report: ReportProgress): Promise<MinecraftMetadata> {
  stageProgress(report, 'minecraft', 'Метаданные Minecraft 1.21.1');
  const bytes = await downloadOfficialBytes(metadataUrl, 2_000_000);
  if (createHash('sha1').update(bytes).digest('hex') !== metadataHash) throw new Error('Метаданные Minecraft не прошли проверку.');
  const metadata = JSON.parse(bytes.toString('utf8')) as MinecraftMetadata;
  if (metadata.id !== VANILLA_VERSION || metadata.javaVersion?.majorVersion !== 21) throw new Error('Неподдерживаемая версия Minecraft или Java.');
  await files.write(`versions/${VANILLA_VERSION}/${VANILLA_VERSION}.json`, bytes);
  const plan = [artifactDownload(`versions/${VANILLA_VERSION}/${VANILLA_VERSION}.jar`, metadata.downloads.client),
    artifactDownload(`assets/indexes/${safeRelativePath(metadata.assetIndex.id)}.json`, metadata.assetIndex),
    ...libraryDownloads(metadata.libraries)];
  const log = metadata.logging?.client?.file;
  if (log) plan.push(artifactDownload('assets/log_configs/' + safeRelativePath(log.id), log));
  await files.downloads(plan, 'minecraft', report);
  const index = JSON.parse(await readFile(files.path(`assets/indexes/${metadata.assetIndex.id}.json`), 'utf8')) as unknown;
  await files.downloads(assetDownloads(index), 'minecraft', report);
  return metadata;
}

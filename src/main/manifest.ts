import { createPublicKey, verify } from 'node:crypto';

export interface ManagedFile {
  path: string;
  size: number;
  sha256: string;
  url: string;
}

export interface Manifest {
  schemaVersion: 1;
  buildVersion: string;
  minecraftVersion: '1.21.1';
  neoforgeVersion: '21.1.252';
  files: ManagedFile[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function releaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port &&
      /^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/releases\/download\/[^/]+\/[^/]+$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function validManagedPath(value: string): boolean {
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?: *\.| *$)/i.test(part))) return false;
  if (parts.length === 2) {
    const [directory, name] = parts;
    const validName = directory === 'mods' ? /^[A-Za-z0-9._+\[\]-]+\.jar$/.test(name)
      : directory === 'resourcepacks' && /^[A-Za-z0-9._+ \[\]-]+\.zip$/.test(name);
    return validName && !name.endsWith(' .jar') && !name.endsWith(' .zip');
  }
  return /^kubejs\/(?:client_scripts|startup_scripts)\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.js$/.test(value) ||
    /^kubejs\/config\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.json$/.test(value) ||
    /^kubejs\/assets\/kubejs\/textures\/(?:block|item)\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.png$/.test(value);
}

export function verifyManifest(bytes: Buffer, signatureBase64: string, publicKeyPem: string): Manifest {
  if (bytes.length > 1_000_000 || !publicKeyPem) throw new Error('Manifest configuration is missing or too large');
  const signature = Buffer.from(signatureBase64.trim(), 'base64');
  if (signature.length !== 64 || !verify(null, bytes, createPublicKey(publicKeyPem), signature)) {
    throw new Error('Manifest signature is invalid');
  }
  const data: unknown = JSON.parse(bytes.toString('utf8'));
  if (!record(data) || data.schemaVersion !== 1 || data.minecraftVersion !== '1.21.1' ||
      data.neoforgeVersion !== '21.1.252' || typeof data.buildVersion !== 'string' ||
      !/^[a-zA-Z0-9._-]{1,64}$/.test(data.buildVersion) || !Array.isArray(data.files) ||
      data.files.length > 2000) throw new Error('Unsupported manifest');

  let total = 0;
  const paths = new Set<string>();
  for (const item of data.files) {
    if (!record(item) || typeof item.path !== 'string' || typeof item.url !== 'string' ||
        typeof item.sha256 !== 'string' || typeof item.size !== 'number' ||
        !validManagedPath(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256) ||
        !Number.isSafeInteger(item.size) || item.size < 1 || item.size > 1_000_000_000 ||
        !releaseUrl(item.url)) throw new Error('Invalid managed file');
    const key = item.path.toLowerCase();
    if (paths.has(key)) throw new Error('Duplicate managed path');
    paths.add(key);
    total += item.size;
    if (total > 2_000_000_000) throw new Error('Manifest exceeds size limit');
  }
  return data as unknown as Manifest;
}

export function validReleaseUrl(value: string): boolean {
  return releaseUrl(value);
}

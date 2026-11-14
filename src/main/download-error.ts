import { DownloadAggregateError, DownloadError } from '@xmcl/file-transfer';

const MINECRAFT_DOWNLOAD_HOSTS = new Set([
  'launchermeta.mojang.com',
  'launcher.mojang.com',
  'piston-meta.mojang.com',
  'piston-data.mojang.com',
  'libraries.minecraft.net',
  'resources.download.minecraft.net',
  'repo1.maven.org'
]);

const SAFE_ERROR_CODES = new Set([
  'EACCES', 'EPERM', 'ENOSPC', 'EDQUOT', 'EROFS', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EMFILE', 'ENFILE', 'EIO', 'ENAMETOOLONG', 'EBUSY',
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN',
  'EHOSTDOWN', 'ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EPIPE',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'UND_ERR_ABORTED', 'UND_ERR_ABORT', 'UND_ERR_RESPONSE_STATUS_CODE', 'UND_ERR_RES_EXCEEDED_MAX_SIZE',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH'
]);

export function describeMinecraftDownloadError(error: unknown): string | null {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  const hosts = new Set<string>();
  const statuses = new Set<number>();
  const codes = new Set<string>();
  let downloadError = false;
  let checksumError = false;

  while (pending.length && seen.size < 128) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const detail = current as { name?: unknown; code?: unknown; statusCode?: unknown; urls?: unknown; errors?: unknown; cause?: unknown; error?: unknown };

    if (current instanceof DownloadAggregateError || current instanceof DownloadError) {
      downloadError = true;
      if (Array.isArray(detail.urls)) {
        for (const value of detail.urls.slice(0, 10)) {
          if (typeof value !== 'string') continue;
          try {
            const url = new URL(value);
            if (url.protocol === 'https:' && !url.username && !url.password && MINECRAFT_DOWNLOAD_HOSTS.has(url.hostname)) hosts.add(url.hostname);
          } catch {}
        }
      }
    }
    if (detail.name === 'ChecksumNotMatchError') checksumError = true;
    if (typeof detail.statusCode === 'number' && Number.isInteger(detail.statusCode) && detail.statusCode >= 100 && detail.statusCode <= 599) statuses.add(detail.statusCode);
    if (typeof detail.code === 'string' && SAFE_ERROR_CODES.has(detail.code)) codes.add(detail.code);
    if (Array.isArray(detail.errors)) pending.push(...detail.errors.slice(0, 128));
    if (detail.cause) pending.push(detail.cause);
    if (detail.error) pending.push(detail.error);
  }

  if (!downloadError) return null;
  const parts: string[] = [];
  if (hosts.size) parts.push(`сервер: ${[...hosts].slice(0, 2).join(', ')}`);
  if (statuses.size) parts.push(`HTTP: ${[...statuses].slice(0, 2).join(', ')}`);
  if (codes.size) parts.push(`код: ${[...codes].slice(0, 2).join(', ')}`);
  if (checksumError) parts.push('не совпала контрольная сумма');
  return `Не удалось скачать компоненты Minecraft.${parts.length ? ` ${parts.join('; ')}.` : ' Подробности ошибки недоступны.'}`;
}

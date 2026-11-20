import { validReleaseUrl } from './manifest.js';
import { currentDownloadRequest, downloadSignal } from './download-session.js';

type DownloadOptions = { request?: typeof fetch; timeoutMs?: number; idleTimeoutMs?: number };
const downloadTimeoutMs = 60 * 60_000;
const downloadIdleTimeoutMs = 180_000;
const downloadActivity = new WeakMap<AbortSignal, (bytes: number) => void>();
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const transportReasons: Record<string, string> = {
  ENOTFOUND: 'Не удалось определить адрес сервера (DNS).',
  EAI_AGAIN: 'Сервер DNS временно недоступен.',
  ECONNRESET: 'Соединение с сервером было сброшено.',
  ECONNREFUSED: 'Сервер отклонил соединение.',
  ENETUNREACH: 'Сеть недоступна.',
  EHOSTUNREACH: 'Сервер недоступен.',
  ETIMEDOUT: 'Истекло время ожидания соединения.',
  UND_ERR_CONNECT_TIMEOUT: 'Истекло время ожидания соединения.',
  UND_ERR_HEADERS_TIMEOUT: 'Сервер не прислал ответ вовремя.',
  UND_ERR_BODY_TIMEOUT: 'Сервер перестал передавать файл.',
  UND_ERR_SOCKET: 'Соединение оборвалось при передаче данных.',
  ERR_CONNECTION_TIMED_OUT: 'Истекло время ожидания соединения.',
  ERR_TIMED_OUT: 'Истекло время ожидания ответа сервера.',
  ERR_NAME_NOT_RESOLVED: 'Не удалось определить адрес сервера (DNS).',
  ERR_CONNECTION_RESET: 'Соединение с сервером было сброшено.',
  ERR_CONNECTION_REFUSED: 'Сервер отклонил соединение.',
  ERR_INTERNET_DISCONNECTED: 'Нет подключения к сети.',
  ERR_PROXY_CONNECTION_FAILED: 'Не удалось подключиться к настроенному прокси.',
  ERR_TUNNEL_CONNECTION_FAILED: 'Прокси не смог установить защищённое соединение.',
  ERR_CERT_AUTHORITY_INVALID: 'Не удалось проверить сертификат сервера.',
  ERR_CERT_DATE_INVALID: 'Неверный срок сертификата. Проверьте дату Windows.',
  ERR_CERT_COMMON_NAME_INVALID: 'Сертификат не соответствует адресу сервера.',
  CERT_HAS_EXPIRED: 'Срок действия сертификата сервера истёк. Проверьте дату Windows.',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Не удалось проверить сертификат сервера.',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'Получен недоверенный сертификат сервера.',
  SELF_SIGNED_CERT_IN_CHAIN: 'В цепочке сервера обнаружен недоверенный сертификат.',
  ERR_TLS_CERT_ALTNAME_INVALID: 'Сертификат не соответствует адресу сервера.'
};

function transportReason(error: unknown): [string, string] {
  const pending = [error];
  const seen = new Set<unknown>();
  for (let index = 0; index < pending.length && index < 32; index++) {
    const current = pending[index];
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const { code, cause, errors, message } = current as { code?: unknown; cause?: unknown; errors?: unknown; message?: unknown };
    if (typeof code === 'string' && Object.hasOwn(transportReasons, code)) return [code, transportReasons[code]];
    const chromiumCode = typeof message === 'string' ? /\bnet::(ERR_[A-Z_]+)\b/.exec(message)?.[1] : undefined;
    if (chromiumCode && Object.hasOwn(transportReasons, chromiumCode)) return [chromiumCode, transportReasons[chromiumCode]];
    if (cause) pending.push(cause);
    if (Array.isArray(errors)) pending.push(...errors.slice(0, 8));
  }
  return ['NETWORK_ERROR', 'Не удалось получить данные от сервера. Проверьте соединение и доступ к этому серверу.'];
}

export class ReleaseHttpError extends Error {
  constructor(readonly status: number, readonly hostname: string) {
    super(`Download failed with HTTP status ${status} (${hostname})`);
    this.name = 'ReleaseHttpError';
  }
}

class ResponseTransportError extends Error {}

class DownloadTransportError extends Error {
  constructor(url: string, cause: unknown) {
    const [code, reason] = transportReason(cause);
    super(`Ошибка загрузки с ${new URL(url).hostname} [${code}]: ${reason}`, { cause });
    this.name = 'DownloadTransportError';
  }
}

export function releaseDownloadUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['github.com', 'release-assets.githubusercontent.com'].includes(url.hostname)
      || url.username || url.password || url.port || url.hash
      || (url.hostname === 'github.com' && !validReleaseUrl(url.href))) {
    throw new Error('Untrusted download URL or redirect');
  }
  return url.href;
}

function waitFor<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      reject(signal.reason);
    };
    signal.addEventListener('abort', aborted, { once: true });
    pending.then(value => {
      signal.removeEventListener('abort', aborted);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', aborted);
      reject(error);
    });
    if (signal.aborted) aborted();
  });
}

export async function withReleaseDownload<T>(url: string, consume: (response: Response, signal: AbortSignal) => Promise<T>,
    options: DownloadOptions = {}): Promise<T> {
  if (!validReleaseUrl(url)) throw new Error('Untrusted release URL');
  return withTrustedDownload(url, releaseDownloadUrl, consume, options);
}

export async function withTrustedDownload<T>(url: string, validateUrl: (value: string) => string,
    consume: (response: Response, signal: AbortSignal) => Promise<T>,
    { request = currentDownloadRequest(), timeoutMs = downloadTimeoutMs, idleTimeoutMs = downloadIdleTimeoutMs }: DownloadOptions = {}): Promise<T> {
  let current = validateUrl(url);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > downloadTimeoutMs
      || !Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1 || idleTimeoutMs > downloadIdleTimeoutMs) throw new Error('Invalid download timeout');
  const controller = new AbortController();
  const { signal } = controller;
  const parentSignal = downloadSignal();
  const cancelled = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener('abort', cancelled, { once: true });
  if (parentSignal?.aborted) cancelled();
  let received = 0;
  let waitingForResponse = true;
  let idleTimeout: ReturnType<typeof setTimeout> | undefined;
  const activity = () => {
    clearTimeout(idleTimeout);
    if (signal.aborted) return;
    idleTimeout = setTimeout(() => controller.abort(new Error(
      `Загрузка с ${new URL(current).hostname}: ${waitingForResponse ? 'сервер не прислал ответ' : 'не поступают новые данные'} ${Math.round(idleTimeoutMs / 1000)} с; получено ${received} байт. Автоматический повтор отключён.`
    )), idleTimeoutMs);
  };
  downloadActivity.set(signal, bytes => { received += bytes; activity(); });
  const timeout = setTimeout(() => controller.abort(new Error(
    `Загрузка с ${new URL(current).hostname}: превышен общий лимит ${Math.round(timeoutMs / 60_000)} мин; получено ${received} байт. Автоматический повтор отключён.`
  )), timeoutMs);
  activity();
  const visited = new Set<string>();
  let activeResponse: Response | undefined;
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      signal.throwIfAborted();
      if (visited.has(current)) throw new Error('Download redirect loop');
      visited.add(current);
      waitingForResponse = true;
      activity();
      let response: Response;
      try {
        response = await waitFor(request(current, {
          redirect: 'manual', signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
          headers: { 'Accept-Encoding': 'identity' }
        }).then(result => {
          if (signal.aborted) {
            if (result.body) void result.body.cancel().catch(() => {});
            signal.throwIfAborted();
          }
          return result;
        }), signal);
      } catch (error) {
        signal.throwIfAborted();
        throw new DownloadTransportError(current, error);
      }
      activeResponse = response;
      signal.throwIfAborted();
      waitingForResponse = false;
      activity();
      if (response.redirected) throw new Error('Unexpected automatic download redirect');
      if (!redirectStatuses.has(response.status)) {
        if (response.status !== 200) throw new ReleaseHttpError(response.status, new URL(current).hostname);
        const result = await consume(response, signal);
        signal.throwIfAborted();
        return result;
      }
      const location = response.headers.get('location');
      if (response.body) await waitFor(response.body.cancel(), signal);
      activeResponse = undefined;
      if (!location) throw new Error('Download redirect without location');
      if (redirects === 5) throw new Error('Too many download redirects');
      current = validateUrl(new URL(location, current).href);
    }
    throw new Error('Too many download redirects');
  } catch (error) {
    if (error instanceof ResponseTransportError) throw new DownloadTransportError(current, error.cause);
    throw error;
  } finally {
    parentSignal?.removeEventListener('abort', cancelled);
    clearTimeout(timeout);
    clearTimeout(idleTimeout);
    downloadActivity.delete(signal);
    controller.abort();
    if (activeResponse?.body && !activeResponse.body.locked) void activeResponse.body.cancel().catch(() => {});
  }
}

function validateSizeLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000_000) throw new Error('Invalid download size limit');
}

export async function readReleaseBody(response: Response, limit: number, signal: AbortSignal,
    write: (chunk: Uint8Array) => void | Promise<void>): Promise<number> {
  validateSizeLimit(limit);
  signal.throwIfAborted();
  if (!response.body) throw new Error('Empty download');
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') throw new Error('Unexpected download content encoding');
  const declared = response.headers.get('content-length');
  let declaredSize: number | undefined;
  if (declared !== null) {
    if (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared))) throw new Error('Invalid download content length');
    declaredSize = Number(declared);
    if (declaredSize > limit) throw new Error('Download exceeds size limit');
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await waitFor(reader.read(), signal); }
      catch (error) {
        signal.throwIfAborted();
        throw new ResponseTransportError('Download response stream failed', { cause: error });
      }
      const { value, done } = chunk;
      signal.throwIfAborted();
      if (done) break;
      if (value.byteLength > 0) downloadActivity.get(signal)?.(value.byteLength);
      size += value.byteLength;
      if (size > limit || (declaredSize !== undefined && size > declaredSize)) throw new Error('Download exceeds declared size');
      // Settle an in-flight local write before releasing its caller's file handle or lock.
      await write(value);
    }
    if (declaredSize !== undefined && size !== declaredSize) throw new Error('Download content length mismatch');
    return size;
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

export async function downloadReleaseBytes(url: string, limit: number, options?: DownloadOptions): Promise<Buffer> {
  validateSizeLimit(limit);
  return withReleaseDownload(url, async (response, signal) => {
    const chunks: Uint8Array[] = [];
    const size = await readReleaseBody(response, limit, signal, chunk => { chunks.push(chunk); });
    return Buffer.concat(chunks, size);
  }, options);
}

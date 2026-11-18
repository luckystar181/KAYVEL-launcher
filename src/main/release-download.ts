import { validReleaseUrl } from './manifest.js';

type DownloadOptions = { request?: typeof fetch; timeoutMs?: number };
const downloadTimeoutMs = 180_000;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

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
    { request = fetch, timeoutMs = downloadTimeoutMs }: DownloadOptions = {}): Promise<T> {
  let current = validateUrl(url);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > downloadTimeoutMs) throw new Error('Invalid download timeout');
  const controller = new AbortController();
  const { signal } = controller;
  const timeout = setTimeout(() => controller.abort(new Error('Download timed out; automatic retry is disabled')), timeoutMs);
  const visited = new Set<string>();
  let activeResponse: Response | undefined;
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      signal.throwIfAborted();
      if (visited.has(current)) throw new Error('Download redirect loop');
      visited.add(current);
      const response = await waitFor(request(current, {
        redirect: 'manual', signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { 'Accept-Encoding': 'identity' }
      }).then(result => {
        if (signal.aborted) {
          if (result.body) void result.body.cancel().catch(() => {});
          signal.throwIfAborted();
        }
        return result;
      }), signal);
      activeResponse = response;
      signal.throwIfAborted();
      if (response.redirected) throw new Error('Unexpected automatic download redirect');
      if (!redirectStatuses.has(response.status)) {
        if (response.status !== 200) throw new Error('Download failed with HTTP status ' + response.status);
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
  } finally {
    clearTimeout(timeout);
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
      const { value, done } = await waitFor(reader.read(), signal);
      signal.throwIfAborted();
      if (done) break;
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

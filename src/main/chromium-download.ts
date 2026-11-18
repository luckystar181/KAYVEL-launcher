import type { IncomingMessage, Net, Session } from 'electron';
import type { Readable } from 'node:stream';

function responseHeaders(values: Record<string, string | string[]>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

export function createChromiumDownloadRequest(downloads: Session, request: Net['request']): typeof fetch {
  return async (input, init) => {
    if (typeof input !== 'string' && !(input instanceof URL)) throw new Error('Download requires a URL');
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
        || (init?.method && init.method !== 'GET') || init?.body || init?.redirect !== 'manual') {
      throw new Error('Unsupported download request');
    }
    const signal = init.signal;
    signal?.throwIfAborted();
    const headers = new Headers(init.headers);
    for (const name of ['authorization', 'proxy-authorization', 'cookie', 'referer']) {
      if (headers.has(name)) throw new Error('Download credentials are forbidden');
    }
    headers.set('Accept-Encoding', 'identity');
    const requestHeaders: Record<string, string> = {};
    headers.forEach((value, name) => { requestHeaders[name] = value; });
    return new Promise<Response>((resolve, reject) => {
      const client = request({ url: url.href, method: 'GET', session: downloads, redirect: 'manual',
        credentials: 'omit', useSessionCookies: false, cache: 'no-store', referrerPolicy: 'no-referrer',
        bypassCustomProtocolHandlers: true, headers: requestHeaders });
      let settled = false;
      let finished = false;
      let body: ReadableStreamDefaultController<Uint8Array> | undefined;
      const cleanup = () => signal?.removeEventListener('abort', aborted);
      const fail = (error: unknown) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (body) body.error(error);
        if (!settled) { settled = true; reject(error); }
      };
      const aborted = () => { fail(signal?.reason ?? new Error('Download aborted')); client.abort(); };
      client.on('error', fail);
      client.on('abort', () => fail(new Error('Download request aborted')));
      client.on('redirect', (status, _method, location, values) => {
        if (finished) return;
        try {
          const headers = responseHeaders(values);
          headers.set('Location', location);
          const response = new Response(null, { status, headers });
          // The caller validates each redirect before issuing a separate request.
          finished = true;
          settled = true;
          cleanup();
          resolve(response);
        } catch (error) { fail(error); }
        client.abort();
      });
      client.on('response', incoming => {
        if (finished) return;
        // Electron implements Readable but its declarations omit pause/resume.
        const source = incoming as IncomingMessage & Pick<Readable, 'pause' | 'resume' | 'on'>;
        try {
          source.pause();
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller;
              source.on('end', () => {
                if (finished) return;
                finished = true;
                cleanup();
                controller.close();
              });
              source.on('error', fail);
              source.on('close', () => fail(new Error('Download response closed before completion')));
              source.on('aborted', () => fail(new Error('Download response aborted')));
              source.on('data', chunk => {
                if (finished) return;
                controller.enqueue(new Uint8Array(chunk));
                if ((controller.desiredSize ?? 0) <= 0) source.pause();
              });
            },
            pull() { if (!finished) source.resume(); },
            cancel() { finished = true; cleanup(); client.abort(); }
          }, { highWaterMark: 256 * 1024, size: chunk => chunk.byteLength });
          const response = new Response(stream, { status: source.statusCode, headers: responseHeaders(source.headers) });
          settled = true;
          resolve(response);
        } catch (error) { fail(error); client.abort(); }
      });
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
      else client.end();
    });
  };
}

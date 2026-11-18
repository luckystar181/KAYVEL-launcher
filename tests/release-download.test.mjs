import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadReleaseBytes, readReleaseBody, withReleaseDownload } from '../dist/main/release-download.js';

const url = 'https://github.com/example/kayvel/releases/download/v1/file.jar';
const cdn = 'https://release-assets.githubusercontent.com/example/file?temporary=fixture';
const payload = Buffer.from('fictional release asset');

function trackedResponse(status = 200, headers = {}) {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(payload); },
    cancel() { cancelled = true; }
  }), { status, headers });
  return { response, cancelled: () => cancelled };
}

test('release transfer makes one explicit request without credentials, automatic redirects or compression', async () => {
  const calls = [];
  const result = await downloadReleaseBytes(url, payload.length, {
    request: async (requested, options) => {
      calls.push({ requested, options });
      assert.equal(options.signal.aborted, false);
      return new Response(payload, { headers: { 'content-length': String(payload.length) } });
    }
  });
  assert.deepEqual(result, payload);
  assert.equal(calls.length, 1);
  const [{ requested, options }] = calls;
  assert.equal(requested, url);
  assert.equal(options.redirect, 'manual');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.deepEqual(options.headers, { 'Accept-Encoding': 'identity' });
  assert.equal(options.signal.aborted, true);
});

test('untrusted release URLs and invalid limits stop before requesting anything', async () => {
  let calls = 0;
  const options = { request: async () => { calls++; throw new Error('must not request'); } };
  for (const invalid of [
    'http://github.com/example/kayvel/releases/download/v1/file.jar',
    'https://github.com.invalid/example/kayvel/releases/download/v1/file.jar',
    'https://user:password@github.com/example/kayvel/releases/download/v1/file.jar',
    'https://github.com:444/example/kayvel/releases/download/v1/file.jar',
    'https://github.com/example/kayvel/issues', url + '#fragment', cdn, 'not a URL'
  ]) await assert.rejects(downloadReleaseBytes(invalid, payload.length, options), /Untrusted|Invalid URL/);
  for (const invalid of [0, -1, 1.5, NaN, Infinity, 1_000_000_001]) {
    await assert.rejects(downloadReleaseBytes(url, invalid, options), /size limit/);
  }
  for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 180_001]) {
    await assert.rejects(downloadReleaseBytes(url, payload.length, { ...options, timeoutMs }), /timeout/);
  }
  assert.equal(calls, 0);
});

for (const status of [301, 302, 303, 307, 308]) {
  test(`an allowed HTTP ${status} redirect is followed once under the same deadline`, async () => {
    const redirect = trackedResponse(status, { location: cdn });
    const calls = [];
    const result = await downloadReleaseBytes(url, payload.length, {
      request: async (requested, options) => {
        calls.push({ requested, signal: options.signal });
        return requested === url ? redirect.response : new Response(payload);
      }
    });
    assert.deepEqual(result, payload);
    assert.deepEqual(calls.map(call => call.requested), [url, cdn]);
    assert.equal(calls[0].signal, calls[1].signal);
    assert.equal(redirect.cancelled(), true);
  });
}

test('relative release redirects work but a loop is not retried', async () => {
  const next = url.replace('file.jar', 'next.jar');
  const calls = [];
  const result = await downloadReleaseBytes(url, payload.length, {
    request: async requested => {
      calls.push(requested);
      return requested === url ? new Response(null, { status: 302, headers: { location: 'next.jar' } }) : new Response(payload);
    }
  });
  assert.deepEqual(result, payload);
  assert.deepEqual(calls, [url, next]);
  calls.length = 0;
  await assert.rejects(downloadReleaseBytes(url, payload.length, {
    request: async requested => {
      calls.push(requested);
      return new Response(null, { status: 302, headers: { location: url } });
    }
  }), /redirect loop/);
  assert.deepEqual(calls, [url]);
});

test('untrusted redirect destinations are never requested', async () => {
  for (const location of [
    'http://release-assets.githubusercontent.com/file', 'https://assets.example.invalid/file',
    'https://user:password@release-assets.githubusercontent.com/file',
    'https://release-assets.githubusercontent.com:444/file', cdn + '#fragment',
    'https://github.com/example/kayvel/issues'
  ]) {
    const redirect = trackedResponse(302, { location });
    const calls = [];
    await assert.rejects(downloadReleaseBytes(url, payload.length, {
      request: async requested => { calls.push(requested); return redirect.response; }
    }), /Untrusted/);
    assert.deepEqual(calls, [url]);
    assert.equal(redirect.cancelled(), true);
  }
});

test('missing locations and excessive redirects stop without a fallback', async () => {
  let calls = 0;
  await assert.rejects(downloadReleaseBytes(url, payload.length, {
    request: async () => { calls++; return new Response(null, { status: 302 }); }
  }), /without location/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(downloadReleaseBytes(url, payload.length, {
    request: async () => new Response(null, { status: 302, headers: { location: url + '?hop=' + ++calls } })
  }), /Too many/);
  assert.equal(calls, 6);
});

test('exactly five distinct allowed redirects are accepted', async () => {
  const calls = [];
  const destinations = [url, ...Array.from({ length: 5 }, (_, index) => `${cdn}&hop=${index}`)];
  const result = await downloadReleaseBytes(url, payload.length, {
    request: async requested => {
      const index = calls.push(requested);
      return index === destinations.length ? new Response(payload) : new Response(null, {
        status: 302, headers: { location: destinations[index] }
      });
    }
  });
  assert.deepEqual(result, payload);
  assert.deepEqual(calls, destinations);
});

test('an unexpectedly auto-followed response is rejected and cancelled', async () => {
  const tracked = trackedResponse();
  Object.defineProperty(tracked.response, 'redirected', { value: true });
  let calls = 0;
  await assert.rejects(downloadReleaseBytes(url, payload.length, {
    request: async () => { calls++; return tracked.response; }
  }), /automatic download redirect/);
  assert.equal(calls, 1);
  assert.equal(tracked.cancelled(), true);
});

test('HTTP errors including rate limiting and partial content are not retried', async () => {
  for (const status of [204, 206, 304, 404, 429, 500, 503]) {
    let calls = 0;
    const tracked = [204, 304].includes(status) ? { response: new Response(null, { status }) } : trackedResponse(status);
    await assert.rejects(downloadReleaseBytes(url, payload.length, {
      request: async () => { calls++; return tracked.response; }
    }), new RegExp('HTTP status ' + status));
    assert.equal(calls, 1);
    if (tracked.cancelled) assert.equal(tracked.cancelled(), true);
  }
});

test('connection and body failures preserve the error and never trigger another request', async () => {
  let calls = 0;
  const failure = new Error('fictional ambiguous connection failure');
  await assert.rejects(downloadReleaseBytes(url, payload.length, {
    request: async () => { calls++; throw failure; }
  }), error => error === failure);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(downloadReleaseBytes(url, payload.length, {
    request: async () => {
      calls++;
      return new Response(new ReadableStream({ start(controller) { controller.error(failure); } }));
    }
  }), error => error === failure);
  assert.equal(calls, 1);
});

test('invalid lengths, oversized bodies and encoded responses are rejected and cancelled', async () => {
  for (const headers of [
    { 'content-length': '-1' }, { 'content-length': '1.5' }, { 'content-length': 'invalid' },
    { 'content-length': '9007199254740992' }, { 'content-length': String(payload.length + 1) },
    { 'content-encoding': 'gzip' }, { 'content-encoding': 'br' }
  ]) {
    const tracked = trackedResponse(200, headers);
    await assert.rejects(downloadReleaseBytes(url, payload.length, { request: async () => tracked.response }), /length|size|encoding/);
    assert.equal(tracked.cancelled(), true);
  }
  await assert.rejects(downloadReleaseBytes(url, payload.length - 1, { request: async () => new Response(payload) }), /size/);
  await assert.rejects(downloadReleaseBytes(url, payload.length, {
    request: async () => new Response(payload.subarray(0, 2), { headers: { 'content-length': String(payload.length) } })
  }), /length mismatch/);
  await assert.rejects(downloadReleaseBytes(url, payload.length, {
    request: async () => new Response(payload, { headers: { 'content-length': '2' } })
  }), /declared size/);
  await assert.rejects(downloadReleaseBytes(url, payload.length, { request: async () => new Response(null) }), /Empty/);
});

test('chunked identity bodies and an explicitly empty body respect the byte limit', async () => {
  const result = await downloadReleaseBytes(url, payload.length, {
    request: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(payload.subarray(0, 2));
        controller.enqueue(payload.subarray(2));
        controller.close();
      }
    }), { headers: { 'content-encoding': 'identity', 'content-length': String(payload.length) } })
  });
  assert.deepEqual(result, payload);
  assert.deepEqual(await downloadReleaseBytes(url, 1, {
    request: async () => new Response(new Uint8Array(), { headers: { 'content-length': '0' } })
  }), Buffer.alloc(0));
});

test('a stalled request times out without retrying and cancels a late response', { timeout: 2000 }, async () => {
  let calls = 0;
  let signal;
  let complete;
  await assert.rejects(downloadReleaseBytes(url, payload.length, {
    timeoutMs: 40,
    request: (requested, options) => {
      calls++;
      signal = options.signal;
      return new Promise(resolve => { complete = resolve; });
    }
  }), /timed out/);
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
  const tracked = trackedResponse();
  complete(tracked.response);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tracked.cancelled(), true);
});

test('a late request rejection after timeout is handled without another request', { timeout: 2000 }, async () => {
  let calls = 0;
  let fail;
  await assert.rejects(downloadReleaseBytes(url, payload.length, {
    timeoutMs: 40,
    request: () => {
      calls++;
      return new Promise((resolve, reject) => { fail = reject; });
    }
  }), /timed out/);
  fail(new Error('fictional late connection failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('timeout cancels the network while waiting for an in-flight local write to settle', { timeout: 2000 }, async () => {
  let completeWrite;
  const writing = new Promise(resolve => { completeWrite = resolve; });
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  let notifyAborted;
  const aborted = new Promise(resolve => { notifyAborted = resolve; });
  let writes = 0;
  let cancelled = false;
  let settled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(payload.subarray(0, 2));
      controller.enqueue(payload.subarray(2));
    },
    cancel() { cancelled = true; }
  }));
  const pending = withReleaseDownload(url, (result, signal) => {
    signal.addEventListener('abort', notifyAborted, { once: true });
    return readReleaseBody(result, payload.length, signal, async () => {
      writes++;
      notifyStarted();
      await writing;
    });
  }, { timeoutMs: 40, request: async () => response });
  const rejection = assert.rejects(pending.finally(() => { settled = true; }), /timed out/);
  try {
    await started;
    await aborted;
    assert.equal(cancelled, true);
    assert.equal(settled, false);
    assert.equal(writes, 1);
    assert.equal(response.body.locked, true);
  } finally { completeWrite(); }
  await rejection;
  assert.equal(writes, 1);
  assert.equal(response.body.locked, false);
});

test('a stalled body is cancelled under the same deadline as its redirect', { timeout: 2000 }, async () => {
  let calls = 0;
  let cancelled = false;
  const signals = [];
  await assert.rejects(downloadReleaseBytes(url, payload.length, {
    timeoutMs: 100,
    request: async (requested, options) => {
      calls++;
      signals.push(options.signal);
      if (requested === url) return new Response(null, { status: 302, headers: { location: cdn } });
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(payload.subarray(0, 2)); },
        cancel() { cancelled = true; }
      }));
    }
  }), /timed out/);
  assert.equal(calls, 2);
  assert.equal(signals[0], signals[1]);
  assert.equal(signals[0].aborted, true);
  assert.equal(cancelled, true);
});

test('a stalled redirect cancellation cannot hang forever or request the next URL', { timeout: 2000 }, async () => {
  let calls = 0;
  await assert.rejects(downloadReleaseBytes(url, payload.length, {
    timeoutMs: 40,
    request: async () => {
      calls++;
      return new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }), { status: 302, headers: { location: cdn } });
    }
  }), /timed out/);
  assert.equal(calls, 1);
});

test('failed or stalled body cancellation cannot replace the transfer error', { timeout: 2000 }, async () => {
  for (const cancel of [() => Promise.reject(new Error('fictional cancellation failure')), () => new Promise(() => {})]) {
    let calls = 0;
    let cancelled = false;
    await assert.rejects(downloadReleaseBytes(url, payload.length, {
      request: async () => {
        calls++;
        return new Response(new ReadableStream({
          cancel() { cancelled = true; return cancel(); }
        }), { status: 503 });
      }
    }), /HTTP status 503/);
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
    await assert.rejects(downloadReleaseBytes(url, payload.length - 1, {
      request: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(payload); },
        cancel() { return cancel(); }
      }))
    }), /declared size/);
  }
});

test('stream consumer failure stops, releases its reader and cancels remaining bytes', async () => {
  const tracked = trackedResponse();
  const failure = new Error('fictional disk write failure');
  let writes = 0;
  await assert.rejects(withReleaseDownload(url, (response, signal) => readReleaseBody(response, payload.length, signal, () => {
    writes++;
    throw failure;
  }), { request: async () => tracked.response }), error => error === failure);
  assert.equal(writes, 1);
  assert.equal(tracked.response.body.locked, false);
  assert.equal(tracked.cancelled(), true);
});

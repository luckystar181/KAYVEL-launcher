import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createChromiumDownloadRequest } from '../dist/main/chromium-download.js';
import { withTrustedDownload, readReleaseBody } from '../dist/main/release-download.js';
import { officialDownloadUrl } from '../dist/main/official-download.js';

const url = 'https://maven.neoforged.net/fixture.jar';
function fixture(action) {
  const session = {};
  const calls = [];
  const clients = [];
  const request = createChromiumDownloadRequest(session, options => {
    calls.push(options);
    const client = new EventEmitter();
    client.abort = () => { client.aborted = true; client.emit('abort'); };
    client.end = () => { client.emit('close'); queueMicrotask(() => action(client, options, calls.length)); };
    clients.push(client);
    return client;
  });
  return { request, calls, clients, session };
}
function response(client, content = 'fixture', headers = {}) {
  const source = new PassThrough();
  Object.assign(source, { statusCode: 200, headers });
  client.emit('response', source);
  source.end(content);
  return source;
}

test('Chromium transport ignores writable close, streams bytes and forbids session credentials', async () => {
  const f = fixture(client => response(client));
  const bytes = await withTrustedDownload(url, officialDownloadUrl,
    async (res, signal) => { const chunks = []; await readReleaseBody(res, 100, signal, chunk => chunks.push(chunk)); return Buffer.concat(chunks); }, { request: f.request });
  assert.equal(bytes.toString(), 'fixture');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].session, f.session);
  assert.equal(f.calls[0].credentials, 'omit');
  assert.equal(f.calls[0].useSessionCookies, false);
  assert.equal(f.calls[0].redirect, 'manual');
  assert.equal(f.calls[0].cache, 'no-store');
  assert.equal(f.calls[0].headers['accept-encoding'], 'identity');
});

test('Chromium redirects are returned without following and untrusted targets never get requested', async () => {
  const f = fixture(client => {
    client.emit('redirect', 302, 'GET', 'https://untrusted.invalid/secret', {});
    client.emit('error', new Error('Redirect was cancelled'));
  });
  await assert.rejects(withTrustedDownload(url, officialDownloadUrl, async () => assert.fail(), { request: f.request }), /Недоверенный/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.clients[0].aborted, true);
});

test('Chromium allowlisted redirects use independent requests', async () => {
  const f = fixture((client, _options, count) => {
    if (count === 1) client.emit('redirect', 307, 'GET', '/final.jar', {});
    else response(client);
  });
  await withTrustedDownload(url, officialDownloadUrl, async res => assert.equal(await res.text(), 'fixture'), { request: f.request });
  assert.deepEqual(f.calls.map(call => call.url), [url, 'https://maven.neoforged.net/final.jar']);
});

test('Chromium cancellation aborts both pending request and active response', async () => {
  for (const stage of ['request', 'body']) {
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const f = fixture(client => {
      if (stage === 'body') {
        const source = new PassThrough();
        Object.assign(source, { statusCode: 200, headers: {} });
        client.emit('response', source);
      }
      started();
    });
    const controller = new AbortController();
    const pending = f.request(url, { redirect: 'manual', signal: controller.signal });
    const consumed = stage === 'body' ? pending.then(res => res.text()) : pending;
    const rejected = assert.rejects(consumed, /fixture cancellation/);
    await ready;
    controller.abort(new Error('fixture cancellation'));
    await rejected;
    assert.equal(f.clients[0].aborted, true);
  }
});

test('Chromium response errors, premature close and TLS failures propagate without retry', async () => {
  for (const mode of ['close', 'error', 'tls']) {
    const f = fixture(client => {
      if (mode === 'tls') { client.emit('error', new Error('net::ERR_CERT_AUTHORITY_INVALID')); return; }
      const source = new PassThrough();
      Object.assign(source, { statusCode: 200, headers: {} });
      client.emit('response', source);
      source.destroy(mode === 'error' ? new Error('fixture failure') : undefined);
    });
    await assert.rejects(withTrustedDownload(url, officialDownloadUrl, (res, signal) => readReleaseBody(res, 100, signal, () => {}), { request: f.request }),
      mode === 'tls' ? /ERR_CERT_AUTHORITY_INVALID/ : /NETWORK_ERROR/);
    assert.equal(f.calls.length, 1);
  }
});

test('Chromium transport refuses bodies, automatic redirects and explicit credentials before networking', async () => {
  const f = fixture(() => assert.fail());
  for (const init of [{}, { redirect: 'follow' }, { redirect: 'manual', method: 'POST' }, { redirect: 'manual', body: 'no' },
    ...['Cookie', 'Authorization', 'Proxy-Authorization', 'Referer'].map(name => ({ redirect: 'manual', headers: { [name]: 'secret' } }))]) {
    await assert.rejects(f.request(url, init));
  }
  const controller = new AbortController();
  controller.abort(new Error('already cancelled'));
  await assert.rejects(f.request(url, { redirect: 'manual', signal: controller.signal }), /already cancelled/);
  assert.equal(f.calls.length, 0);
});

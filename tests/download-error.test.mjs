import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChecksumNotMatchError, DownloadAggregateError, DownloadError, DownloadFileSystemError, resolveAgent } from '@xmcl/file-transfer';
import { installLibraries, installVersion } from '@xmcl/installer';
import { MockAgent, errors as undiciErrors } from 'undici';
import { describeMinecraftDownloadError } from '../dist/main/download-error.js';

const destination = 'C:\\Users\\PrivateUser\\game\\private-file.jar';
const headers = { authorization: 'Bearer PRIVATE_TOKEN', cookie: 'PRIVATE_COOKIE' };
const officialUrl = 'https://piston-data.mojang.com/private-file?token=PRIVATE_TOKEN';

function aggregate(errors, urls = [officialUrl]) {
  return new DownloadAggregateError(errors, `private error ${destination}`, urls, headers, destination);
}

test('extracts HTTP, network and official host from nested transfer errors', () => {
  const status = new undiciErrors.ResponseStatusCodeError('private response', 503, headers, 'PRIVATE_BODY');
  const network = Object.assign(new Error('private DNS detail'), { code: 'ENOTFOUND' });
  const error = new AggregateError([new Error('wrapper', { cause: aggregate([status, network]) })], 'private aggregate');
  const message = describeMinecraftDownloadError(error);
  assert.match(message, /piston-data\.mojang\.com/);
  assert.match(message, /HTTP: 503/);
  assert.match(message, /UND_ERR_RESPONSE_STATUS_CODE/);
  assert.match(message, /ENOTFOUND/);
  for (const secret of [destination, 'PrivateUser', 'private-file', 'PRIVATE_TOKEN', 'PRIVATE_COOKIE', 'PRIVATE_BODY', 'private response', 'private aggregate']) {
    assert.ok(!message.includes(secret), `Unexpected disclosure of ${secret}`);
  }
});

test('extracts network codes from nested DownloadError and retains filesystem codes', () => {
  const timeout = new undiciErrors.ConnectTimeoutError('private socket address');
  const network = new DownloadError('private message', [officialUrl], headers, destination, { cause: timeout });
  assert.match(describeMinecraftDownloadError(network), /UND_ERR_CONNECT_TIMEOUT/);

  for (const code of ['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'ENOTDIR']) {
    const io = Object.assign(new Error(`private path ${destination}`), { code });
    const error = new DownloadFileSystemError('private filesystem error', [officialUrl], headers, destination, io);
    const message = describeMinecraftDownloadError(error);
    assert.ok(message.includes(code));
    assert.ok(!message.includes(destination));
  }
});

test('reports checksum mismatch without disclosing hashes, URLs or file paths', () => {
  const mismatch = new ChecksumNotMatchError('sha1', 'PRIVATE_EXPECTED_HASH', 'PRIVATE_ACTUAL_HASH', destination, officialUrl);
  const message = describeMinecraftDownloadError(aggregate([mismatch]));
  assert.match(message, /не совпала контрольная сумма/);
  for (const secret of [destination, 'PRIVATE_EXPECTED_HASH', 'PRIVATE_ACTUAL_HASH', 'PRIVATE_TOKEN', 'private-file']) {
    assert.ok(!message.includes(secret), `Unexpected disclosure of ${secret}`);
  }
});

test('discloses only explicitly allowed hostnames, numeric HTTP statuses and known codes', () => {
  const untrustedCode = Object.assign(new Error('PRIVATE_MESSAGE'), { code: 'PRIVATE_SECRET_TOKEN', statusCode: 5999 });
  const error = aggregate([untrustedCode], [
    'https://evil.example/private',
    'https://piston-data.mojang.com.evil.example/file',
    'https://PRIVATE_USER:PRIVATE_PASSWORD@piston-data.mojang.com/file',
    'http://piston-data.mojang.com/file',
    'not a url',
    'https://libraries.minecraft.net/PRIVATE_PATH?secret=PRIVATE_QUERY',
  ]);
  const message = describeMinecraftDownloadError(error);
  assert.match(message, /libraries\.minecraft\.net/);
  for (const secret of ['evil.example', 'piston-data.mojang.com', 'PRIVATE_', '5999', 'private']) {
    assert.ok(!message.includes(secret), `Unexpected disclosure of ${secret}`);
  }
  assert.doesNotMatch(message, /HTTP:|код:/);
});

test('handles cycles and repeated nested errors without losing diagnostics', () => {
  const network = Object.assign(new Error('private network failure'), { code: 'ECONNRESET' });
  const transfer = aggregate([network]);
  const wrapper = new AggregateError([transfer], 'private wrapper');
  wrapper.cause = wrapper;
  transfer.errors.push(wrapper, transfer, network);
  network.cause = transfer;
  assert.match(describeMinecraftDownloadError(wrapper), /ECONNRESET/);
});

test('leaves unrelated errors for the existing handlers and uses a safe fallback for unknown transfers', () => {
  for (const value of [null, undefined, 'error', new Error('Java error'), new AggregateError([new Error('other')])]) {
    assert.equal(describeMinecraftDownloadError(value), null);
  }
  assert.equal(describeMinecraftDownloadError(aggregate([new Error('PRIVATE_MESSAGE')], ['https://evil.example/path'])),
    'Не удалось скачать компоненты Minecraft. Подробности ошибки недоступны.');
});

test('formats a real installer version-download failure with mocked HTTP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kayvel-diagnostic-version-'));
  const dispatcher = new MockAgent();
  dispatcher.disableNetConnect();
  const url = 'https://piston-meta.mojang.com/PRIVATE_PATH?token=PRIVATE_TOKEN';
  dispatcher.get('https://piston-meta.mojang.com')
    .intercept({ path: '/PRIVATE_PATH?token=PRIVATE_TOKEN', method: 'HEAD' })
    .reply(503, 'PRIVATE_BODY');
  try {
    await assert.rejects(installVersion({ id: '1.21.1', url }, directory, { agent: resolveAgent({ dispatcher }), headers }), error => {
      assert.ok(error instanceof DownloadAggregateError);
      const message = describeMinecraftDownloadError(error);
      assert.match(message, /piston-meta\.mojang\.com/);
      assert.match(message, /HTTP: 503/);
      assert.ok(!message.includes(directory));
      assert.ok(!message.includes('PRIVATE_'));
      return true;
    });
  } finally {
    await dispatcher.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('formats nested aggregate errors from real library installer tasks without their private messages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kayvel-diagnostic-libraries-'));
  const dispatcher = new MockAgent();
  dispatcher.disableNetConnect();
  dispatcher.get('https://libraries.minecraft.net')
    .intercept({ path: '/PRIVATE_FILE.jar?token=PRIVATE_TOKEN', method: 'HEAD' }).reply(503, 'PRIVATE_BODY');
  dispatcher.get('https://repo1.maven.org')
    .intercept({ path: '/maven2/group/PRIVATE_FILE.jar', method: 'HEAD' }).reply(504, 'PRIVATE_BODY');
  const library = { download: { path: 'group/PRIVATE_FILE.jar', url: 'https://libraries.minecraft.net/PRIVATE_FILE.jar?token=PRIVATE_TOKEN', sha1: '0'.repeat(40), size: 1 } };
  try {
    await assert.rejects(installLibraries({ minecraftDirectory: directory, libraries: [library] }, { agent: resolveAgent({ dispatcher }), headers }), error => {
      assert.ok(error instanceof AggregateError);
      const message = describeMinecraftDownloadError(error);
      assert.match(message, /libraries\.minecraft\.net/);
      assert.match(message, /repo1\.maven\.org/);
      assert.match(message, /HTTP: 503, 504/);
      assert.ok(!message.includes(directory));
      assert.ok(!message.includes('PRIVATE_'));
      return true;
    });
  } finally {
    await dispatcher.close();
    await rm(directory, { recursive: true, force: true });
  }
});

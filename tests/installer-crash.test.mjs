import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireGameDirectoryLock, installRelease } from '../dist/main/installer.js';

const manifestUrl = 'https://github.com/example/kayvel/releases/download/v1/manifest.json';
const first = Buffer.from('first mock mod');
const second = Buffer.from('second mock resource pack');
const files = [
  { path: 'mods/first.jar', url: 'https://github.com/example/kayvel/releases/download/v1/first.jar', content: first },
  { path: 'resourcepacks/second.zip', url: 'https://github.com/example/kayvel/releases/download/v1/second.zip', content: second }
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function waitForPause(child, config, stderr) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Installer did not reach the requested stage: ' + stderr())), 15000);
    const onMessage = message => {
      if (message?.type === 'paused' && message.phase === config.phase) finish();
      else finish(new Error('Unexpected child message: ' + JSON.stringify(message)));
    };
    const onClose = (code, signal) => finish(new Error(`Installer exited before pausing (${code}, ${signal}): ${stderr()}`));
    const onError = error => finish(error);
    function finish(error) {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('close', onClose);
      child.off('error', onError);
      if (error) reject(error);
      else resolve();
    }
    child.on('message', onMessage);
    child.once('close', onClose);
    child.once('error', onError);
    child.send(config, error => { if (error) finish(error); });
  });
}

for (const phase of ['after-first-link', 'before-marker-unlink']) {
  test(`forced process termination ${phase} preserves files and blocks further work`, { timeout: 30000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kayvel-install-crash-'));
    const root = join(directory, 'game');
    const meta = join(root, '.kayvel');
    const marker = join(meta, 'install-incomplete.json');
    const lock = join(meta, 'lock');
    const outside = join(directory, 'outside.txt');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const manifest = {
      schemaVersion: 1, buildVersion: 'v1', minecraftVersion: '1.21.1', neoforgeVersion: '21.1.252',
      files: files.map(file => ({ path: file.path, size: file.content.length, sha256: sha256(file.content), url: file.url }))
    };
    const bytes = Buffer.from(JSON.stringify(manifest));
    const signature = sign(null, bytes, privateKey).toString('base64');
    const record = JSON.stringify({ bytes: bytes.toString('base64'), signature });
    const config = {
      root, phase, manifestUrl, bytes: bytes.toString('base64'), signature, publicPem,
      files: files.map(file => ({ url: file.url, content: file.content.toString('base64') }))
    };
    const originalFetch = globalThis.fetch;
    let child;
    let closed;
    let stderr = '';
    try {
      await mkdir(join(root, 'mods'), { recursive: true });
      await mkdir(join(root, 'resourcepacks'));
      await mkdir(join(root, 'saves', 'fixture-world'), { recursive: true });
      await writeFile(join(root, 'mods', 'personal.jar'), 'personal mod');
      await writeFile(join(root, 'resourcepacks', 'personal.zip'), 'personal pack');
      await writeFile(join(root, 'saves', 'fixture-world', 'level.dat'), 'fake world data');
      await writeFile(join(root, 'options.txt'), 'fake settings');
      await writeFile(outside, 'outside data');

      child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/installer-crash-child.mjs', import.meta.url))], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr += chunk; });
      closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
      await waitForPause(child, config, () => stderr);
      assert.equal(child.kill('SIGKILL'), true);
      const result = await closed;
      assert.notEqual(result.code, 0, `Child exited normally: ${stderr}`);

      const assertPreserved = async () => {
        assert.equal(await readFile(marker, 'utf8'), record);
        assert.deepEqual(await readFile(join(root, 'mods', 'first.jar')), first);
        assert.equal(await readFile(join(root, 'mods', 'personal.jar'), 'utf8'), 'personal mod');
        assert.equal(await readFile(join(root, 'resourcepacks', 'personal.zip'), 'utf8'), 'personal pack');
        assert.equal(await readFile(join(root, 'saves', 'fixture-world', 'level.dat'), 'utf8'), 'fake world data');
        assert.equal(await readFile(join(root, 'options.txt'), 'utf8'), 'fake settings');
        assert.equal(await readFile(outside, 'utf8'), 'outside data');
        assert.deepEqual((await readdir(join(root, 'mods'))).sort(), ['first.jar', 'personal.jar']);
        assert.deepEqual((await readdir(join(root, 'resourcepacks'))).sort(), phase === 'after-first-link'
          ? ['personal.zip'] : ['personal.zip', 'second.zip']);
        const staging = join(meta, 'staging');
        if (phase === 'after-first-link') {
          await assert.rejects(readFile(join(root, 'resourcepacks', 'second.zip')), { code: 'ENOENT' });
          await assert.rejects(readFile(join(meta, 'signed-manifest.json')), { code: 'ENOENT' });
          const attempts = await readdir(staging);
          assert.equal(attempts.length, 1);
          assert.deepEqual((await readdir(join(staging, attempts[0]))).sort(),
            files.map(file => sha256(file.path) + '.part').sort());
          for (const file of files) {
            const part = join(staging, attempts[0], sha256(file.path) + '.part');
            assert.deepEqual(await readFile(part), file.content);
          }
          const stagedFirst = join(staging, attempts[0], sha256(files[0].path) + '.part');
          assert.equal((await lstat(stagedFirst)).nlink, 2);
          assert.equal((await lstat(join(root, 'mods', 'first.jar'))).nlink, 2);
        } else {
          assert.deepEqual(await readFile(join(root, 'resourcepacks', 'second.zip')), second);
          assert.equal(await readFile(join(meta, 'signed-manifest.json'), 'utf8'), record);
          assert.deepEqual(await readdir(staging), []);
        }
      };
      await assertPreserved();
      assert.equal((await lstat(lock)).isDirectory(), true);
      globalThis.fetch = async request => {
        if (request === manifestUrl) return new Response(bytes);
        if (request === manifestUrl + '.sig') return new Response(signature);
        throw new Error('A blocked attempt must not download files');
      };
      await assert.rejects(acquireGameDirectoryLock(root), /заблокирована/);
      await assert.rejects(installRelease(root, manifestUrl, publicPem), /заблокирована/);
      await assertPreserved();
      assert.equal((await lstat(lock)).isDirectory(), true);

      // Remove only this fixture's lock to exercise the incomplete marker independently.
      await rm(lock, { recursive: true });
      await assert.rejects(acquireGameDirectoryLock(root), /незавершённая установка/);
      await assert.rejects(installRelease(root, manifestUrl, publicPem), /незавершённая установка/);
      await assert.rejects(lstat(lock), { code: 'ENOENT' });
      await assertPreserved();
    } finally {
      globalThis.fetch = originalFetch;
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (closed) await closed;
      await rm(directory, { recursive: true, force: true });
    }
  });
}

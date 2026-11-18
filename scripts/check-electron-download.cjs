const { app, net, session } = require('electron');
const { mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = mkdtempSync(join(process.env.LOCALAPPDATA, 'Temp', 'opencode', 'kayvel-network-'));
app.setPath('userData', root);
app.setPath('sessionData', root);
app.whenReady().then(async () => {
  const { configureDownloadRequest, withDownloadSignal } = await import(pathToFileURL(join(__dirname, '../dist/main/download-session.js')));
  const { withTrustedDownload, readReleaseBody, downloadReleaseBytes } = await import(pathToFileURL(join(__dirname, '../dist/main/release-download.js')));
  const { officialDownloadUrl } = await import(pathToFileURL(join(__dirname, '../dist/main/official-download.js')));
  const downloads = session.fromPartition('kayvel-smoke', { cache: false });
  const { createChromiumDownloadRequest } = await import(pathToFileURL(join(__dirname, '../dist/main/chromium-download.js')));
  configureDownloadRequest(createChromiumDownloadRequest(downloads, options => net.request(options)));
  const url = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.252/neoforge-21.1.252-installer.jar';
  await withTrustedDownload(url, officialDownloadUrl, async (response, signal) => {
    const hash = createHash('sha256');
    const size = await readReleaseBody(response, 6972019, signal, chunk => { hash.update(chunk); });
    assert.equal(size, 6972019);
    assert.equal(hash.digest('hex'), 'd0345e2a104ce4633065f572310ba6e0dd428bb6a73364cf0c2443ed9f8950ad');
  });
  console.log('PASS: Chromium NeoForge installer size and SHA-256');
  const { discoverModpack } = await import(pathToFileURL(join(__dirname, '../dist/main/modpack-channel.js')));
  const { MANIFEST_PUBLIC_KEY_PEM, RELEASE_MANIFEST_URL } = await import(pathToFileURL(join(__dirname, '../dist/main/release.js')));
  const manifest = await discoverModpack(RELEASE_MANIFEST_URL, MANIFEST_PUBLIC_KEY_PEM);
  assert.ok(manifest.manifest.files.length > 0);
  console.log('PASS: Chromium allowlisted manual GitHub redirects and manifest');
  const controller = new AbortController();
  await assert.rejects(withDownloadSignal(controller.signal, () => withTrustedDownload(url, officialDownloadUrl, async (response, signal) => {
    await readReleaseBody(response, 6972019, signal, () => { controller.abort(new Error('smoke cancellation')); });
  })), /smoke cancellation/);
  console.log('PASS: Chromium body cancellation; isolated profile:', root);
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });

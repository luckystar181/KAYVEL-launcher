import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareInstance } from '../../dist/main/prepare-instance.js';
import { writeNewFile } from '../../dist/main/install-files.js';
import { optionalModsMarker } from '../../dist/main/optional-mod-files.js';

const temporary = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : process.cwd();
export const pinnedUrl = 'https://github.com/example/kayvel/releases/download/v0.2.0-v3S/manifest.json';
export const latestUrl = 'https://github.com/example/kayvel/releases/latest/download/manifest.json';
export const keys = generateKeyPairSync('ed25519');
export const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const optionalMod = 'mods/iris-neoforge-1.8.14-beta.1+mc1.21.1.jar';
const required = ['versions/1.21.1/1.21.1.json', 'versions/1.21.1/1.21.1.jar',
  'versions/neoforge-21.1.252/neoforge-21.1.252.json',
  'libraries/net/neoforged/neoforge/21.1.252/neoforge-21.1.252-client.jar',
  'libraries/net/neoforged/neoforge/21.1.252/neoforge-21.1.252-universal.jar',
  'libraries/net/minecraft/client/1.21.1-20240808.144430/client-1.21.1-20240808.144430-srg.jar',
  'libraries/net/minecraft/client/1.21.1-20240808.144430/client-1.21.1-20240808.144430-extra.jar', '.kayvel-neoforge-ready'];

export function signedPack(version = 'v0.2.0-v3S', files = { 'mods/fixture.jar': 'old fictional mod, never executed' }, transform = value => value) {
  const payloads = new Map();
  const manifest = transform({ schemaVersion: 1, buildVersion: version, minecraftVersion: '1.21.1', neoforgeVersion: '21.1.252',
    files: Object.entries(files).map(([path, text], index) => {
      const payload = Buffer.from(text);
      const url = pinnedUrl.replace('v0.2.0-v3S/manifest.json', `${version}/file-${index}.bin`);
      payloads.set(url, payload);
      return { path, size: payload.length, sha256: digest(payload), url };
    }) });
  const bytes = Buffer.from(JSON.stringify(manifest));
  return { manifest, bytes, signature: sign(null, bytes, keys.privateKey).toString('base64'), payloads };
}

export async function preparedFixture(t, pack = signedPack()) {
  const userData = await mkdtemp(join(temporary, 'kayvel-update-test-'));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const root = await prepareInstance(userData, pinnedUrl, publicKey, () => {}, {
    java: async () => 'fictional-java-never-executed',
    minecraft: async files => { for (const path of required.slice(0, 2)) await files.write(path, path); return {}; },
    neoforge: async files => { for (const path of required.slice(2)) await files.write(path, path); },
    modpack: async root => {
      for (const file of pack.manifest.files) await writeNewFile(root, file.path, pack.payloads.get(file.url));
      await writeNewFile(root, '.kayvel/signed-manifest.json', JSON.stringify({ bytes: pack.bytes.toString('base64'), signature: pack.signature }));
      await writeNewFile(root, '.kayvel/optional-mods-managed.json', optionalModsMarker(pack.bytes));
      return pack.manifest.buildVersion;
    }
  });
  return { root, userData, pack };
}

export function mockDownloads(t, pack, override) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url);
    const replacement = await override?.(url, options);
    if (replacement) return replacement;
    if (url === latestUrl || url === pinnedUrl.replace('v0.2.0-v3S', pack.manifest.buildVersion)) return new Response(pack.bytes);
    if (url === pinnedUrl.replace('v0.2.0-v3S', pack.manifest.buildVersion) + '.sig') return new Response(pack.signature);
    const payload = pack.payloads.get(url);
    assert.ok(payload, `Unexpected network request: ${url}`);
    return new Response(payload);
  });
  return calls;
}

export const stopped = async () => {};

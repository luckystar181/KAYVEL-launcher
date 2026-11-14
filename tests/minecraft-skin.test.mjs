import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupMinecraftSkin } from '../dist/main/minecraft-skin.js';

const uuid = '069a79f444e94726a5befca90e38aaf5';
const textureId = 'a'.repeat(64);
const png = Buffer.alloc(24);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
png.writeUInt32BE(64, 16);
png.writeUInt32BE(64, 20);

function mockFetch(skinUrl = `http://textures.minecraft.net/texture/${textureId}`, skinBytes = png) {
  const urls = [];
  const request = async (url, options) => {
    urls.push(url);
    assert.equal(options.redirect, 'error');
    if (url.startsWith('https://api.minecraftservices.com/')) return new Response(JSON.stringify({ id: uuid }), { status: 200 });
    if (url.startsWith('https://sessionserver.mojang.com/')) {
      const value = Buffer.from(JSON.stringify({ textures: { SKIN: { url: skinUrl, metadata: { model: 'slim' } } } })).toString('base64');
      return new Response(JSON.stringify({ properties: [{ name: 'textures', value }] }), { status: 200 });
    }
    return new Response(skinBytes, { status: 200, headers: { 'content-type': 'image/png' } });
  };
  return { request, urls };
}

test('looks up a Minecraft skin only through trusted hosts and returns PNG for preview', async () => {
  const { request, urls } = mockFetch();
  const result = await lookupMinecraftSkin('Notch', request);
  assert.equal(result.ok, true);
  assert.equal(result.model, 'slim');
  assert.deepEqual(result.bytes, [...png]);
  assert.deepEqual(urls, [
    'https://api.minecraftservices.com/minecraft/profile/lookup/name/Notch',
    `https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`,
    `https://textures.minecraft.net/texture/${textureId}`,
  ]);
});

test('accepts legacy 64x32 Minecraft skins for conversion in the renderer', async () => {
  const legacy = Buffer.from(png);
  legacy.writeUInt32BE(32, 20);
  const { request } = mockFetch(undefined, legacy);
  assert.equal((await lookupMinecraftSkin('Notch', request)).ok, true);
});

test('reports unsupported lookup sizes before offering a skin that cannot be saved', async () => {
  const large = Buffer.from(png);
  large.writeUInt32BE(128, 16);
  large.writeUInt32BE(128, 20);
  const { request } = mockFetch(undefined, large);
  const result = await lookupMinecraftSkin('Notch', request);
  assert.equal(result.ok, false);
  assert.match(result.message, /64×64 или 64×32/);
  assert.equal(result.bytes, undefined);
});

test('limits streamed lookup responses and does not retry when a size limit is exceeded', async () => {
  for (const stage of ['identity', 'profile', 'image']) {
    let cancelled = false;
    const chunkSize = stage === 'image' ? 600_000 : 40_000;
    const response = new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(chunkSize)); },
      cancel() { cancelled = true; }
    }), { headers: { 'content-type': 'image/png', 'content-length': '1' } });
    const fallback = mockFetch();
    const urls = [];
    const request = async (url, options) => {
      urls.push(url);
      if ((stage === 'identity' && url.startsWith('https://api.minecraftservices.com/')) ||
          (stage === 'profile' && url.startsWith('https://sessionserver.mojang.com/')) ||
          (stage === 'image' && url.startsWith('https://textures.minecraft.net/'))) return response;
      return fallback.request(url, options);
    };
    const result = await lookupMinecraftSkin('Notch', request);
    assert.equal(result.ok, false);
    assert.equal(result.bytes, undefined);
    assert.equal(cancelled, true);
    assert.equal(urls.length, { identity: 1, profile: 2, image: 3 }[stage]);
  }
});

test('rejects declared oversized responses before reading and cancels without retrying', async () => {
  for (const stage of ['identity', 'profile', 'image']) {
    let cancelled = false;
    let reads = 0;
    const response = new Response(new ReadableStream({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(1)); },
      cancel() { cancelled = true; }
    }, { highWaterMark: 0 }), {
      headers: { 'content-type': 'image/png', 'content-length': stage === 'image' ? '1048577' : '65537' }
    });
    const fallback = mockFetch();
    const urls = [];
    const request = async (url, options) => {
      urls.push(url);
      if ((stage === 'identity' && url.startsWith('https://api.minecraftservices.com/')) ||
          (stage === 'profile' && url.startsWith('https://sessionserver.mojang.com/')) ||
          (stage === 'image' && url.startsWith('https://textures.minecraft.net/'))) return response;
      return fallback.request(url, options);
    };
    const result = await lookupMinecraftSkin('Notch', request);
    assert.equal(result.ok, false);
    assert.equal(result.bytes, undefined);
    assert.equal(cancelled, true);
    assert.equal(reads, 0);
    assert.equal(urls.length, { identity: 1, profile: 2, image: 3 }[stage]);
  }
});

test('rejects invalid nicknames before any request', async () => {
  const { request, urls } = mockFetch();
  assert.equal((await lookupMinecraftSkin('../Notch', request)).ok, false);
  assert.deepEqual(urls, []);
});

test('does not fetch an untrusted texture URL from a profile', async () => {
  const { request, urls } = mockFetch('https://attacker.example/skin.png');
  assert.equal((await lookupMinecraftSkin('Notch', request)).ok, false);
  assert.equal(urls.length, 2);
});

import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

process.once('message', async config => {
  try {
    const realLink = fs.link;
    const realUnlink = fs.unlink;
    const pause = async () => {
      process.channel.ref();
      await new Promise((resolve, reject) => process.send({ type: 'paused', phase: config.phase }, error => error ? reject(error) : resolve()));
      await new Promise(() => {});
    };
    fs.link = async (source, target) => {
      await realLink(source, target);
      if (config.phase === 'after-first-link' && target === join(config.root, 'mods', 'fixture.jar')) await pause();
    };
    fs.unlink = async path => {
      if (config.phase === 'before-marker-unlink' && path === join(config.root, '.kayvel', 'update-incomplete.json')) await pause();
      await realUnlink(path);
      if (config.phase === 'after-first-unlink' && path === join(config.root, 'mods', 'fixture.jar')) await pause();
      if (config.phase === 'after-metadata-unlink' && path === join(config.root, '.kayvel', 'signed-manifest.json')) await pause();
    };
    syncBuiltinESMExports();
    globalThis.fetch = async url => {
      const payload = config.payloads.find(([key]) => key === url);
      if (!payload) throw new Error('Unexpected fixture download: ' + url);
      return new Response(Buffer.from(payload[1], 'base64'));
    };
    const { updateModpack } = await import('../../dist/main/modpack-update.js');
    await updateModpack(config.root, { bytes: Buffer.from(config.bytes, 'base64'), signature: config.signature }, config.publicKey, () => {}, async () => {}, config.pinnedUrl);
    throw new Error('Updater completed without the expected pause');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    process.disconnect();
  }
});

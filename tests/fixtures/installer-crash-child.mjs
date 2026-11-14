import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

process.once('message', async config => {
  try {
    const realLink = fs.link;
    const realUnlink = fs.unlink;
    const pause = async phase => {
      process.channel.ref();
      await new Promise((resolve, reject) => process.send({ type: 'paused', phase }, error => error ? reject(error) : resolve()));
      await new Promise(() => {});
    };
    fs.link = async (source, target) => {
      await realLink(source, target);
      if (config.phase === 'after-first-link' && target === join(config.root, 'mods', 'first.jar')) {
        await pause(config.phase);
      }
    };
    fs.unlink = async path => {
      if (config.phase === 'before-marker-unlink' && path === join(config.root, '.kayvel', 'install-incomplete.json')) {
        await pause(config.phase);
      }
      await realUnlink(path);
    };
    syncBuiltinESMExports();
    globalThis.fetch = async request => {
      if (request === config.manifestUrl) return new Response(Buffer.from(config.bytes, 'base64'));
      if (request === config.manifestUrl + '.sig') return new Response(config.signature);
      const file = config.files.find(item => item.url === request);
      if (file) return new Response(Buffer.from(file.content, 'base64'));
      throw new Error('Unexpected download: ' + request);
    };
    const { installRelease } = await import('../../dist/main/installer.js');
    await installRelease(config.root, config.manifestUrl, config.publicPem);
    process.send({ type: 'unexpected-completion' });
    process.disconnect();
  } catch (error) {
    process.send({ type: 'error', message: error?.stack ?? String(error) }, () => process.disconnect());
  }
});

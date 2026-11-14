import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

async function isolatedMain() {
  const handlers = new Map();
  const sender = { setWindowOpenHandler() {}, on() {} };
  const event = { sender };
  const profile = { nickname: '', skin: null };
  const root = join('fictional-profile', 'launcher');
  let ready;
  const modules = {
    electron: {
      app: { getPath: () => root, whenReady: () => ({ then(callback) { ready = callback; } }), on() {} },
      BrowserWindow: class {
        webContents = sender;
        on() {}
        async loadFile() {}
        isDestroyed() { return false; }
      },
      dialog: { showMessageBox() { throw new Error('No game launch was authorized'); } },
      nativeImage: {},
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
      session: { defaultSession: { setPermissionRequestHandler() {}, webRequest: { onHeadersReceived() {} } } },
      screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 820 } }) }
    },
    'node:fs': { existsSync: () => false },
    'node:path': { join },
    'node:url': { fileURLToPath },
    './installer.js': {},
    './mod-switches.js': {},
    './game-process.js': {},
    './release.js': { MANIFEST_PUBLIC_KEY_PEM: 'fictional-public-key', RELEASE_MANIFEST_URL: '' },
    './java-runtime.js': { availableJava21: () => null },
    './vanilla.js': { VANILLA_VERSION: '1.21.1' },
    './neoforge.js': { NEOFORGE_VERSION: '21.1.252', neoForgeReady: () => false },
    './game-launch-policy.js': {},
    './game-preparation.js': { gamePreparationUnavailable: () => ({ ok: false, message: 'Preparation disabled' }) },
    './minecraft-skin.js': {},
    './local-profile.js': { createLocalProfileStore: path => {
      assert.equal(path, root);
      return {
        read: () => ({ ...profile }),
        saveNickname: nickname => { profile.nickname = nickname; return { ...profile }; },
        saveSkin: (bytes, model) => { profile.skin = { bytes: [...bytes], model }; return { ...profile }; }
      };
    } },
    './game-best.js': { createGameBestStore: () => ({ read: () => 0, save: score => score }) },
    './news.js': { createNewsStore: () => ({ read: () => [] }) }
  };
  const url = new URL('../dist/main/main.js', import.meta.url);
  const source = (await readFile(url, 'utf8')).replace('import.meta.url', JSON.stringify(url.href));
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  runInNewContext(outputText, {
    exports: {},
    URL,
    require(name) {
      assert.ok(Object.hasOwn(modules, name), `Unexpected main dependency: ${name}`);
      return modules[name];
    }
  });
  await ready();
  return { handlers, event, invoke: (channel, ...args) => handlers.get(channel)(event, ...args) };
}

test('main registers local-profile operations but no KAYVEL account or remote skin operations', async () => {
  const main = await isolatedMain();
  assert.deepEqual([...main.handlers.keys()].sort(), [
    'kayvel:game-best', 'kayvel:game-best-save', 'kayvel:install', 'kayvel:install-neoforge', 'kayvel:install-vanilla',
    'kayvel:local-nickname-save', 'kayvel:local-profile', 'kayvel:local-skin-save', 'kayvel:mod-switch-set',
    'kayvel:mod-switches', 'kayvel:news', 'kayvel:play-neoforge', 'kayvel:play-vanilla', 'kayvel:skin-by-nickname', 'kayvel:status'
  ]);
  const status = main.invoke('kayvel:status');
  assert.equal(Object.hasOwn(status, 'apiConfigured'), false);
  assert.equal(Object.hasOwn(status, 'account'), false);
  assert.equal(status.releaseConfigured, false);
  assert.equal(status.javaFound, false);
});

test('main saves nickname and skin through the local store without an account session', async () => {
  const main = await isolatedMain();
  assert.deepEqual(main.invoke('kayvel:local-profile'), { nickname: '', skin: null });
  assert.equal(main.invoke('kayvel:local-nickname-save', 'LocalPlayer').nickname, 'LocalPlayer');
  const profile = main.invoke('kayvel:local-skin-save', new Uint8Array([1, 2, 3]), 'slim');
  assert.deepEqual(profile, { nickname: 'LocalPlayer', skin: { bytes: [1, 2, 3], model: 'slim' } });
  assert.throws(() => main.handlers.get('kayvel:local-nickname-save')({ sender: {} }, 'OtherPlayer'), /Untrusted renderer/);
});

test('main refuses preparation and the old modpack without running installers', async () => {
  const main = await isolatedMain();
  assert.equal(main.invoke('kayvel:install-vanilla').ok, false);
  assert.equal(main.invoke('kayvel:install-neoforge').ok, false);
  assert.equal((await main.invoke('kayvel:install')).ok, false);
  assert.equal((await main.handlers.get('kayvel:install')({ sender: {} })).message, 'Недоступно.');
  assert.equal((await main.invoke('kayvel:play-vanilla', 'ru')).ok, false);
  assert.equal((await main.invoke('kayvel:play-neoforge', 'ru')).ok, false);
});

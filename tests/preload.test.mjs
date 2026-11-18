import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function loadPreload(ipcRenderer) {
  let api;
  const source = await readFile(new URL('../dist/main/preload.cjs', import.meta.url), 'utf8');
  runInNewContext(source, {
    require: name => {
      assert.equal(name, 'electron');
      return { ipcRenderer, contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } } };
    }
  });
  return api;
}

test('preload exposes a local profile, not KAYVEL sign-in or account administration', async () => {
  const calls = [];
  const ipcRenderer = new EventEmitter();
  ipcRenderer.invoke = (...args) => { calls.push(args); return Promise.resolve({}); };
  const api = await loadPreload(ipcRenderer);
  assert.deepEqual(Object.keys(api).sort(), [
    'cancelDownload', 'checkModpackUpdates', 'downloadAndPlay', 'gameBest', 'install', 'installNeoForge', 'installVanilla', 'localProfile', 'memorySettings', 'modSwitches', 'onGameExit', 'onPreparationProgress', 'openGameFolder',
    'playNeoForge', 'playVanilla', 'retryDownload', 'saveGameBest', 'saveLocalNickname', 'saveLocalSkin', 'saveMemoryMb', 'setModEnabled', 'status', 'updateModpack', 'window'
  ]);
  await api.localProfile();
  await api.saveLocalNickname('LocalPlayer');
  const png = new Uint8Array([1, 2, 3]);
  await api.saveLocalSkin(png, 'slim');
  await api.memorySettings();
  await api.saveMemoryMb(8192);
  await api.openGameFolder('ru');
  await api.checkModpackUpdates({ url: 'https://untrusted.invalid' }, 'C:\\untrusted');
  await api.updateModpack({ signature: 'untrusted', bytes: 'untrusted' }, 'C:\\untrusted');
  assert.deepEqual(calls, [
    ['kayvel:local-profile'], ['kayvel:local-nickname-save', 'LocalPlayer'], ['kayvel:local-skin-save', png, 'slim'],
    ['kayvel:memory-settings'], ['kayvel:memory-save', 8192], ['kayvel:open-game-folder', 'ru'],
    ['kayvel:modpack-check'], ['kayvel:modpack-update']
  ]);
});

test('preload forwards the complete game exit event and unsubscribes', async () => {
  const ipcRenderer = new EventEmitter();
  const api = await loadPreload(ipcRenderer);
  const received = [];
  const unsubscribe = api.onGameExit(exit => received.push(exit));
  const exit = { code: -1, gamePath: 'C:\\KAYVEL\\game' };
  ipcRenderer.emit('kayvel:game-exit', {}, exit);
  unsubscribe();
  ipcRenderer.emit('kayvel:game-exit', {}, { code: 0, gamePath: 'other' });
  assert.deepEqual(received, [exit]);
});

test('preload forwards one-click language and progress without exposing the IPC event', async () => {
  const ipcRenderer = new EventEmitter();
  const calls = [];
  ipcRenderer.invoke = (...args) => { calls.push(args); return Promise.resolve({ ok: false }); };
  const api = await loadPreload(ipcRenderer);
  await api.downloadAndPlay('en');
  assert.deepEqual(calls, [['kayvel:download-and-play', 'en']]);
  const received = [];
  const unsubscribe = api.onPreparationProgress((...args) => received.push(args));
  const progress = { stage: 'minecraft', received: 5, total: null, file: 'fixture', completedFiles: 0, totalFiles: null };
  ipcRenderer.emit('kayvel:preparation-progress', { sender: 'not exposed' }, progress);
  assert.deepEqual(received, [[progress]]);
  unsubscribe();
  unsubscribe();
  assert.equal(ipcRenderer.listenerCount('kayvel:preparation-progress'), 0);
  ipcRenderer.emit('kayvel:preparation-progress', {}, { ...progress, stage: 'ready' });
  assert.equal(received.length, 1);
});

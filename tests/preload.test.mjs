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
    'gameBest', 'install', 'installNeoForge', 'installVanilla', 'localProfile', 'modSwitches', 'news', 'onGameExit',
    'playNeoForge', 'playVanilla', 'saveGameBest', 'saveLocalNickname', 'saveLocalSkin', 'setModEnabled', 'skinByNickname', 'status', 'window'
  ]);
  await api.localProfile();
  await api.saveLocalNickname('LocalPlayer');
  const png = new Uint8Array([1, 2, 3]);
  await api.saveLocalSkin(png, 'slim');
  assert.deepEqual(calls, [
    ['kayvel:local-profile'], ['kayvel:local-nickname-save', 'LocalPlayer'], ['kayvel:local-skin-save', png, 'slim']
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

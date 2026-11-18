import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { memoryLaunchOptions } from '../dist/main/memory-settings.js';
import { stageProgress } from '../dist/main/preparation-progress.js';
import { EventEmitter } from 'node:events';
import { createGameExitReporter, watchLockedGame } from '../dist/main/game-process.js';
import { MANIFEST_PUBLIC_KEY_PEM, RELEASE_MANIFEST_URL } from '../dist/main/release.js';
import { createPublicKey } from 'node:crypto';
import { compareModpackVersions, modpackReleaseUrl } from '../dist/main/modpack-channel.js';

const missingEntry = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
const fixtureCandidate = { manifest: { buildVersion: 'v0.2.2-v3S' }, bytes: Buffer.from('fixture'), signature: 'fixture' };

test('published local-profile release is configured without the historical Core release', async () => {
  assert.equal(RELEASE_MANIFEST_URL, 'https://github.com/luckystar181/KAYVEL-mods/releases/download/v0.2.0-v3S/manifest.json');
  assert.equal(createPublicKey(MANIFEST_PUBLIC_KEY_PEM).asymmetricKeyType, 'ed25519');
  const source = await readFile(new URL('../dist/main/main.js', import.meta.url), 'utf8');
  assert.ok(source.includes('const localProfileReleaseReady = true;'));
});

async function isolatedMain({ activateRelease = false, nickname = '', overrides = {}, confirm, openPath = async () => '' } = {}) {
  const handlers = new Map();
  const sent = [];
  const sender = { setWindowOpenHandler() {}, on() {}, send: (...args) => sent.push(args) };
  const event = { sender };
  const profile = { nickname, skin: null };
  const root = join('fictional-profile', 'launcher');
  let ready;
  const modules = {
    electron: {
      shell: { openPath },
      app: { getPath: () => root, whenReady: () => ({ then(callback) { ready = callback; } }), on() {} },
      BrowserWindow: class {
        webContents = sender;
        on() {}
        async loadFile() {}
        isDestroyed() { return false; }
      },
      dialog: { showMessageBox: confirm ?? (() => { throw new Error('No game launch was authorized'); }) },
      nativeImage: {},
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
      session: { defaultSession: { setPermissionRequestHandler() {}, webRequest: { onHeadersReceived() {} } } },
      screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 820 } }) }
    },
    'node:fs': { existsSync: () => false, lstatSync: missingEntry },
    'node:path': { join },
    'node:url': { fileURLToPath },
    './installer.js': { getInstalledManifest: async () => undefined },
    './modpack-channel.js': { compareModpackVersions, modpackReleaseUrl, discoverModpack: async () => fixtureCandidate },
    './modpack-update.js': { updateModpack: () => assert.fail('Unexpected modpack update') },
    './mod-switches.js': {},
    './game-process.js': {},
    './release.js': { MANIFEST_PUBLIC_KEY_PEM: 'fictional-public-key', RELEASE_MANIFEST_URL: activateRelease ? 'https://github.com/example/kayvel/releases/download/fixture/manifest.json' : '' },
    './java-runtime.js': { availableJava21: () => assert.fail('Status polling must not execute Java probes') },
    './vanilla.js': { VANILLA_VERSION: '1.21.1', validateNickname: value => { if (!/^[A-Za-z0-9_]{3,16}$/.test(value)) throw new Error('Invalid fixture nickname'); return value; } },
    './neoforge.js': { NEOFORGE_VERSION: '21.1.252', neoForgeReady: () => false },
    './game-launch-policy.js': {},
    './memory-settings.js': { createMemorySettingsStore: () => {
      let memoryMb = 6144;
      const read = () => ({ memoryMb, minMemoryMb: 2048, maxMemoryMb: 14336, totalMemoryMb: 16384 });
      return { read, save: value => { memoryMb = memoryLaunchOptions(value).maxMemory; return read(); } };
    } },
    './game-preparation.js': { gamePreparationUnavailable: () => ({ ok: false, message: 'Preparation disabled' }) },
    './local-profile.js': { createLocalProfileStore: path => {
      assert.equal(path, root);
      return {
        read: () => ({ ...profile }),
        saveNickname: nickname => { profile.nickname = nickname; return { ...profile }; },
        saveSkin: (bytes, model) => { profile.skin = { bytes: [...bytes], model }; return { ...profile }; }
      };
    } },
    './game-skin.js': { applyLocalSkin: () => assert.fail('Unexpected skin application') },
    './game-best.js': { createGameBestStore: () => ({ read: () => 0, save: score => score }) },
    './prepare-instance.js': { instancePath: path => join(path, 'instances', 'kayvel-1.21.1-neoforge-21.1.252-v3S') },
    './preparation-progress.js': { stageProgress },
    ...overrides
  };
  const url = new URL('../dist/main/main.js', import.meta.url);
  let source = (await readFile(url, 'utf8')).replace('import.meta.url', JSON.stringify(url.href));
  assert.match(source, /const localProfileReleaseReady = (?:true|false);/);
  source = source.replace(/const localProfileReleaseReady = (?:true|false);/, `const localProfileReleaseReady = ${activateRelease};`);
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  runInNewContext(outputText, {
    exports: {},
    URL,
    Error,
    require(name) {
      assert.ok(Object.hasOwn(modules, name), `Unexpected main dependency: ${name}`);
      return modules[name];
    }
  });
  await ready();
  return { handlers, event, sent, invoke: (channel, ...args) => handlers.get(channel)(event, ...args) };
}

test('main registers local-profile operations but no KAYVEL account or remote skin operations', async () => {
  const main = await isolatedMain();
  assert.deepEqual([...main.handlers.keys()].sort(), [
    'kayvel:download-and-play', 'kayvel:game-best', 'kayvel:game-best-save', 'kayvel:install', 'kayvel:install-neoforge', 'kayvel:install-vanilla',
    'kayvel:local-nickname-save', 'kayvel:local-profile', 'kayvel:local-skin-save', 'kayvel:memory-save', 'kayvel:memory-settings',
    'kayvel:mod-switch-set', 'kayvel:mod-switches', 'kayvel:modpack-check', 'kayvel:modpack-update', 'kayvel:open-game-folder', 'kayvel:play-neoforge', 'kayvel:play-vanilla', 'kayvel:status'
  ]);
  const status = main.invoke('kayvel:status');
  assert.equal(Object.hasOwn(status, 'apiConfigured'), false);
  assert.equal(Object.hasOwn(status, 'account'), false);
  assert.equal(status.releaseConfigured, false);
  assert.equal(Object.hasOwn(status, 'javaFound'), false);
});

test('game folder IPC opens only the fixed modded instance for a trusted renderer', async () => {
  const opened = [];
  const checked = [];
  const main = await isolatedMain({
    openPath: async path => { opened.push(path); return ''; },
    overrides: { 'node:fs': { existsSync: () => false, lstatSync: path => {
      checked.push(path);
      return { isDirectory: () => true, isSymbolicLink: () => false };
    } } }
  });
  const expected = main.invoke('kayvel:status').gamePath;
  const result = await main.invoke('kayvel:open-game-folder', 'C:\\untrusted.exe', 'https://example.com');
  assert.equal(result.ok, true);
  assert.deepEqual(checked, [expected]);
  assert.deepEqual(opened, [expected]);
  await assert.rejects(main.handlers.get('kayvel:open-game-folder')({ sender: {} }, 'ru'), /Untrusted renderer/);
  assert.equal(opened.length, 1);
});

test('game folder IPC reports missing folders and shell failures without creating or repairing anything', async () => {
  for (const scenario of ['missing', 'file', 'link', 'shell-error', 'shell-throw']) {
    let opens = 0;
    const main = await isolatedMain({
      openPath: async () => {
        opens++;
        if (scenario === 'shell-throw') throw new Error('private shell detail');
        return 'private shell detail';
      },
      overrides: { 'node:fs': { existsSync: () => false, lstatSync: () => {
        if (scenario === 'missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return { isDirectory: () => scenario !== 'file', isSymbolicLink: () => scenario === 'link' };
      } } }
    });
    for (const language of ['ru', 'en']) {
      const result = await main.invoke('kayvel:open-game-folder', language);
      assert.equal(result.ok, false);
      assert.doesNotMatch(result.message, /private shell detail/);
      if (scenario === 'missing') assert.match(result.message, language === 'ru' ? /Сначала скачайте сборку/ : /Download the modpack first/);
    }
    assert.equal(opens, scenario.startsWith('shell-') ? 2 : 0);
  }
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
  assert.equal((await main.invoke('kayvel:download-and-play', 'ru')).ok, false);
  assert.equal((await main.handlers.get('kayvel:download-and-play')({ sender: {} }, 'ru')).message, 'Недоступно.');
  assert.equal(main.invoke('kayvel:status').preparationProgress, null);
  assert.match(main.invoke('kayvel:status').gamePath, /instances/);
  assert.equal((await main.invoke('kayvel:play-neoforge', 'ru')).ok, false);
});

function preparedModules(prepareInstance, extra = {}) {
  return {
    'node:fs': { existsSync: path => path.endsWith(join('.preparation', 'ready.json')) || path.endsWith(join('instances', 'fixture')), lstatSync: missingEntry },
    './prepare-instance.js': {
      instancePath: path => join(path, 'instances', 'fixture'), prepareInstance,
      verifyPreparation: async () => { assert.fail('Verification after a declined launch'); },
      preparedJava: () => { assert.fail('Java after a declined launch'); },
      ...extra
    },
    './neoforge.js': { NEOFORGE_VERSION: '21.1.252', neoForgeReady: () => true, launchNeoForge: () => assert.fail('Real games are never launched by this test') }
  };
}

test('one-click reports preparation progress and launches directly without a confirmation', async () => {
  const { main, order, child } = await launchFixture(async (child, observe) => { observe(child); });
  assert.equal((await main.invoke('kayvel:download-and-play', 'ru')).ok, true);
  child.emit('exit', 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await main.invoke('kayvel:download-and-play', 'ru')).ok, true);
  assert.equal(order.filter(step => step === 'prepare').length, 2);
  assert.equal(order.includes('confirm'), false);
  assert.equal(main.invoke('kayvel:status').gameRunning, true);
  assert.equal(main.invoke('kayvel:status').preparationProgress, null);
});

test('one-click validates nickname before preparing or opening a launch confirmation', async () => {
  const main = await isolatedMain({ activateRelease: true,
    overrides: preparedModules(async () => assert.fail('Invalid nickname must stop preparation'))
  });
  const result = await main.invoke('kayvel:download-and-play', 'ru');
  assert.equal(result.ok, false);
  assert.match(result.message, /nickname/);
  assert.equal(main.invoke('kayvel:status').preparationProgress.stage, 'error');
});

test('one-click prevents concurrent preparation, launch and mod switches, with no retry after failure', async () => {
  let rejectPreparation;
  const stalled = new Promise((_resolve, reject) => { rejectPreparation = reject; });
  let calls = 0;
  const main = await isolatedMain({ activateRelease: true, nickname: 'LocalPlayer',
    overrides: preparedModules(() => { calls++; return stalled; })
  });
  const first = main.invoke('kayvel:download-and-play', 'ru');
  assert.equal(main.invoke('kayvel:status').preparingNeoForge, true);
  for (const channel of ['kayvel:download-and-play', 'kayvel:play-neoforge', 'kayvel:play-vanilla', 'kayvel:mod-switch-set']) {
    assert.equal((await main.invoke(channel, 'ru')).ok, false);
  }
  rejectPreparation(new Error('fixture preparation failed'));
  assert.equal((await first).ok, false);
  assert.equal(calls, 1);
  assert.equal(main.invoke('kayvel:status').preparingNeoForge, false);
  assert.equal(main.invoke('kayvel:status').preparationProgress.stage, 'error');
});

test('discovery failure reports its phase before preparing any instance and allows only an explicit retry', async () => {
  let calls = 0;
  let rejectDiscovery;
  const stalled = new Promise((_resolve, reject) => { rejectDiscovery = reject; });
  const main = await isolatedMain({ activateRelease: true, nickname: 'LocalPlayer', overrides: {
    ...preparedModules(async () => assert.fail('Discovery failure must not prepare an instance')),
    'node:fs': { existsSync: () => false, lstatSync: missingEntry },
    './modpack-channel.js': { compareModpackVersions, modpackReleaseUrl, discoverModpack: () => { calls++; return stalled; } }
  } });
  const pending = main.invoke('kayvel:download-and-play', 'ru');
  assert.equal(main.invoke('kayvel:status').preparingNeoForge, true);
  assert.equal(main.invoke('kayvel:status').preparationProgress.stage, 'discovery');
  assert.equal((await main.invoke('kayvel:download-and-play', 'ru')).ok, false);
  assert.equal(calls, 1);
  rejectDiscovery(new Error('github.com [ENOTFOUND]: fixture DNS failure'));
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.message, /^Проверка доступной сборки:.*ENOTFOUND/);
  assert.doesNotMatch(result.message, /сохранены|Подготовка экземпляра/);
  const status = main.invoke('kayvel:status');
  assert.equal(status.preparingNeoForge, false);
  assert.equal(status.preparationProgress.stage, 'error');
  assert.equal(status.preparationProgress.file, result.message);
  assert.equal(calls, 1);
  assert.equal((await main.invoke('kayvel:download-and-play', 'ru')).ok, false);
  assert.equal(calls, 2);
});

test('direct launch still performs final verification and releases its lock on failure', async () => {
  const order = [];
  const main = await isolatedMain({ activateRelease: true, nickname: 'LocalPlayer',
    confirm: async () => { order.push('confirm'); return { response: 1 }; },
    overrides: {
      ...preparedModules(async () => { order.push('prepare'); }, { verifyPreparation: async () => { order.push('verify'); throw new Error('fixture changed files'); } }),
      './installer.js': { acquireGameDirectoryLock: async () => { order.push('lock'); return async () => { order.push('unlock'); }; } }
    }
  });
  const result = await main.invoke('kayvel:download-and-play', 'ru');
  assert.equal(result.ok, false);
  assert.match(result.message, /changed files/);
  assert.deepEqual(order, ['prepare', 'lock', 'verify', 'unlock']);
  assert.equal(main.invoke('kayvel:status').preparingNeoForge, false);
  assert.equal(main.invoke('kayvel:status').gameRunning, false);
  assert.equal(main.invoke('kayvel:status').preparationProgress.stage, 'error');
});

for (const state of ['missing-record', 'incomplete', 'recorded']) {
  test(`readiness requires a preparation record and no incomplete marker: ${state}`, async () => {
    const main = await isolatedMain({ activateRelease: true, nickname: 'LocalPlayer', overrides: {
      ...preparedModules(async () => {}),
      'node:fs': { existsSync: path => path.endsWith(join('.preparation', 'ready.json')) ? state !== 'missing-record'
        : path.endsWith(join('.preparation', 'incomplete.json')) ? state === 'incomplete' : false, lstatSync: missingEntry }
    } });
    assert.equal(main.invoke('kayvel:status').neoforgeReady, state === 'recorded');
    if (state !== 'recorded') assert.equal((await main.invoke('kayvel:play-neoforge', 'ru')).ok, false);
  });
}

async function launchFixture(launch) {
  const order = [];
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null });
  const dependencies = preparedModules(async () => { order.push('prepare'); }, {
    verifyPreparation: async () => { order.push('verify'); },
    preparedJava: () => { order.push('java'); return 'fictional-java-never-executed'; }
  });
  const main = await isolatedMain({ activateRelease: true, nickname: 'LocalPlayer',
    confirm: async () => { order.push('confirm'); return { response: 1 }; },
    overrides: {
      ...dependencies,
      './installer.js': { acquireGameDirectoryLock: async () => { order.push('lock'); return async () => { order.push('unlock'); }; } },
      './game-process.js': { createGameExitReporter, watchLockedGame },
      './game-skin.js': { applyLocalSkin: (path, profile) => {
        order.push('skin');
        assert.match(path, /instances/);
        assert.equal(profile.nickname, 'LocalPlayer');
      } },
      './neoforge.js': { ...dependencies['./neoforge.js'], launchNeoForge: async (path, name, java, observe, memoryMb) => {
        order.push('launch');
        assert.equal(memoryMb, main.invoke('kayvel:memory-settings').memoryMb);
        assert.equal(name, 'LocalPlayer');
        assert.equal(java, 'fictional-java-never-executed');
        assert.match(path, /instances/);
        await launch(child, observe);
      } }
    }
  });
  return { main, order, child };
}

test('RAM IPC validates the sender, saves the selection and passes it to launch', async () => {
  const { main, child } = await launchFixture(async (child, observe) => { observe(child); });
  assert.equal(main.invoke('kayvel:memory-settings').memoryMb, 6144);
  assert.throws(() => main.handlers.get('kayvel:memory-save')({ sender: {} }, 8192), /Untrusted/);
  assert.throws(() => main.invoke('kayvel:memory-save', '--inject'), /ОЗУ/);
  assert.equal(main.invoke('kayvel:memory-save', 8192).memoryMb, 8192);
  assert.equal((await main.invoke('kayvel:download-and-play', 'ru')).ok, true);
  assert.throws(() => main.invoke('kayvel:memory-save', 4096), /завершения/);
  child.emit('exit', 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(main.invoke('kayvel:memory-save', 4096).memoryMb, 4096);
});

test('successful one-click observes a fictional process and holds its lock until one exit notification', async () => {
  const { main, order, child } = await launchFixture(async (child, observe) => { observe(child); });
  const result = await main.invoke('kayvel:download-and-play', 'en');
  assert.equal(result.ok, true);
  assert.equal(result.message, '');
  assert.deepEqual(order, ['prepare', 'lock', 'verify', 'skin', 'java', 'launch']);
  assert.equal(main.invoke('kayvel:status').gameRunning, true);
  assert.equal(main.invoke('kayvel:status').preparingNeoForge, false);
  assert.equal(main.invoke('kayvel:status').preparationProgress, null);
  assert.match(main.invoke('kayvel:status').activeGamePath, /instances/);
  assert.equal((await main.invoke('kayvel:download-and-play', 'en')).ok, false);
  child.emit('exit', 0);
  child.emit('exit', 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(order.filter(step => step === 'unlock').length, 1);
  assert.equal(main.invoke('kayvel:status').gameRunning, false);
  assert.equal(main.invoke('kayvel:status').activeGamePath, null);
  assert.equal(main.invoke('kayvel:status').preparationProgress, null);
  assert.equal(main.sent.filter(([channel, value]) => channel === 'kayvel:preparation-progress' && value === null).length, 2);
  const exits = main.sent.filter(([channel]) => channel === 'kayvel:game-exit');
  assert.equal(exits.length, 1);
  assert.equal(exits[0][1].code, 0);
});

test('launch failure before process observation releases the lock and reports error without retry', async () => {
  const { main, order } = await launchFixture(async () => { throw new Error('fixture spawn failed'); });
  const result = await main.invoke('kayvel:download-and-play', 'ru');
  assert.equal(result.ok, false);
  assert.match(result.message, /spawn failed/);
  assert.equal(order.filter(step => step === 'launch').length, 1);
  assert.equal(order.at(-1), 'unlock');
  assert.equal(main.invoke('kayvel:status').gameRunning, false);
  assert.equal(main.invoke('kayvel:status').preparingNeoForge, false);
  assert.equal(main.invoke('kayvel:status').preparationProgress.stage, 'error');
});

test('missing process observation keeps the lock and blocks another launch after an ambiguous result', async () => {
  const { main, order } = await launchFixture(async () => {});
  const result = await main.invoke('kayvel:download-and-play', 'ru');
  assert.equal(result.ok, false);
  assert.match(result.message, /блокировка сохранена/);
  assert.equal(order.includes('unlock'), false);
  assert.equal(main.invoke('kayvel:status').gameRunning, true);
  assert.equal(main.invoke('kayvel:status').preparationProgress.stage, 'error');
  assert.equal((await main.invoke('kayvel:download-and-play', 'ru')).ok, false);
  assert.equal(order.filter(step => step === 'launch').length, 1);
});

for (const failSkin of [false, true]) {
  test(`skin application uses the launch profile snapshot under lock before Java; failure=${failSkin}`, async () => {
    const order = [];
    const selected = { nickname: 'LocalPlayer', skin: { model: 'slim', bytes: [1, 2, 3] } };
    let current = selected;
    const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null });
    const dependencies = preparedModules(async () => assert.fail('Direct launch does not prepare'), {
      verifyPreparation: async () => { order.push('verify'); },
      preparedJava: () => { order.push('java'); return 'fixture-java'; }
    });
    const main = await isolatedMain({ activateRelease: true, overrides: {
      ...dependencies,
      './local-profile.js': { createLocalProfileStore: () => ({ read: () => { order.push('profile'); return current; } }) },
      './installer.js': { acquireGameDirectoryLock: async () => {
        order.push('lock');
        current = { nickname: 'NewPlayer', skin: null };
        return async () => { order.push('unlock'); };
      } },
      './game-skin.js': { applyLocalSkin: (_path, profile) => {
        order.push('skin');
        assert.equal(profile, selected);
        if (failSkin) throw new Error('fixture skin conflict');
      } },
      './game-process.js': { createGameExitReporter, watchLockedGame },
      './neoforge.js': { ...dependencies['./neoforge.js'], launchNeoForge: async (_path, name, _java, observe) => {
        order.push('launch');
        assert.equal(name, selected.nickname);
        observe(child);
      } }
    } });
    const result = await main.invoke('kayvel:play-neoforge', 'ru');
    assert.equal(result.ok, !failSkin);
    assert.deepEqual(order, failSkin ? ['profile', 'lock', 'verify', 'skin', 'unlock'] : ['profile', 'lock', 'verify', 'skin', 'java', 'launch']);
    assert.equal(main.invoke('kayvel:status').gameRunning, !failSkin);
    if (failSkin) assert.match(result.message, /skin conflict/);
    else {
      assert.equal(result.message, '');
      child.emit('exit', 0);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(order.at(-1), 'unlock');
    }
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function updateMain({ installedVersion = 'v0.2.0-v3S', installedBytes = Buffer.from('old'), discover, apply, ...options } = {}) {
  return isolatedMain({ activateRelease: true, nickname: 'LocalPlayer', ...options, overrides: {
    './installer.js': { getInstalledManifest: async () => installedVersion ? { manifest: { buildVersion: installedVersion }, bytes: installedBytes } : undefined },
    './modpack-channel.js': { compareModpackVersions, modpackReleaseUrl, discoverModpack: discover ?? (async () => fixtureCandidate) },
    './modpack-update.js': { updateModpack: apply ?? (() => assert.fail('No automatic update is authorized')) },
    ...options.overrides
  } });
}

for (const [installedVersion, installedBytes, expected] of [
  ['v0.2.0-v3S', Buffer.from('old'), 'available'],
  ['v0.2.2-v3S', fixtureCandidate.bytes, 'current'],
  ['v0.2.2-v3S', Buffer.from('republished'), 'error'],
  ['v0.2.3-v3S', Buffer.from('newer'), 'error'],
  [null, null, 'not-installed']
]) {
  test(`update IPC classifies installed version without applying or launching: ${installedVersion}/${expected}`, async () => {
    const main = await updateMain({ installedVersion, installedBytes });
    const result = await main.invoke('kayvel:modpack-check', { url: 'https://untrusted.invalid', path: 'C:\\untrusted' });
    assert.equal(result.state, expected);
    assert.equal(main.invoke('kayvel:status').modpackUpdate.state, expected);
    assert.equal(main.invoke('kayvel:status').gameRunning, false);
    assert.equal(Object.hasOwn(result, 'bytes'), false);
    assert.equal(Object.hasOwn(result, 'signature'), false);
    result.state = 'available';
    if (expected !== 'available') assert.equal((await main.invoke('kayvel:modpack-update', fixtureCandidate)).ok, false);
  });
}

test('update IPC requires trusted sender and a private checked candidate, ignoring all caller arguments', async () => {
  const calls = [];
  const main = await updateMain({ apply: async (...args) => {
    calls.push(args);
    return { version: fixtureCandidate.manifest.buildVersion, backup: 'fixture-backup' };
  } });
  assert.throws(() => main.handlers.get('kayvel:modpack-check')({ sender: {} }), /Untrusted renderer/);
  assert.equal((await main.handlers.get('kayvel:modpack-update')({ sender: {} }, fixtureCandidate)).ok, false);
  assert.equal((await main.invoke('kayvel:modpack-update', fixtureCandidate)).ok, false);
  await main.invoke('kayvel:modpack-check');
  const result = await main.invoke('kayvel:modpack-update', { bytes: 'untrusted', signature: 'untrusted', manifest: { buildVersion: 'v99.0.0-v3S' } }, 'C:\\untrusted');
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], main.invoke('kayvel:status').gamePath);
  assert.equal(calls[0][1], fixtureCandidate);
  assert.equal(calls[0][2], 'fictional-public-key');
  assert.equal(typeof calls[0][3], 'function');
  assert.equal(calls[0].length, 4);
  assert.equal(main.invoke('kayvel:status').modpackUpdate.state, 'current');
  assert.equal(main.invoke('kayvel:status').installing, false);
  assert.equal(main.invoke('kayvel:status').gameRunning, false);
  assert.equal((await main.invoke('kayvel:modpack-update')).ok, false);
});

test('checking is coalesced and updating blocks competing preparation, launch, switches and checks', async () => {
  const discovery = deferred();
  const application = deferred();
  let discoveries = 0;
  let updates = 0;
  const main = await updateMain({
    discover: async () => { discoveries++; return discovery.promise; },
    apply: async () => { updates++; return application.promise; }
  });
  const checking = main.invoke('kayvel:modpack-check');
  assert.equal((await main.invoke('kayvel:modpack-check')).state, 'checking');
  assert.equal((await main.invoke('kayvel:modpack-update')).ok, false);
  discovery.resolve(fixtureCandidate);
  await checking;
  const updating = main.invoke('kayvel:modpack-update');
  assert.equal(main.invoke('kayvel:status').installing, true);
  assert.equal((await main.invoke('kayvel:modpack-check')).state, 'updating');
  for (const channel of ['kayvel:modpack-update', 'kayvel:download-and-play', 'kayvel:play-neoforge', 'kayvel:play-vanilla', 'kayvel:mod-switch-set']) {
    assert.equal((await main.invoke(channel)).ok, false, channel);
  }
  application.resolve({ version: 'v0.2.2-v3S', backup: 'fixture-backup' });
  assert.equal((await updating).ok, true);
  assert.equal(discoveries, 1);
  assert.equal(updates, 1);
});

for (const phase of ['discovery', 'application']) {
  test(`update IPC clears candidate and busy state after ${phase} error`, async () => {
    let calls = 0;
    const main = await updateMain({
      discover: async () => { if (phase === 'discovery') throw new Error('fixture discovery failure'); return fixtureCandidate; },
      apply: async () => { calls++; throw new Error('fixture application failure'); }
    });
    await main.invoke('kayvel:modpack-check');
    if (phase === 'application') assert.equal((await main.invoke('kayvel:modpack-update')).ok, false);
    const status = main.invoke('kayvel:status');
    assert.equal(status.modpackUpdate.state, 'error');
    assert.match(status.modpackUpdate.message, /fixture .* failure/);
    assert.equal(status.installing, false);
    assert.equal(status.gameRunning, false);
    assert.equal((await main.invoke('kayvel:modpack-update')).ok, false);
    assert.equal(calls, phase === 'application' ? 1 : 0);
  });
}

test('incomplete update blocks discovery and readiness even for an otherwise prepared instance', async () => {
  const main = await updateMain({ overrides: {
    ...preparedModules(async () => assert.fail('Unexpected preparation')),
    'node:fs': { existsSync: () => true, lstatSync: () => ({}) }
  } });
  assert.equal(main.invoke('kayvel:status').neoforgeReady, false);
  assert.equal((await main.invoke('kayvel:modpack-check')).state, 'error');
  assert.equal((await main.invoke('kayvel:play-neoforge')).ok, false);
});

for (const existing of [false, true]) {
  test(`initial preparation uses latest only for a fresh instance; existing=${existing}`, async () => {
    const prepared = [];
    let discoveries = 0;
    const main = await updateMain({ overrides: {
      'node:fs': { existsSync: () => existing, lstatSync: missingEntry },
      './modpack-channel.js': { compareModpackVersions, modpackReleaseUrl, discoverModpack: async () => { discoveries++; return fixtureCandidate; } },
      './prepare-instance.js': {
        instancePath: path => join(path, 'instances', 'fixture'),
        prepareInstance: async (...args) => { prepared.push(args); throw new Error('stop before any launch'); }
      }
    } });
    assert.equal((await main.invoke('kayvel:download-and-play')).ok, false);
    assert.equal(discoveries, existing ? 0 : 1);
    assert.equal(prepared.length, 1);
    assert.match(prepared[0][1], existing ? /\/fixture\/manifest.json$/ : /\/v0.2.2-v3S\/manifest.json$/);
    assert.equal(prepared[0][5], existing ? undefined : fixtureCandidate.bytes);
    assert.equal(main.invoke('kayvel:status').gameRunning, false);
  });
}

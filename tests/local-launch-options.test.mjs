import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { memoryLaunchOptions } from '../dist/main/memory-settings.js';
import ts from 'typescript';

const require = createRequire(import.meta.url);

test('NeoForge launch options use only a local profile and preserve the process observer without ticket bridge', async () => {
  const calls = [];
  const child = { fixture: 'not a real process' };
  const modules = {
    '@xmcl/core': { launch: async options => options },
    'node:child_process': { spawn: (...args) => { calls.push(args); return child; } },
    './vanilla.js': { validateNickname: value => value, offlineUUID: () => 'fictional-offline-uuid', VANILLA_VERSION: '1.21.1' },
    './memory-settings.js': { memoryLaunchOptions },
    './game-preparation.js': { assertGamePreparationAllowed() { throw new Error('No installation authorized'); } }
  };
  const source = await readFile(new URL('../dist/main/neoforge.js', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const exports = {};
  runInNewContext(outputText, { exports, require(name) {
    if (Object.hasOwn(modules, name)) return modules[name];
    assert.ok(['node:crypto', 'node:fs', 'node:fs/promises', 'node:path'].includes(name), `Unexpected dependency: ${name}`);
    return require(name);
  } });
  let observed;
  const options = await exports.launchNeoForge('fictional-game', 'LocalPlayer', 'fictional-java', process => { observed = process; }, 8192);
  assert.equal(options.minMemory, 1024);
  assert.equal(options.maxMemory, 8192);
  assert.equal(options.gamePath, 'fictional-game');
  assert.equal(options.javaPath, 'fictional-java');
  assert.equal(options.gameProfile.name, 'LocalPlayer');
  assert.equal(options.gameProfile.id, 'fictional-offline-uuid');
  assert.equal(options.accessToken, '0');
  assert.equal(options.userType, 'legacy');
  assert.equal(Object.hasOwn(options.extraExecOption, 'env'), false);
  assert.equal(options.extraExecOption.windowsHide, false);
  assert.equal(options.spawn('fictional-java', ['fixture'], { fixture: true }), child);
  assert.equal(observed, child);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'fictional-java');
  assert.doesNotMatch(source, /ticketBridge|KAYVEL_TICKET_/);
});

test('the clean repository contains no historical account modules or service integration entry points', async () => {
  for (const path of ['src/main/auth.ts', 'src/main/game-bridge-session.ts', 'src/main/ticket-bridge.ts', 'integration', 'api', 'core']) {
    await assert.rejects(lstat(new URL(`../${path}`, import.meta.url)), { code: 'ENOENT' });
  }
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(packageJson.scripts).some(name => /core|restart|auth/.test(name)), false);
  const renderer = await readFile(new URL('../src/renderer/app.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(renderer, /account-form|owner-panel|issued-password|kayvel\.(?:login|logout|accounts|changePassword)\b/);
});

test('portable packaging requests only offline dependencies and disables their lifecycle scripts', async () => {
  const source = await readFile(new URL('../scripts/package-portable.mjs', import.meta.url), 'utf8');
  assert.match(source, /'ci', '--offline', '--omit=dev', '--ignore-scripts'/);
});

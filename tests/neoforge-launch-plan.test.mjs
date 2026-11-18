import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delimiter, join } from 'node:path';
import { generateArguments } from '@xmcl/core';
import { memoryLaunchOptions } from '../dist/main/memory-settings.js';

const modulePaths = [
  'cpw/mods/bootstraplauncher/2.0.2/bootstraplauncher-2.0.2.jar',
  'cpw/mods/securejarhandler/3.0.8/securejarhandler-3.0.8.jar',
  ...['asm-commons', 'asm-util', 'asm-analysis', 'asm-tree', 'asm'].map(name => `org/ow2/asm/${name}/9.10.1/${name}-9.10.1.jar`),
  'net/neoforged/JarJarFileSystems/0.4.1/JarJarFileSystems-0.4.1.jar'
];

test('real xmcl argument generation expands pinned NeoForge library and module paths without running Java', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Argument generation must not request network'));
  const root = join(process.cwd(), 'fictional instance never created');
  const version = {
    id: 'neoforge-21.1.252', minecraftVersion: '1.21.1', assets: '17', type: 'release', libraries: [],
    mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
    arguments: {
      jvm: ['-cp', '${classpath}', '-Djava.net.preferIPv6Addresses=system', '-DignoreList=client-extra,${version_name}.jar',
        '-DlibraryDirectory=${library_directory}', '-p',
        modulePaths.map(path => '${library_directory}/' + path).join('${classpath_separator}'),
        '--add-modules', 'ALL-MODULE-PATH'],
      game: ['--username', '${auth_player_name}', '--accessToken', '${auth_access_token}',
        '--gameDir', '${game_directory}', '--fml.neoForgeVersion', '21.1.252', '--fml.fmlVersion', '4.0.44',
        '--fml.mcVersion', '1.21.1', '--fml.neoFormVersion', '20240808.144430', '--launchTarget', 'forgeclient']
    }
  };
  const args = await generateArguments({
    ...memoryLaunchOptions(8192),
    gamePath: root, resourcePath: root, version, javaPath: 'fictional-java-never-executed', gameIcon: 'unused-icon',
    gameProfile: { name: 'LocalPlayer', id: '00000000000000000000000000000000' },
    accessToken: '0', userType: 'legacy', launcherName: 'KAYVEL',
    spawn: () => assert.fail('Argument generation must not spawn a process')
  });
  assert.equal(args[0], 'fictional-java-never-executed');
  assert.ok(args.includes('-Xms1024M'));
  assert.ok(args.includes('-Xmx8192M'));
  assert.ok(args.includes('-DlibraryDirectory=' + join(root, 'libraries')));
  assert.ok(args.includes('-DignoreList=client-extra,1.21.1.jar'));
  assert.equal(args[args.indexOf('-p') + 1], modulePaths.map(path => join(root, 'libraries') + '/' + path).join(delimiter));
  assert.equal(args[args.indexOf('-cp') + 1], join(root, 'versions', '1.21.1', '1.21.1.jar'));
  assert.equal(args[args.indexOf('--username') + 1], 'LocalPlayer');
  assert.equal(args[args.indexOf('--accessToken') + 1], '0');
  assert.equal(args[args.indexOf('--gameDir') + 1], root);
  assert.equal(args[args.indexOf('--launchTarget') + 1], 'forgeclient');
  assert.ok(args.includes('cpw.mods.bootstraplauncher.BootstrapLauncher'));
  assert.ok(args.every(arg => typeof arg === 'string' && !arg.includes('${')));
});

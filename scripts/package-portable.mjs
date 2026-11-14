import { cp, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { copyPortableRuntime, portableOutputName, reservePortableOutput } from './portable-output.mjs';
import { copyLauncherMain } from './launcher-main-files.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const electron = join(root, 'node_modules', 'electron', 'dist');
const outputName = portableOutputName(process.argv.slice(2));

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Portable build requires Windows x64.');
await stat(join(electron, 'electron.exe'));
await stat(join(root, 'dist', 'main', 'main.js'));
await stat(join(root, 'dist', 'renderer', 'index.html'));

const target = await reservePortableOutput(join(root, 'dist', 'portable'), outputName);
const app = join(target, 'resources', 'app');
await copyPortableRuntime(electron, target);
await mkdir(app, { recursive: true });
await rename(join(target, 'electron.exe'), join(target, 'KAYVEL.exe'));
await copyLauncherMain(join(root, 'dist', 'main'), join(app, 'dist', 'main'));
await cp(join(root, 'dist', 'renderer'), join(app, 'dist', 'renderer'), { recursive: true });
await cp(join(root, 'package-lock.json'), join(app, 'package-lock.json'));
const { name, version, main, type, dependencies, overrides } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await writeFile(join(app, 'package.json'), JSON.stringify({ name, version, main, type, dependencies, overrides }, null, 2));
const npm = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const result = spawnSync(process.execPath, [npm, 'ci', '--offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: app, stdio: 'inherit', windowsHide: true });
if (result.error || result.status !== 0) throw new Error(`Production dependencies could not be installed from the local npm cache: ${result.error?.message ?? result.status}. No network fallback was requested. Output retained at ${target}; inspect it and choose a new output name before another attempt.`);
console.log(`Portable folder: ${target}. Not signed, not an installer; do not distribute without clean-machine testing.`);

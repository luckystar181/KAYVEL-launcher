import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const historicalModules = new Set(['auth.js', 'game-bridge-session.js', 'ticket-bridge.js']);
const removedSkinModules = new Set(['game-skin.js', 'minecraft-skin.js']);

export async function launcherMainFiles(directory) {
  const root = resolve(directory);
  const pending = ['main.js', 'preload.cjs'];
  const files = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (files.has(name)) continue;
    if (historicalModules.has(name)) throw new Error(`Historical account module is not part of the launcher: ${name}`);
    if (removedSkinModules.has(name)) throw new Error(`Removed skin module is not part of the launcher: ${name}`);
    const path = join(root, name);
    if (!(await lstat(path)).isFile()) throw new Error(`Expected a regular launcher file: ${name}`);
    const source = await readFile(path, 'utf8');
    files.add(name);
    for (const reference of ts.preProcessFile(source, true, true).importedFiles) {
      const specifier = reference.fileName;
      if (!specifier.startsWith('.') && !isAbsolute(specifier)) continue;
      const dependency = relative(root, resolve(dirname(path), specifier));
      if (isAbsolute(specifier) || isAbsolute(dependency) || dependency.startsWith('..') || !/\.(?:js|cjs|mjs)$/.test(dependency)) {
        throw new Error(`Unsupported local launcher import in ${name}: ${specifier}`);
      }
      pending.push(dependency);
    }
  }
  return [...files].sort();
}

export async function copyLauncherMain(source, destination) {
  const files = await launcherMainFiles(source);
  for (const name of files) {
    const target = join(destination, name);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(source, name), target, constants.COPYFILE_EXCL);
  }
  return files;
}

import { cp, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export function portableOutputName(args) {
  if (args.length === 0) return 'KAYVEL-win32-x64';
  if (args.length !== 2 || args[0] !== '--output-name') {
    throw new Error('Usage: package-portable.mjs [--output-name NAME]');
  }
  const name = args[1];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name) || name.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error('Output name must be a safe Windows folder name using letters, digits, dots, underscores or hyphens.');
  }
  return name;
}

export async function reservePortableOutput(portableDir, name) {
  const safeName = portableOutputName(['--output-name', name]);
  await mkdir(portableDir, { recursive: true });
  const target = join(portableDir, safeName);
  try { await mkdir(target); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Output already exists: ${target}. Choose another name.`);
    throw error;
  }
  return target;
}

export async function copyPortableRuntime(source, target) {
  for (const name of await readdir(source)) {
    await cp(join(source, name), join(target, name), {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: path => !path.toLowerCase().endsWith('.log')
    });
  }
}

import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileDigest } from '../dist/main/official-download.js';
import { LAUNCHER_RELEASES, validateLauncher } from '../dist/main/launcher-update.js';
import { MANIFEST_PUBLIC_KEY_PEM } from '../dist/main/release.js';

const project = await realpath(fileURLToPath(new URL('../', import.meta.url)));
function inside(parent, child) {
  const path = relative(parent, child);
  return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep);
}
export async function prepareLauncherUpdate({ installer, version, privateKeyPath, output, publicKey = MANIFEST_PUBLIC_KEY_PEM }) {
  const source = resolve(installer);
  const before = await lstat(source);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 2 || before.size > 1_000_000_000) throw new Error('Expected a regular installer EXE.');
  const keyPath = await realpath(resolve(privateKeyPath));
  const target = resolve(output);
  const parent = await realpath(dirname(target));
  if (inside(project, keyPath) || inside(project, parent) || inside(target, keyPath)) throw new Error('Private key and release output must remain outside the repository; never put the key in release output.');
  const keyInfo = await lstat(resolve(privateKeyPath));
  if (!keyInfo.isFile() || keyInfo.isSymbolicLink() || keyInfo.nlink !== 1) throw new Error('Expected a regular private key outside the repository.');
  const key = createPrivateKey(await readFile(keyPath));
  if (key.asymmetricKeyType !== 'ed25519' || !createPublicKey(key).equals(createPublicKey(publicKey))) throw new Error('Signing key does not match the pinned Ed25519 public key.');
  const hash = await fileDigest(source);
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, version, platform: 'win32-x64', size: before.size, sha256: hash,
    url: `${LAUNCHER_RELEASES}/download/v${version}-v3S/KAYVEL-Setup-v3S.exe` }, null, 2) + '\n');
  const signature = sign(null, bytes, key).toString('base64');
  validateLauncher(bytes, signature, publicKey);
  const after = await lstat(source);
  if (after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Installer changed while hashing.');
  await mkdir(target);
  await writeFile(join(target, 'launcher-update.json'), bytes, { flag: 'wx' });
  await writeFile(join(target, 'launcher-update.json.sig'), signature + '\n', { flag: 'wx' });
  return target;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const values = {};
  try {
    for (let index = 0; index < args.length; index += 2) {
      if (!['--installer', '--version', '--private-key', '--output'].includes(args[index]) || !args[index + 1] || values[args[index]]) throw new Error('Expected --installer EXE --version X.Y.Z --private-key EXTERNAL_FILE --output NEW_EXTERNAL_FOLDER');
      values[args[index]] = args[index + 1];
    }
    if (Object.keys(values).length !== 4) throw new Error('All four arguments are required.');
    const target = await prepareLauncherUpdate({ installer: values['--installer'], version: values['--version'], privateKeyPath: values['--private-key'], output: values['--output'] });
    console.log('Signed launcher metadata prepared in ' + target + '. Nothing was uploaded; existing releases were not changed.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, stat, statfs, writeFile } from 'node:fs/promises';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validManagedPath, verifyManifest } from '../dist/main/manifest.js';
import { sameKnownFile } from '../dist/main/file-identity.js';

const projectRoot = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const restrictedNames = new Set(['ragdoll_corpse-1.21.1-0.3.0.jar', 'sable_player_ragdoll-1.21.1-0.7.5.jar', 'sable_player_ragdoll-1.21.1-0.8.1.jar']);
const usage = 'Usage: node scripts/prepare-github-release.mjs --source FOLDER --repo OWNER/REPO --tag TAG --private-key FILE --output NEW_FOLDER --confirm-rights [--confirm-ragdoll-permissions]';

function inside(parent, path) {
  const part = relative(parent, path);
  return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part));
}

function parseArgs(args) {
  const values = {};
  const options = new Set(['source', 'repo', 'tag', 'private-key', 'output']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--confirm-rights' && !values.confirmRights) values.confirmRights = true;
    else if (arg === '--confirm-ragdoll-permissions' && !values.confirmRagdollPermissions) values.confirmRagdollPermissions = true;
    else if (arg.startsWith('--') && options.has(arg.slice(2)) && !values[arg.slice(2)] && args[i + 1] && !args[i + 1].startsWith('--')) values[arg.slice(2)] = args[++i];
    else throw new Error(usage);
  }
  if (![...options].every(option => values[option]) || !values.confirmRights) throw new Error(usage);
  return { source: values.source, repo: values.repo, tag: values.tag, privateKeyPath: values['private-key'], output: values.output, confirmRights: true, confirmRagdollPermissions: values.confirmRagdollPermissions === true };
}

async function plainDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Expected a real directory, not a link: ' + path);
}

async function inputFiles(source, confirmRagdollPermissions) {
  await plainDirectory(source);
  const entries = await readdir(source);
  if (entries.some(name => !['mods', 'resourcepacks', 'kubejs'].includes(name))) {
    throw new Error('Source may contain only mods, resourcepacks and approved kubejs directories. Select approved files in a separate folder.');
  }
  const kubejsDirectories = new Set([
    'kubejs', 'kubejs/client_scripts', 'kubejs/startup_scripts', 'kubejs/config',
    'kubejs/assets', 'kubejs/assets/kubejs', 'kubejs/assets/kubejs/textures',
    'kubejs/assets/kubejs/textures/block', 'kubejs/assets/kubejs/textures/item'
  ]);
  const files = [];
  const paths = new Set();
  let total = 0;
  async function visit(directory) {
    const folder = join(source, directory);
    await plainDirectory(folder);
    for (const name of (await readdir(folder)).sort()) {
      const path = `${directory}/${name}`;
      const sourcePath = join(folder, name);
      const info = await lstat(sourcePath, { bigint: true });
      if (info.isDirectory() && !info.isSymbolicLink() && kubejsDirectories.has(path)) {
        await visit(path);
        continue;
      }
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Expected a regular file, not a link or directory: ' + sourcePath);
      if (!validManagedPath(path)) throw new Error('Unsupported managed path: ' + path);
      if (!sameKnownFile(info, info)) throw new Error('Cannot verify the identity of source file: ' + sourcePath);
      if (restrictedNames.has(name.toLowerCase()) && !confirmRagdollPermissions) throw new Error('This file has a recorded no-redistribution restriction. Include it only with the rights holder’s permission and --confirm-ragdoll-permissions: ' + name);
      if (info.size < 1n || info.size > 1_000_000_000n) throw new Error('File size is outside installer limits: ' + name);
      const size = Number(info.size);
      const key = path.toLowerCase();
      if (paths.has(key)) throw new Error('Duplicate case-insensitive game path: ' + path);
      paths.add(key);
      total += size;
      if (total > 2_000_000_000) throw new Error('Source exceeds the 2 GB installer limit');
      files.push({ path, sourcePath, size, mtimeNs: info.mtimeNs, dev: info.dev, ino: info.ino });
    }
  }
  for (const directory of ['mods', 'resourcepacks', 'kubejs']) {
    if (entries.includes(directory)) await visit(directory);
  }
  if (files.length === 0 || files.length > 998) throw new Error('Select 1 to 998 files; GitHub permits at most 1000 assets per release, including the manifest and signature.');
  return { files, total };
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function prepareGithubRelease({ source, repo, tag, privateKeyPath, output, confirmRights, confirmRagdollPermissions }) {
  if (confirmRights !== true) throw new Error('Confirm rights for every selected file before preparing a release.');
  if (typeof repo !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/.test(repo) || /\/(?:\.|\.\.)$/.test(repo)) throw new Error('Repository must be OWNER/REPO using a valid GitHub owner and repository name.');
  if (typeof tag !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tag) || tag.includes('..') || tag.endsWith('.') || tag.endsWith('.lock')) {
    throw new Error('Tag must be a valid Git tag of 1–64 letters, digits, dots, underscores or hyphens, starting with a letter or digit.');
  }
  const sourcePath = resolve(source);
  const sourceReal = await realpath(sourcePath);
  const keyReal = await realpath(resolve(privateKeyPath));
  if (inside(projectRoot, keyReal)) throw new Error('Keep the private key outside the project repository.');
  if (inside(sourceReal, keyReal)) throw new Error('Keep the private key outside the selected source folder.');
  const keyInfo = await lstat(resolve(privateKeyPath), { bigint: true });
  if (!keyInfo.isFile() || keyInfo.isSymbolicLink()) throw new Error('Private key must be a regular file, not a link.');
  const keyBytes = await readFile(keyReal);
  const keyHash = createHash('sha256').update(keyBytes).digest('hex');
  const privateKey = createPrivateKey(keyBytes);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Expected an Ed25519 private key.');
  const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  const { files, total } = await inputFiles(sourcePath, confirmRagdollPermissions === true);
  for (const file of files) {
    if (await realpath(file.sourcePath) === keyReal || sameKnownFile(file, keyInfo) ||
        (file.size === keyBytes.length && await hashFile(file.sourcePath) === keyHash)) {
      throw new Error('The private key must not be included in source files, including copies or hard links.');
    }
  }
  const manifestUrl = `https://github.com/${repo}/releases/download/${tag}/manifest.json`;
  const baseUrl = manifestUrl.slice(0, -'manifest.json'.length);
  const preview = files.map((file, index) => ({
    path: file.path, size: file.size, sha256: '0'.repeat(64),
    url: `${baseUrl}kayvel-${String(index + 1).padStart(4, '0')}${extname(file.path)}`
  }));
  const previewBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, buildVersion: tag, minecraftVersion: '1.21.1', neoforgeVersion: '21.1.252', files: preview }));
  verifyManifest(previewBytes, sign(null, previewBytes, privateKey).toString('base64'), publicPem);
  const targetPath = resolve(output);
  const parent = await realpath(dirname(targetPath));
  const target = join(parent, basename(targetPath));
  if (inside(sourceReal, target)) throw new Error('Output must be outside the source folder.');
  if (inside(projectRoot, target)) throw new Error('Output must be outside the project repository.');
  const space = await statfs(parent);
  if (space.bavail * space.bsize < total) throw new Error('Insufficient disk space for release assets.');
  try { await mkdir(target); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Output already exists; choose a new folder: ' + target);
    throw error;
  }
  const assets = join(target, 'assets');
  await mkdir(assets);
  const manifestFiles = [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const name = `kayvel-${String(index + 1).padStart(4, '0')}${extname(file.path)}`;
    const destination = join(assets, name);
    await copyFile(file.sourcePath, destination, constants.COPYFILE_EXCL);
    const [sourceAfter, copied] = await Promise.all([lstat(file.sourcePath, { bigint: true }), stat(destination)]);
    if (!sourceAfter.isFile() || sourceAfter.isSymbolicLink() || !sameKnownFile(file, sourceAfter) || sourceAfter.size !== BigInt(file.size) || sourceAfter.mtimeNs !== file.mtimeNs || copied.size !== file.size) {
      throw new Error('Source file changed during preparation: ' + file.path);
    }
    manifestFiles.push({ path: file.path, size: copied.size, sha256: await hashFile(destination), url: baseUrl + name });
  }
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, buildVersion: tag, minecraftVersion: '1.21.1', neoforgeVersion: '21.1.252', files: manifestFiles }, null, 2) + '\n');
  const signature = sign(null, bytes, privateKey).toString('base64');
  verifyManifest(bytes, signature, publicPem);
  await writeFile(join(assets, 'manifest.json'), bytes, { flag: 'wx' });
  await writeFile(join(assets, 'manifest.json.sig'), signature + '\n', { flag: 'wx' });
  const configuration = `// Copy these two lines into src/main/release.ts.\nexport const RELEASE_MANIFEST_URL = ${JSON.stringify(manifestUrl)};\nexport const MANIFEST_PUBLIC_KEY_PEM = ${JSON.stringify(publicPem)};\n`;
  await writeFile(join(target, 'release-config.txt'), configuration, { flag: 'wx' });
  return { output: target, assets, manifestUrl, files: files.length, bytes: total };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await prepareGithubRelease(parseArgs(process.argv.slice(2)));
    console.log(`Prepared ${result.files} files (${result.bytes} bytes) in ${result.assets}. No files were uploaded.`);
    console.log(`Public launcher settings: ${join(result.output, 'release-config.txt')}`);
    console.log('Upload only after checking distribution rights and repository visibility.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Release preparation failed.');
    console.error('Any partially created output has been left unchanged for inspection; choose a new output folder.');
    process.exitCode = 1;
  }
}

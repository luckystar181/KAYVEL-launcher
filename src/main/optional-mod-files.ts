import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, lstat, mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ManagedFile } from './manifest.js';
import { sameKnownFile } from './file-identity.js';

export const SWITCHABLE_MODS = [
  { id: 'iris', path: 'mods/iris-neoforge-1.8.14-beta.1+mc1.21.1.jar' },
  { id: 'distantHorizons', path: 'mods/DistantHorizons-3.3.3-1.21.1-fabric-neoforge.jar' },
  { id: 'ssrd', path: 'mods/SSRD-1.8.8-1.21.1.jar' }
] as const;
export type SwitchableModId = typeof SWITCHABLE_MODS[number]['id'];
export type ModState = 'enabled' | 'disabled';

const markerName = 'optional-mods-managed.json';

export function isSwitchable(file: ManagedFile): boolean {
  return SWITCHABLE_MODS.some(mod => mod.path === file.path);
}

export function optionalModsMarker(manifestBytes: Buffer): string {
  return JSON.stringify({ version: 1, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex') });
}

async function entry(path: string) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function safeDirectory(path: string, required: boolean): Promise<boolean> {
  const info = await entry(path);
  if (!info) {
    if (required) throw new Error('Каталог модпака отсутствует: ' + path);
    return false;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Небезопасный каталог модпака: ' + path);
  return true;
}

export async function hasOptionalModsMarker(root: string, bytes: Buffer): Promise<boolean> {
  const path = join(root, '.kayvel', markerName);
  const info = await entry(path);
  if (!info) return false;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024n) throw new Error('Метка управления модами повреждена или является ссылкой.');
  const contents = await readFile(path, 'utf8');
  if (contents !== optionalModsMarker(bytes)) throw new Error('Метка управления модами не соответствует подписанному модпаку.');
  return true;
}

export function optionalModsMarkerPath(root: string): string {
  return join(root, '.kayvel', markerName);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyFile(path: string, file: ManagedFile): Promise<void> {
  const before = await entry(path);
  if (!before || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(file.size)) {
    throw new Error('Файл мода отсутствует, изменён или имеет дополнительные ссылки: ' + file.path);
  }
  const hash = await hashFile(path);
  const after = await entry(path);
  if (!after || !after.isFile() || after.isSymbolicLink() || !sameKnownFile(before, after) || after.nlink !== 1n || after.size !== BigInt(file.size) || hash !== file.sha256) {
    throw new Error('SHA-256 мода не совпадает или файл был изменён: ' + file.path);
  }
}

function paths(root: string, file: ManagedFile) {
  const name = file.path.slice('mods/'.length);
  return { enabled: join(root, 'mods', name), disabled: join(root, '.kayvel', 'disabled-mods', name) };
}

export async function assertOptionalDestinationsFree(root: string, files: ManagedFile[]): Promise<void> {
  const selected = files.filter(isSwitchable);
  if (!selected.length) return;
  if (await entry(optionalModsMarkerPath(root))) throw new Error('Метка управления модами уже существует; проверьте происхождение файлов.');
  const hasDisabledDir = await safeDirectory(join(root, '.kayvel', 'disabled-mods'), false);
  if (hasDisabledDir) {
    for (const file of selected) {
      if (await entry(paths(root, file).disabled)) throw new Error('Путь отключённого мода уже занят: ' + file.path);
    }
  }
}

export async function inspectOptionalMod(root: string, file: ManagedFile): Promise<ModState> {
  if (!isSwitchable(file)) throw new Error('Этот мод нельзя переключать.');
  await safeDirectory(root, true);
  await safeDirectory(join(root, '.kayvel'), true);
  await safeDirectory(join(root, 'mods'), true);
  const hasDisabledDir = await safeDirectory(join(root, '.kayvel', 'disabled-mods'), false);
  const location = paths(root, file);
  const enabled = await entry(location.enabled);
  const disabled = hasDisabledDir ? await entry(location.disabled) : null;
  if (enabled && disabled) throw new Error('Найдены обе копии мода. Проверьте состояние вручную: ' + file.path);
  if (!enabled && !disabled) throw new Error('Файл мода отсутствует; автоматическое восстановление отключено: ' + file.path);
  const state = enabled ? 'enabled' : 'disabled';
  await verifyFile(location[state], file);
  return state;
}

export async function moveOptionalMod(root: string, file: ManagedFile, target: ModState, assertProvenance: () => Promise<void>): Promise<ModState> {
  const current = await inspectOptionalMod(root, file);
  if (current === target) return current;
  const location = paths(root, file);
  if (target === 'disabled') {
    const disabledDir = join(root, '.kayvel', 'disabled-mods');
    try { await mkdir(disabledDir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await safeDirectory(disabledDir, true);
  }
  const source = location[current];
  const destination = location[target];
  const before = await lstat(source, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || !sameKnownFile(before, before) || before.nlink !== 1n || before.size !== BigInt(file.size)) throw new Error('Файл мода изменился перед переключением.');
  await assertProvenance();
  await link(source, destination);
  const sourceAfter = await lstat(source, { bigint: true });
  const destAfter = await lstat(destination, { bigint: true });
  if (!sourceAfter.isFile() || !destAfter.isFile() || sourceAfter.isSymbolicLink() || destAfter.isSymbolicLink() ||
      !sameKnownFile(before, sourceAfter) || !sameKnownFile(before, destAfter) || sourceAfter.nlink !== 2n || destAfter.nlink !== 2n ||
      sourceAfter.size !== BigInt(file.size) || destAfter.size !== BigInt(file.size) || await hashFile(destination) !== file.sha256) {
    throw new Error('Переключение прервано. Обе копии сохранены для проверки вручную: ' + file.path);
  }
  const finalSource = await lstat(source, { bigint: true });
  const finalDestination = await lstat(destination, { bigint: true });
  if (!sameKnownFile(before, finalSource) || !sameKnownFile(before, finalDestination) || finalSource.nlink !== 2n || finalDestination.nlink !== 2n) {
    throw new Error('Файлы изменились при переключении. Проверьте их вручную: ' + file.path);
  }
  try { await assertProvenance(); }
  catch (error) {
    throw new Error('Происхождение изменилось при переключении. Обе копии сохранены для проверки вручную: ' + file.path, { cause: error });
  }
  const sourceBeforeUnlink = await lstat(source, { bigint: true });
  const destinationBeforeUnlink = await lstat(destination, { bigint: true });
  if (!sameKnownFile(before, sourceBeforeUnlink) || !sameKnownFile(before, destinationBeforeUnlink) || sourceBeforeUnlink.nlink !== 2n || destinationBeforeUnlink.nlink !== 2n) {
    throw new Error('Файлы изменились при переключении. Проверьте их вручную: ' + file.path);
  }
  await unlink(source);
  return await inspectOptionalMod(root, file);
}

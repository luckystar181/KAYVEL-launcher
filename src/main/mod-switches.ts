import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireGameDirectoryLock, getInstalledManifest, verifyInstalledRelease } from './installer.js';
import { hasOptionalModsMarker, inspectOptionalMod, moveOptionalMod, SWITCHABLE_MODS, SwitchableModId } from './optional-mod-files.js';

type DisplayState = 'enabled' | 'disabled' | 'unavailable' | 'conflict';
export type ModSwitchStatus = { id: SwitchableModId; state: DisplayState; message?: string };

async function entry(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function safeExistingDirectory(path: string): Promise<boolean> {
  const info = await entry(path);
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Небезопасный каталог модпака: ' + path);
  return true;
}

async function preparationIncomplete(root: string): Promise<boolean> {
  return await safeExistingDirectory(join(root, '.preparation'))
    && Boolean(await entry(join(root, '.preparation', 'incomplete.json')));
}

const unavailable = (message: string): ModSwitchStatus[] => SWITCHABLE_MODS.map(mod => ({ id: mod.id, state: 'unavailable', message }));

export async function readModSwitches(root: string, publicKeyPem: string): Promise<ModSwitchStatus[]> {
  if (!await safeExistingDirectory(root) || !await safeExistingDirectory(join(root, '.kayvel'))) {
    return unavailable('Нужна новая установка подписанного модпака с поддержкой переключателей.');
  }
  if (await preparationIncomplete(root) || await entry(join(root, '.kayvel', 'update-incomplete.json')) || await entry(join(root, '.kayvel', 'install-incomplete.json'))) {
    return unavailable('Установка не завершена; сначала проверьте состояние файлов вручную.');
  }
  const installed = await getInstalledManifest(join(root, '.kayvel'), publicKeyPem);
  if (!installed || !await hasOptionalModsMarker(root, installed.bytes)) {
    return unavailable('Нужна новая установка подписанного модпака с подтверждённым происхождением файлов.');
  }
  return await Promise.all(SWITCHABLE_MODS.map(async mod => {
    const file = installed.manifest.files.find(item => item.path === mod.path);
    if (!file) return { id: mod.id, state: 'unavailable' as const, message: 'Этого файла нет в подписанном манифесте.' };
    try { return { id: mod.id, state: await inspectOptionalMod(root, file) }; }
    catch (error) { return { id: mod.id, state: 'conflict' as const, message: error instanceof Error ? error.message : 'Не удалось проверить файл мода.' }; }
  }));
}

export async function assertModSwitchProvenance(root: string, publicKeyPem: string, expectedBytes: Buffer): Promise<void> {
  if (!await safeExistingDirectory(root) || !await safeExistingDirectory(join(root, '.kayvel')) || await preparationIncomplete(root) ||
      await entry(join(root, '.kayvel', 'update-incomplete.json')) || await entry(join(root, '.kayvel', 'install-incomplete.json'))) {
    throw new Error('Переключение недоступно: состояние установки изменилось.');
  }
  const installed = await getInstalledManifest(join(root, '.kayvel'), publicKeyPem);
  if (!installed || !installed.bytes.equals(expectedBytes) || !await hasOptionalModsMarker(root, expectedBytes)) {
    throw new Error('Переключение недоступно: происхождение файлов не подтверждено или изменилось.');
  }
}

export async function setModEnabled(root: string, publicKeyPem: string, id: unknown, enabled: unknown): Promise<void> {
  if (typeof id !== 'string' || typeof enabled !== 'boolean') throw new Error('Некорректный переключатель.');
  const definition = SWITCHABLE_MODS.find(mod => mod.id === id);
  if (!definition) throw new Error('Этот мод нельзя переключать.');
  if (!await safeExistingDirectory(root) || !await safeExistingDirectory(join(root, '.kayvel'))) {
    throw new Error('Подписанный модпак с поддержкой переключателей ещё не установлен.');
  }
  const releaseLock = await acquireGameDirectoryLock(root);
  try {
    if (await preparationIncomplete(root)) throw new Error('Подготовка не завершена; переключение модов недоступно до проверки файлов.');
    const installed = await getInstalledManifest(join(root, '.kayvel'), publicKeyPem);
    if (!installed || !await hasOptionalModsMarker(root, installed.bytes)) {
      throw new Error('Переключение недоступно: происхождение файлов старой установки не подтверждено.');
    }
    const file = installed.manifest.files.find(item => item.path === definition.path);
    if (!file) throw new Error('Этого файла нет в подписанном манифесте.');
    await verifyInstalledRelease(root, publicKeyPem);
    await moveOptionalMod(root, file, enabled ? 'enabled' : 'disabled', () => assertModSwitchProvenance(root, publicKeyPem, installed.bytes));
  } finally { await releaseLock(); }
}

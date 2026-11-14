import { app, BrowserWindow, dialog, ipcMain, nativeImage, session, screen } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireGameDirectoryLock, installRelease, verifyInstalledRelease } from './installer.js';
import { readModSwitches, setModEnabled } from './mod-switches.js';
import { createGameExitReporter, watchLockedGame } from './game-process.js';
import { MANIFEST_PUBLIC_KEY_PEM, RELEASE_MANIFEST_URL } from './release.js';
import { availableJava21 } from './java-runtime.js';
import { launchVanilla, validateNickname, VANILLA_VERSION } from './vanilla.js';
import { launchNeoForge, neoForgeReady, NEOFORGE_VERSION } from './neoforge.js';
import { confirmNetworkIsolation, requireAvailableJava21 } from './game-launch-policy.js';
import { gamePreparationUnavailable } from './game-preparation.js';
import { lookupMinecraftSkin } from './minecraft-skin.js';
import { createLocalProfileStore } from './local-profile.js';
import { createGameBestStore } from './game-best.js';
import { createNewsStore } from './news.js';

let window: BrowserWindow | null = null;
let installing = false;
let preparingVanilla = false;
let preparingNeoForge = false;
let gameRunning = false;
let modSwitching = false;
let activeGamePath: string | null = null;
const here = fileURLToPath(new URL('.', import.meta.url));
const localProfile = createLocalProfileStore(app.getPath('userData'), bytes => {
  const image = nativeImage.createFromBuffer(Buffer.from(bytes));
  const size = image.getSize();
  return !image.isEmpty() && size.width === 64 && (size.height === 32 || size.height === 64);
});
const localProfileReleaseReady = false;
const gameBest = createGameBestStore(app.getPath('userData'));
const news = createNewsStore(app.getPath('userData'));
const trusted = (event: Electron.IpcMainInvokeEvent) => Boolean(window && event.sender === window.webContents);
const vanillaPath = () => join(app.getPath('userData'), 'vanilla');
const vanillaReady = () => existsSync(join(vanillaPath(), '.kayvel-vanilla-ready')) && existsSync(join(vanillaPath(), 'versions', VANILLA_VERSION, `${VANILLA_VERSION}.jar`));
const neoforgePath = () => join(app.getPath('userData'), 'game');

async function confirmLaunchIsolation(language: unknown): Promise<boolean> {
  if (!window || window.isDestroyed()) return false;
  const owner = window;
  return await confirmNetworkIsolation(options => dialog.showMessageBox(owner, options), language);
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.url.startsWith('file:')) callback({ responseHeaders: {
      ...details.responseHeaders,
      'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"],
    } });
    else callback({ responseHeaders: details.responseHeaders });
  });
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1440, area.width);
  const height = Math.min(820, area.height);
  window = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(1100, area.width),
    minHeight: Math.min(720, area.height),
    x: area.x + Math.floor((area.width - width) / 2),
    y: area.y + Math.floor((area.height - height) / 2),
    frame: false,
    backgroundColor: '#0c0a0c',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });
  window.on('closed', () => { window = null; });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  await window.loadFile(join(here, '../renderer/index.html'));
});

ipcMain.handle('kayvel:status', (event) => {
  if (!trusted(event)) throw new Error('Untrusted renderer');
  return {
  releaseConfigured: Boolean(localProfileReleaseReady && RELEASE_MANIFEST_URL && MANIFEST_PUBLIC_KEY_PEM),
  gamePath: join(app.getPath('userData'), 'game'),
  vanillaPath: vanillaPath(),
  vanillaReady: vanillaReady(),
  preparingVanilla,
  neoforgePath: neoforgePath(),
  neoforgeReady: neoForgeReady(neoforgePath()),
  preparingNeoForge,
  neoforgeVersion: NEOFORGE_VERSION,
  activeGamePath,
  gameRunning,
  javaFound: Boolean(availableJava21(app.getPath('userData'))),
  installing,
  modSwitching
};
});

ipcMain.handle('kayvel:game-best', (event) => {
  if (!trusted(event)) throw new Error('Untrusted renderer');
  return gameBest.read();
});
ipcMain.handle('kayvel:game-best-save', (event, score: unknown) => {
  if (!trusted(event)) throw new Error('Untrusted renderer');
  return gameBest.save(score);
});

ipcMain.handle('kayvel:news', (event) => {
  if (!trusted(event)) throw new Error('Untrusted renderer');
  return news.read();
});

ipcMain.handle('kayvel:local-profile', (event) => {
  if (!trusted(event)) throw new Error('Untrusted renderer');
  return localProfile.read();
});
ipcMain.handle('kayvel:local-nickname-save', (event, nickname: unknown) => {
  if (!trusted(event)) throw new Error('Untrusted renderer');
  return localProfile.saveNickname(nickname);
});
ipcMain.handle('kayvel:local-skin-save', (event, bytes: unknown, model: unknown) => {
  if (!trusted(event)) throw new Error('Untrusted renderer');
  return localProfile.saveSkin(bytes, model);
});

ipcMain.handle('kayvel:skin-by-nickname', (event, nickname: unknown) => trusted(event) ? lookupMinecraftSkin(nickname) : { ok: false, message: 'Недоступно.' });

ipcMain.handle('kayvel:mod-switches', async (event) => {
  if (!trusted(event)) throw new Error('Untrusted renderer');
  return await readModSwitches(neoforgePath(), MANIFEST_PUBLIC_KEY_PEM);
});
ipcMain.handle('kayvel:mod-switch-set', async (event, id: unknown, enabled: unknown) => {
  if (!trusted(event)) return { ok: false, message: 'Недоступно.' };
  if (modSwitching || installing || preparingVanilla || preparingNeoForge || gameRunning) return { ok: false, message: 'Игра или другая операция уже выполняется.' };
  modSwitching = true;
  try {
    await setModEnabled(neoforgePath(), MANIFEST_PUBLIC_KEY_PEM, id, enabled);
    return { ok: true, message: enabled ? 'Мод включён.' : 'Мод отключён; файл сохранён.' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Не удалось переключить мод.' };
  } finally { modSwitching = false; }
});

ipcMain.handle('kayvel:install', async (event) => {
  if (!trusted(event)) return { ok: false, message: 'Недоступно.' };
  if (!localProfileReleaseReady || !RELEASE_MANIFEST_URL || !MANIFEST_PUBLIC_KEY_PEM) return { ok: false, message: 'Нужен новый подписанный релиз без KAYVEL Core; старый тестовый модпак не устанавливается.' };
  if (modSwitching || installing || preparingNeoForge || gameRunning) return { ok: false, message: 'Установка или игра уже выполняется.' };
  installing = true;
  try {
    const version = await installRelease(join(app.getPath('userData'), 'game'), RELEASE_MANIFEST_URL, MANIFEST_PUBLIC_KEY_PEM);
    return { ok: true, message: `Файлы модпака версии ${version} проверены. NeoForge устанавливается отдельно; ресурс-паки включаются в игре.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Ошибка установки файлов.' };
  } finally {
    installing = false;
  }
});

ipcMain.handle('kayvel:install-vanilla', (event) => trusted(event) ? gamePreparationUnavailable() : { ok: false, message: 'Недоступно.' });
ipcMain.handle('kayvel:install-neoforge', (event) => trusted(event) ? gamePreparationUnavailable() : { ok: false, message: 'Недоступно.' });

ipcMain.handle('kayvel:play-neoforge', async (event, language: unknown) => {
  if (!trusted(event)) return { ok: false, message: 'Недоступно.' };
  if (modSwitching || preparingNeoForge || preparingVanilla || installing || gameRunning) return { ok: false, message: 'Подготовка или игра уже выполняется.' };
  if (!neoForgeReady(neoforgePath())) return { ok: false, message: 'NeoForge не готов к запуску. Его подготовка временно отключена.' };
  let releaseGameLock: (() => Promise<void>) | undefined;
  let gameObserved = false;
  preparingNeoForge = true;
  try {
    const name = validateNickname(localProfile.read().nickname);
    if (!await confirmLaunchIsolation(language)) {
      preparingNeoForge = false;
      return { ok: false, message: 'Запуск отменён: сетевая изоляция не подтверждена.' };
    }
    const gamePath = neoforgePath();
    releaseGameLock = await acquireGameDirectoryLock(gamePath);
    await verifyInstalledRelease(gamePath, MANIFEST_PUBLIC_KEY_PEM);
    const java = requireAvailableJava21(app.getPath('userData'));
    gameRunning = true;
    preparingNeoForge = false;
    activeGamePath = gamePath;
    await launchNeoForge(gamePath, name, java, child => {
      const release = releaseGameLock!;
      gameObserved = true;
      const reportExit = createGameExitReporter(gamePath, exit => {
        gameRunning = false;
        activeGamePath = null;
        if (window && !window.isDestroyed()) window.webContents.send('kayvel:game-exit', exit);
      });
      watchLockedGame(child, release, reportExit, error => console.error('Ошибка процесса игры или блокировки:', error));
      releaseGameLock = undefined;
    });
    if (!gameObserved) {
      gameObserved = true;
      throw new Error('Не удалось подтвердить наблюдение за процессом игры; блокировка сохранена до проверки.');
    }
    return { ok: true, message: `NeoForge запущен с локальным ником ${name}. Старый Core не удалён; для него билет больше не выдаётся.` };
  } catch (error) {
    if (!gameObserved) {
      if (releaseGameLock) await releaseGameLock().catch(lockError => console.error('Не удалось снять блокировку игры:', lockError));
      preparingNeoForge = false;
      gameRunning = false;
      activeGamePath = null;
    }
    return { ok: false, message: error instanceof Error ? error.message : 'Не удалось запустить NeoForge.' };
  }
});

ipcMain.handle('kayvel:play-vanilla', async (event, language: unknown) => {
  if (!trusted(event)) return { ok: false, message: 'Недоступно.' };
  if (modSwitching || preparingVanilla || preparingNeoForge || installing || gameRunning) return { ok: false, message: 'Подготовка или игра уже выполняется.' };
  if (!vanillaReady()) return { ok: false, message: 'Minecraft не готов к запуску. Его подготовка временно отключена.' };
  preparingVanilla = true;
  try {
    const name = validateNickname(localProfile.read().nickname);
    if (!await confirmLaunchIsolation(language)) {
      preparingVanilla = false;
      return { ok: false, message: 'Запуск отменён: сетевая изоляция не подтверждена.' };
    }
    const gamePath = vanillaPath();
    const java = requireAvailableJava21(app.getPath('userData'));
    preparingVanilla = false;
    gameRunning = true;
    activeGamePath = gamePath;
    const child = await launchVanilla(gamePath, name, java);
    const reportExit = createGameExitReporter(gamePath, exit => {
      gameRunning = false;
      activeGamePath = null;
      if (window && !window.isDestroyed()) window.webContents.send('kayvel:game-exit', exit);
    });
    child.once('exit', code => reportExit(code));
    child.once('error', () => reportExit(-1));
    if (child.exitCode !== null || child.signalCode !== null) reportExit(child.exitCode);
    return { ok: true, message: `Minecraft запущен с локальным ником ${name}. Допуск на сервер проверяется на сервере.` };
  } catch (error) {
    preparingVanilla = false;
    gameRunning = false;
    activeGamePath = null;
    return { ok: false, message: error instanceof Error ? error.message : 'Не удалось запустить Minecraft.' };
  }
});

ipcMain.on('kayvel:window', (event, action: unknown) => {
  if (!window || event.sender !== window.webContents) return;
  if (action === 'minimize') window.minimize();
  if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
  if (action === 'close') window.close();
});

app.on('window-all-closed', () => app.quit());

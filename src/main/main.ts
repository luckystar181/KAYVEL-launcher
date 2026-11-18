import { app, BrowserWindow, ipcMain, nativeImage, session, screen, shell } from 'electron';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireGameDirectoryLock } from './installer.js';
import { readModSwitches, setModEnabled } from './mod-switches.js';
import { createGameExitReporter, watchLockedGame } from './game-process.js';
import { MANIFEST_PUBLIC_KEY_PEM, RELEASE_MANIFEST_URL } from './release.js';
import { launchVanilla, validateNickname, VANILLA_VERSION } from './vanilla.js';
import { launchNeoForge, neoForgeReady, NEOFORGE_VERSION } from './neoforge.js';
import { requireAvailableJava21 } from './game-launch-policy.js';
import { createMemorySettingsStore } from './memory-settings.js';
import { gamePreparationUnavailable } from './game-preparation.js';
import { createLocalProfileStore } from './local-profile.js';
import { applyLocalSkin } from './game-skin.js';
import { createGameBestStore } from './game-best.js';
import { instancePath, prepareInstance, preparedJava, verifyPreparation } from './prepare-instance.js';
import { stageProgress, type PreparationProgress } from './preparation-progress.js';

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
const memorySettings = createMemorySettingsStore(app.getPath('userData'));
const localProfileReleaseReady = true;
const gameBest = createGameBestStore(app.getPath('userData'));
const trusted = (event: Electron.IpcMainInvokeEvent) => Boolean(window && event.sender === window.webContents);
const vanillaPath = () => join(app.getPath('userData'), 'vanilla');
const vanillaReady = () => existsSync(join(vanillaPath(), '.kayvel-vanilla-ready')) && existsSync(join(vanillaPath(), 'versions', VANILLA_VERSION, `${VANILLA_VERSION}.jar`));
const neoforgePath = () => instancePath(app.getPath('userData'));
const preparedInstanceReady = () => neoForgeReady(neoforgePath())
  && existsSync(join(neoforgePath(), '.preparation', 'ready.json'))
  && !existsSync(join(neoforgePath(), '.preparation', 'incomplete.json'));
let preparationProgress: PreparationProgress | null = null;
let lastProgressSent = 0;
function reportPreparation(progress: PreparationProgress): void {
  const previous = preparationProgress;
  preparationProgress = progress;
  const completed = progress.total !== null && progress.received === progress.total || progress.totalFiles !== null && progress.completedFiles === progress.totalFiles;
  if (previous?.stage === progress.stage && !completed && Date.now() - lastProgressSent < 100) return;
  lastProgressSent = Date.now();
  if (window && !window.isDestroyed()) window.webContents.send('kayvel:preparation-progress', progress);
}

function clearPreparation(): void {
  preparationProgress = null;
  lastProgressSent = 0;
  if (window && !window.isDestroyed()) window.webContents.send('kayvel:preparation-progress', null);
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
  gamePath: neoforgePath(),
  vanillaPath: vanillaPath(),
  vanillaReady: vanillaReady(),
  preparingVanilla,
  neoforgePath: neoforgePath(),
  neoforgeReady: preparedInstanceReady(),
  preparingNeoForge,
  neoforgeVersion: NEOFORGE_VERSION,
  activeGamePath,
  gameRunning,
  installing,
  modSwitching,
  preparationProgress
};
});

ipcMain.handle('kayvel:open-game-folder', async (event, language: unknown) => {
  if (!trusted(event)) throw new Error('Untrusted renderer');
  const missing = language === 'en' ? 'The game folder has not been created yet. Download the modpack first.' : 'Папка игры ещё не создана. Сначала скачайте сборку.';
  const failed = language === 'en' ? 'Could not open the game folder in Explorer.' : 'Не удалось открыть папку игры в Проводнике.';
  const path = neoforgePath();
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return { ok: false, message: failed };
    const error = await shell.openPath(path);
    return { ok: !error, message: error ? failed : '' };
  } catch (error) {
    return { ok: false, message: (error as NodeJS.ErrnoException).code === 'ENOENT' ? missing : failed };
  }
});

ipcMain.handle('kayvel:memory-settings', (event) => {
  if (!trusted(event)) throw new Error('Untrusted renderer');
  return memorySettings.read();
});
ipcMain.handle('kayvel:memory-save', (event, memoryMb: unknown) => {
  if (!trusted(event)) throw new Error('Untrusted renderer');
  if (modSwitching || installing || preparingVanilla || preparingNeoForge || gameRunning) throw new Error('Измените объём ОЗУ после завершения подготовки или игры.');
  return memorySettings.save(memoryMb);
});

ipcMain.handle('kayvel:game-best', (event) => {
  if (!trusted(event)) throw new Error('Untrusted renderer');
  return gameBest.read();
});
ipcMain.handle('kayvel:game-best-save', (event, score: unknown) => {
  if (!trusted(event)) throw new Error('Untrusted renderer');
  return gameBest.save(score);
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

ipcMain.handle('kayvel:install', (event) => trusted(event) ? gamePreparationUnavailable() : { ok: false, message: 'Недоступно.' });

ipcMain.handle('kayvel:install-vanilla', (event) => trusted(event) ? gamePreparationUnavailable() : { ok: false, message: 'Недоступно.' });
ipcMain.handle('kayvel:install-neoforge', (event) => trusted(event) ? gamePreparationUnavailable() : { ok: false, message: 'Недоступно.' });

ipcMain.handle('kayvel:play-neoforge', (event, language: unknown) => trusted(event) ? playPreparedNeoForge(language) : { ok: false, message: 'Недоступно.' });

ipcMain.handle('kayvel:download-and-play', async (event, language: unknown) => {
  if (!trusted(event)) return { ok: false, message: 'Недоступно.' };
  if (!localProfileReleaseReady || !RELEASE_MANIFEST_URL || !MANIFEST_PUBLIC_KEY_PEM) return { ok: false, message: 'Новый подписанный выпуск сборки ещё не настроен.' };
  if (modSwitching || preparingNeoForge || preparingVanilla || installing || gameRunning) return { ok: false, message: 'Подготовка или игра уже выполняется.' };
  preparingNeoForge = true;
  try {
    validateNickname(localProfile.read().nickname);
    memorySettings.read();
    await prepareInstance(app.getPath('userData'), RELEASE_MANIFEST_URL, MANIFEST_PUBLIC_KEY_PEM, reportPreparation);
    preparingNeoForge = false;
    return await playPreparedNeoForge(language);
  } catch (error) {
    stageProgress(reportPreparation, 'error', 'Операция остановлена; файлы сохранены для проверки.');
    return { ok: false, message: error instanceof Error ? error.message : 'Не удалось подготовить игру.' };
  } finally { preparingNeoForge = false; }
});

async function playPreparedNeoForge(language: unknown) {
  if (modSwitching || preparingNeoForge || preparingVanilla || installing || gameRunning) return { ok: false, message: 'Подготовка или игра уже выполняется.' };
  if (!localProfileReleaseReady || !RELEASE_MANIFEST_URL || !MANIFEST_PUBLIC_KEY_PEM) return { ok: false, message: 'Новый подписанный выпуск сборки ещё не настроен.' };
  if (!preparedInstanceReady()) return { ok: false, message: 'Экземпляр не подготовлен. Используйте «Скачать и играть».' };
  let releaseGameLock: (() => Promise<void>) | undefined;
  let gameObserved = false;
  preparingNeoForge = true;
  try {
    const profile = localProfile.read();
    const name = validateNickname(profile.nickname);
    const memoryMb = memorySettings.read().memoryMb;
    const gamePath = neoforgePath();
    releaseGameLock = await acquireGameDirectoryLock(gamePath);
    await verifyPreparation(gamePath, MANIFEST_PUBLIC_KEY_PEM, reportPreparation);
    applyLocalSkin(gamePath, profile);
    const java = preparedJava(gamePath, app.getPath('userData'));
    stageProgress(reportPreparation, 'launch', 'Запуск Minecraft');
    gameRunning = true;
    preparingNeoForge = false;
    activeGamePath = gamePath;
    await launchNeoForge(gamePath, name, java, child => {
      const release = releaseGameLock!;
      gameObserved = true;
      clearPreparation();
      const reportExit = createGameExitReporter(gamePath, exit => {
        gameRunning = false;
        activeGamePath = null;
        clearPreparation();
        if (window && !window.isDestroyed()) window.webContents.send('kayvel:game-exit', exit);
      });
      watchLockedGame(child, release, reportExit, error => console.error('Ошибка процесса игры или блокировки:', error));
      releaseGameLock = undefined;
    }, memoryMb);
    if (!gameObserved) {
      gameObserved = true;
      throw new Error('Не удалось подтвердить наблюдение за процессом игры; блокировка сохранена до проверки.');
    }
    return { ok: true, message: '' };
  } catch (error) {
    stageProgress(reportPreparation, 'error', 'Запуск остановлен. Файлы сохранены для проверки.');
    if (!gameObserved) {
      if (releaseGameLock) await releaseGameLock().catch(lockError => console.error('Не удалось снять блокировку игры:', lockError));
      preparingNeoForge = false;
      gameRunning = false;
      activeGamePath = null;
    }
    return { ok: false, message: error instanceof Error ? error.message : 'Не удалось запустить NeoForge.' };
  }
}

ipcMain.handle('kayvel:play-vanilla', async (event, language: unknown) => {
  if (!trusted(event)) return { ok: false, message: 'Недоступно.' };
  if (modSwitching || preparingVanilla || preparingNeoForge || installing || gameRunning) return { ok: false, message: 'Подготовка или игра уже выполняется.' };
  if (!vanillaReady()) return { ok: false, message: 'Minecraft не готов к запуску. Его подготовка временно отключена.' };
  preparingVanilla = true;
  try {
    const name = validateNickname(localProfile.read().nickname);
    const memoryMb = memorySettings.read().memoryMb;
    const gamePath = vanillaPath();
    const java = requireAvailableJava21(app.getPath('userData'));
    preparingVanilla = false;
    gameRunning = true;
    activeGamePath = gamePath;
    const child = await launchVanilla(gamePath, name, java, memoryMb);
    const reportExit = createGameExitReporter(gamePath, exit => {
      gameRunning = false;
      activeGamePath = null;
      clearPreparation();
      if (window && !window.isDestroyed()) window.webContents.send('kayvel:game-exit', exit);
    });
    child.once('exit', code => reportExit(code));
    child.once('error', () => reportExit(-1));
    if (child.exitCode !== null || child.signalCode !== null) reportExit(child.exitCode);
    return { ok: true, message: '' };
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

import { cancellationMessage, cancelDownload, checkDownloadCancelled, configureDownloadRequest, withDownloadSignal } from './download-session.js';
import { createChromiumDownloadRequest } from './chromium-download.js';
import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, session, screen, shell } from 'electron';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireGameDirectoryLock, getInstalledManifest } from './installer.js';
import { compareModpackVersions, discoverModpack, modpackReleaseUrl, type ModpackUpdateStatus, type SignedModpack } from './modpack-channel.js';
import { updateModpack } from './modpack-update.js';
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
import { applyGameDefaults } from './game-defaults.js';
import { createGameBestStore } from './game-best.js';
import { instancePath, prepareInstance, preparedJava, verifyPreparation } from './prepare-instance.js';
import { prepareFFmpeg } from './prepare-ffmpeg.js';
import { compareLauncherVersions, discoverLauncher, stageLauncherUpdate, type SignedLauncher } from './launcher-update.js';
import { openUpdateInstaller } from './installer-handoff.js';
import { assertRecoveryProcessesStopped } from './lock-processes.js';
import type { LauncherUpdateStatus } from './launcher-update-status.js';
import { stageProgress, type PreparationProgress } from './preparation-progress.js';

let window: BrowserWindow | null = null;
let installing = false;
let preparingVanilla = false;
let preparingNeoForge = false;
let downloadController: AbortController | null = null;
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
const updateIncomplete = () => {
  try { lstatSync(join(neoforgePath(), '.kayvel', 'update-incomplete.json')); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
};
const preparedInstanceReady = () => neoForgeReady(neoforgePath())
  && !updateIncomplete()
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
  const downloads = session.fromPartition('kayvel-downloads', { cache: false });
  downloads.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  configureDownloadRequest(createChromiumDownloadRequest(downloads, options => net.request(options)));
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
  window.on('close', event => {
    if (!downloadController && !installing) return;
    event.preventDefault();
    if (downloadController) cancelDownload(downloadController);
    stageProgress(reportPreparation, 'verify', launcherUpdate.state === 'installer-open'
      ? 'Завершите или закройте установщик. После успешной установки лаунчер переключится автоматически.'
      : 'Дождитесь завершения записи файлов и остановки подготовки, затем закройте окно.');
  });
  window.on('closed', () => { window = null; });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  await window.loadFile(join(here, '../renderer/index.html'));
});

let modpackCandidate: SignedModpack | null = null;
let modpackUpdate: ModpackUpdateStatus = { state: 'unchecked', installedVersion: null, latestVersion: null, message: '' };
const operationBusy = () => modSwitching || installing || preparingVanilla || preparingNeoForge || gameRunning;

async function checkModpackUpdate(): Promise<ModpackUpdateStatus> {
  if (operationBusy() || modpackUpdate.state === 'checking') return { ...modpackUpdate };
  modpackCandidate = null;
  modpackUpdate = { ...modpackUpdate, state: 'checking', message: '' };
  try {
    if (!localProfileReleaseReady || !RELEASE_MANIFEST_URL || !MANIFEST_PUBLIC_KEY_PEM) throw new Error('Канал обновлений не настроен.');
    if (updateIncomplete()) throw new Error('Предыдущее обновление не завершено. Сохраните резервную копию в .kayvel/updates для восстановления.');
    const candidate = await discoverModpack(RELEASE_MANIFEST_URL, MANIFEST_PUBLIC_KEY_PEM);
    const installed = await getInstalledManifest(join(neoforgePath(), '.kayvel'), MANIFEST_PUBLIC_KEY_PEM);
    if (operationBusy()) throw new Error('Другая операция выполняется. Повторите проверку после её завершения.');
    let state: ModpackUpdateStatus['state'] = 'not-installed';
    if (installed) {
      const order = compareModpackVersions(candidate.manifest.buildVersion, installed.manifest.buildVersion);
      if (order < 0) throw new Error('Сервер предлагает старую сборку. Установленная версия сохранена; откат запрещён.');
      if (order === 0 && !candidate.bytes.equals(installed.bytes)) throw new Error('Содержимое опубликованной версии изменено. Обновление заблокировано.');
      state = order > 0 ? 'available' : 'current';
    }
    modpackCandidate = candidate;
    modpackUpdate = { state, installedVersion: installed?.manifest.buildVersion ?? null, latestVersion: candidate.manifest.buildVersion, message: '' };
  } catch (error) {
    modpackUpdate = { ...modpackUpdate, state: 'error', message: error instanceof Error ? error.message : 'Не удалось проверить обновления.' };
  }
  return { ...modpackUpdate };
}

ipcMain.handle('kayvel:modpack-check', (event) => {
  if (!trusted(event)) throw new Error('Untrusted renderer');
  return checkModpackUpdate();
});
ipcMain.handle('kayvel:modpack-update', async (event) => {
  if (!trusted(event)) return { ok: false, message: 'Недоступно.' };
  if (operationBusy()) return { ok: false, message: 'Игра или другая операция уже выполняется.' };
  if (!modpackCandidate || modpackUpdate.state !== 'available') return { ok: false, message: 'Сначала проверьте наличие обновления сборки.' };
  const candidate = modpackCandidate;
  modpackCandidate = null;
  installing = true;
  modpackUpdate = { ...modpackUpdate, state: 'updating', message: '' };
  clearPreparation();
  try {
    const result = await updateModpack(neoforgePath(), candidate, MANIFEST_PUBLIC_KEY_PEM, reportPreparation);
    modpackUpdate = { state: 'current', installedVersion: result.version, latestVersion: result.version, message: '' };
    return { ok: true, message: `Сборка обновлена до ${result.version}. Резервная копия: ${result.backup ?? 'изменений нет'}.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось обновить сборку.';
    modpackUpdate = { ...modpackUpdate, state: 'error', message };
    stageProgress(reportPreparation, 'error', message);
    return { ok: false, message };
  } finally { installing = false; }
});

let launcherCandidate: SignedLauncher | null = null;
let launcherUpdate: LauncherUpdateStatus = { state: 'unchecked', installedVersion: app.getVersion(), latestVersion: null, message: '' };
ipcMain.handle('kayvel:launcher-check', async event => {
  if (!trusted(event)) throw new Error('Untrusted renderer');
  if (operationBusy() || launcherUpdate.state === 'checking') return { ...launcherUpdate };
  launcherCandidate = null;
  launcherUpdate = { ...launcherUpdate, state: 'checking', message: '' };
  try {
    const candidate = await discoverLauncher(MANIFEST_PUBLIC_KEY_PEM);
    if (operationBusy()) throw new Error('Другая операция выполняется. Повторите проверку позже.');
    if (!candidate) {
      launcherUpdate = { ...launcherUpdate, state: 'unavailable', latestVersion: null, message: '' };
      return { ...launcherUpdate };
    }
    const order = compareLauncherVersions(candidate.manifest.version, app.getVersion());
    if (order < 0) throw new Error('Сервер предлагает старую версию лаунчера. Откат заблокирован.');
    launcherCandidate = order > 0 ? candidate : null;
    launcherUpdate = { ...launcherUpdate, state: order > 0 ? 'available' : 'current', latestVersion: candidate.manifest.version, message: '' };
  } catch (error) {
    launcherUpdate = { ...launcherUpdate, state: 'error', message: error instanceof Error ? error.message : 'Не удалось проверить обновление лаунчера.' };
  }
  return { ...launcherUpdate };
});
ipcMain.handle('kayvel:launcher-update', async (event, language: unknown) => {
  if (!trusted(event)) return { ok: false, message: 'Недоступно.' };
  if (operationBusy()) return { ok: false, message: 'Игра или другая операция уже выполняется.' };
  if (!launcherCandidate || launcherUpdate.state !== 'available' || !window) return { ok: false, message: 'Сначала проверьте обновления лаунчера.' };
  installing = true;
  const ru = language !== 'en';
  const candidate = launcherCandidate;
  const controller = new AbortController();
  let handoffOpen = false;
  try {
    const answer = await dialog.showMessageBox(window, {
      type: 'question', buttons: ru ? ['Скачать и открыть установщик', 'Отмена'] : ['Download and open installer', 'Cancel'],
      defaultId: 1, cancelId: 1, title: 'KAYVEL',
      message: ru ? `Обновить лаунчер до ${candidate.manifest.version}?` : `Update launcher to ${candidate.manifest.version}?`,
      detail: ru ? 'Будет открыт отдельный установщик. После успешной установки это окно закроется и откроется новая версия. При отмене или ошибке старый лаунчер продолжит работать. Старые файлы и игровые данные сохранятся.' : 'A separate installer will open. After a successful installation, this window will close and the new version will open. If installation is cancelled or fails, the old launcher will keep running. Old files and game data are kept.'
    });
    if (answer.response !== 0) return { ok: false, message: ru ? 'Обновление отменено.' : 'Update cancelled.' };
    downloadController = controller;
    launcherUpdate = { ...launcherUpdate, state: 'downloading', message: '' };
    const path = await withDownloadSignal(controller.signal, () => stageLauncherUpdate(app.getPath('userData'), candidate, MANIFEST_PUBLIC_KEY_PEM, app.getVersion(), (received, total) => {
      reportPreparation({ stage: 'modpack', file: 'KAYVEL Setup', received, total, completedFiles: 0, totalFiles: 1 });
    }));
    controller.signal.throwIfAborted();
    await assertRecoveryProcessesStopped();
    controller.signal.throwIfAborted();
    handoffOpen = true;
    await openUpdateInstaller(path, {
      canQuit: async () => {
        await assertRecoveryProcessesStopped();
        if (!installing || gameRunning || modSwitching || preparingVanilla || preparingNeoForge || controller.signal.aborted) throw new Error('Launcher is busy');
      },
      quit: () => {
        handoffOpen = false;
        installing = false;
        downloadController = null;
        app.quit();
      },
      ended: error => {
        handoffOpen = false;
        installing = false;
        launcherUpdate = { ...launcherUpdate, state: 'error', message: error.message };
      }
    });
    if (!handoffOpen) return { ok: false, message: launcherUpdate.message };
    launcherCandidate = null;
    const message = ru ? 'Установщик открыт. После успешной установки лаунчер автоматически перейдёт на новую версию. При отмене старый останется работать.' : 'Installer opened. After a successful installation, the launcher will switch to the new version automatically. If cancelled, the old launcher will keep running.';
    launcherUpdate = { ...launcherUpdate, state: 'installer-open', message };
    return { ok: true, message };
  } catch (error) {
    handoffOpen = false;
    const message = controller.signal.aborted ? cancellationMessage : error instanceof Error ? error.message : 'Не удалось обновить лаунчер.';
    launcherUpdate = { ...launcherUpdate, state: 'error', message };
    return { ok: false, message };
  } finally { if (!handoffOpen) installing = false; downloadController = null; clearPreparation(); }
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
  downloadActive: downloadController !== null,
  downloadCancelling: downloadController?.signal.aborted ?? false,
  preparationIncomplete: existsSync(join(neoforgePath(), '.preparation', 'incomplete.json')),
  neoforgeVersion: NEOFORGE_VERSION,
  activeGamePath,
  gameRunning,
  installing,
  modSwitching,
  launcherUpdate: { ...launcherUpdate },
  modpackUpdate: { ...modpackUpdate },
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

ipcMain.handle('kayvel:cancel-download', event => {
  if (!trusted(event)) return { ok: false, message: 'Недоступно.' };
  if (!downloadController) return { ok: false, message: 'Активной загрузки нет.' };
  cancelDownload(downloadController);
  return { ok: true, message: 'Отмена запрошена. Ожидаем завершения записи файлов или текущего локального процессора NeoForge.' };
});
ipcMain.handle('kayvel:retry-download', (event, language: unknown) => trusted(event) ? downloadAndPlay(language, true) : { ok: false, message: 'Недоступно.' });
ipcMain.handle('kayvel:download-and-play', (event, language: unknown) => trusted(event) ? downloadAndPlay(language) : { ok: false, message: 'Недоступно.' });

async function downloadAndPlay(language: unknown, retry = false) {
  if (!localProfileReleaseReady || !RELEASE_MANIFEST_URL || !MANIFEST_PUBLIC_KEY_PEM) return { ok: false, message: 'Новый подписанный выпуск сборки ещё не настроен.' };
  if (modSwitching || preparingNeoForge || preparingVanilla || installing || gameRunning) return { ok: false, message: 'Подготовка или игра уже выполняется.' };
  const controller = new AbortController();
  downloadController = controller;
  preparingNeoForge = true;
  let phase = 'Проверка параметров установки';
  try {
    await withDownloadSignal(controller.signal, async () => {
      stageProgress(reportPreparation, 'verify', phase);
      validateNickname(localProfile.read().nickname);
      memorySettings.read();
      let manifestUrl = RELEASE_MANIFEST_URL;
      let expectedManifest: Buffer | undefined;
      if (!existsSync(neoforgePath()) || retry) {
        phase = 'Проверка доступной сборки';
        stageProgress(reportPreparation, 'discovery', phase);
        const latest = await discoverModpack(RELEASE_MANIFEST_URL, MANIFEST_PUBLIC_KEY_PEM);
        manifestUrl = modpackReleaseUrl(RELEASE_MANIFEST_URL, latest.manifest.buildVersion);
        expectedManifest = latest.bytes;
      }
      phase = 'Подготовка экземпляра';
      await prepareInstance(app.getPath('userData'), manifestUrl, MANIFEST_PUBLIC_KEY_PEM, reportPreparation, undefined, expectedManifest, { retry });
      checkDownloadCancelled();
    });
    if (controller.signal.aborted) return { ok: false, message: cancellationMessage };
    if (retry) return { ok: true, message: 'Повторная загрузка завершена. Нажмите «Играть» для запуска.' };
    preparingNeoForge = false;
    downloadController = null;
    return await playPreparedNeoForge(language);
  } catch (error) {
    const message = controller.signal.aborted ? cancellationMessage : `${phase}: ${error instanceof Error ? error.message : 'Не удалось подготовить игру.'}`;
    stageProgress(reportPreparation, 'error', message);
    return { ok: false, message };
  } finally { downloadController = null; preparingNeoForge = false; }
}

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
    const ffmpegController = new AbortController();
    downloadController = ffmpegController;
    try { await withDownloadSignal(ffmpegController.signal, () => prepareFFmpeg(gamePath, reportPreparation)); }
    finally { downloadController = null; }
    ffmpegController.signal.throwIfAborted();
    applyLocalSkin(gamePath, profile);
    applyGameDefaults(gamePath);
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

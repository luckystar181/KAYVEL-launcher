import React, { useEffect, useState } from 'react';
import { PreparationMeter } from './preparation-meter';
import { LauncherUpdatePanel } from './launcher-update-panel';
import type { LauncherUpdateStatus } from '../main/launcher-update-status';
import { ModpackUpdatePanel } from './modpack-update-panel';
import type { ModpackUpdateStatus } from '../main/modpack-update-status';
import { watchLauncherStatus } from './launcher-status';
import type { PreparationProgress } from '../main/preparation-progress';
import { SkinPreview3D } from './skin-preview-3d';
import { SkinHead } from './skin-head';
import { createRoot } from 'react-dom/client';
import './style.css';

type MemorySettings = { memoryMb: number; minMemoryMb: number; maxMemoryMb: number; totalMemoryMb: number };
type Status = { downloadActive: boolean; downloadCancelling: boolean; preparationIncomplete: boolean; releaseConfigured: boolean; gamePath: string; vanillaPath: string; vanillaReady: boolean; preparingVanilla: boolean; neoforgeReady: boolean; preparingNeoForge: boolean; gameRunning: boolean; installing: boolean; modSwitching: boolean; launcherUpdate: LauncherUpdateStatus; modpackUpdate: ModpackUpdateStatus; preparationProgress: PreparationProgress | null };
type Result = { ok: boolean; message: string };
type GameExit = { code: number | null; gamePath: string };
type LocalProfile = { nickname: string; skin: { model: 'classic' | 'slim'; bytes: number[]; copyPath: string; copyReady: boolean } | null };
type ModId = 'iris' | 'distantHorizons' | 'ssrd';
type ModSwitch = { id: ModId; state: 'enabled' | 'disabled' | 'unavailable' | 'conflict'; message?: string };
const modLabels: Record<ModId, string> = { iris: 'Iris', distantHorizons: 'Distant Horizons', ssrd: 'Separate Sable Render Distance' };
declare global {
  interface Window {
    kayvel: {
      status(): Promise<Status>;
      checkLauncherUpdates(): Promise<LauncherUpdateStatus>;
      updateLauncher(language: 'ru' | 'en'): Promise<Result>;
      checkModpackUpdates(): Promise<ModpackUpdateStatus>;
      updateModpack(): Promise<Result>;
      openGameFolder(language: 'ru' | 'en'): Promise<Result>;
      memorySettings(): Promise<MemorySettings>;
      saveMemoryMb(memoryMb: number): Promise<MemorySettings>;
      localProfile(): Promise<LocalProfile>;
      saveLocalNickname(nickname: string): Promise<LocalProfile>;
      saveLocalSkin(bytes: Uint8Array, model: 'classic' | 'slim'): Promise<LocalProfile>;
      gameBest(): Promise<number>;
      saveGameBest(score: number): Promise<number>;
      modSwitches(): Promise<ModSwitch[]>;
      setModEnabled(id: ModId, enabled: boolean): Promise<Result>;
      install(): Promise<Result>;
      playVanilla(language: 'ru' | 'en'): Promise<Result>;
      playNeoForge(language: 'ru' | 'en'): Promise<Result>;
      cancelDownload(): Promise<Result>;
      retryDownload(language: 'ru' | 'en'): Promise<Result>;
      downloadAndPlay(language: 'ru' | 'en'): Promise<Result>;
      onPreparationProgress(callback: (progress: PreparationProgress | null) => void): () => void;
      onGameExit(callback: (exit: GameExit) => void): () => void;
      window(action: 'minimize' | 'maximize' | 'close'): void;
    };
  }
}

const strings = {
  ru: {
    subtitle: 'Частный сервер · Minecraft Java Edition 1.21.1 · NeoForge',
    description: 'Пространство для своей команды. Всё необходимое - в одном месте.',
    install: 'УСТ. МОДПАК', play: 'ИГРАТЬ', settings: 'Настройки',
    preparing: 'Подготовка файлов…', noRelease: 'Сборка ещё не опубликована',
    downloadReady: 'Подписанный релиз доступен для установки файлов модпака', version: 'Версия лаунчера 0.2.9 · v3S',
    language: 'Язык', back: 'Назад', gameFolder: 'Папка Minecraft с модами',
    stage: 'СОСТОЯНИЕ ПРОЕКТА', pack: 'Модпак', game: 'Minecraft',
    soon: 'В разработке', waiting: 'Ожидает публикации', available: 'Подписанный релиз настроен',
    pathHint: 'Отдельный новый экземпляр. Прежние установки, моды и миры автоматически не переносятся.',
    vanilla: 'Ванильная 1.21.1', vanillaInstall: '1.21.1 НЕДОСТУПНА', vanillaPlay: 'ЗАПУСТИТЬ ТЕСТ',
    profile: 'Профиль', nickname: 'Ник, который вам установили на Discord-сервере',
    vanillaReady: 'Установлено', vanillaWaiting: 'Не установлена', running: 'Игра запущена',
    noJava: 'Java 21 не найдена; автоматическая загрузка отключена', preparationBlocked: 'Подготовка Minecraft и NeoForge временно отключена: загрузчики ещё не проверены на сохранность файлов и отсутствие повторов.', neoInstall: 'NEOFORGE НЕДОСТУПЕН', neoPlay: 'ЗАПУСТИТЬ NEOFORGE', neoReady: 'Установлено', neoWaiting: 'Не установлен', neoHint: 'Модпак устанавливается отдельно. Локальный запуск не подтверждает допуск на сервер.',
    gameSection: 'Мини-игра', gameTitle: 'Ударь Паспартама', gameHint: 'Поймай Паспартама за 30 секунд: нажимай на появляющуюся цель и побей свой рекорд.', gameCell: 'Паспартам', gameScore: 'СЧЁТ', gameBest: 'РЕКОРД', gameSoon: 'Скоро', gamePlay: 'ИГРАТЬ', skinPreview: 'Предпросмотр скина', chooseSkin: 'Загрузить PNG', skinPreviewHint: 'PNG 64×64 или 64×32, до 1 MiB.'
  },
  en: {
    subtitle: 'Private server · Minecraft Java Edition 1.21.1 · NeoForge',
    description: 'A place for your team. Everything you need in one place.',
    install: 'INSTALL', play: 'PLAY', settings: 'Settings',
    preparing: 'Preparing files…', noRelease: 'No modpack release has been published',
    downloadReady: 'A signed modpack release is available for file installation', version: 'Launcher 0.2.9 · v3S',
    language: 'Language', back: 'Back', gameFolder: 'Modded Minecraft folder',
    stage: 'PROJECT STATUS', pack: 'Modpack', game: 'Minecraft',
    soon: 'In development', waiting: 'Awaiting release', available: 'Signed release configured',
    pathHint: 'A separate new instance. Existing installations, mods and worlds are not migrated automatically.',
    vanilla: 'Vanilla 1.21.1', vanillaInstall: '1.21.1 UNAVAILABLE', vanillaPlay: 'LAUNCH TEST',
    profile: 'Profile', nickname: 'Nickname assigned to you on the Discord server',
    vanillaReady: 'Installed', vanillaWaiting: 'Not installed', running: 'Game running',
    noJava: 'Java 21 was not found; automatic download is disabled', preparationBlocked: 'Minecraft and NeoForge preparation is temporarily disabled: the downloaders have not yet been verified to preserve existing files and avoid retries.', neoInstall: 'NEOFORGE UNAVAILABLE', neoPlay: 'LAUNCH NEOFORGE', neoReady: 'Installed', neoWaiting: 'Not installed', neoHint: 'The modpack is installed separately. Local launch does not grant server access.',
    gameSection: 'Mini-game', gameTitle: 'Hit Passepartout', gameHint: 'Catch Passepartout in 30 seconds: tap the target and beat your best score.', gameCell: 'Passepartout', gameScore: 'SCORE', gameBest: 'BEST', gameSoon: 'Coming soon', gamePlay: 'PLAY', skinPreview: 'Skin preview', chooseSkin: 'Upload PNG', skinPreviewHint: 'PNG 64×64 or 64×32, up to 1 MiB.'
  }
};

const gameBestKey = 'kayvel.miniGame.best.v1';

function savedGameBest(): number {
  try {
    const value = Number(window.localStorage.getItem(gameBestKey));
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch { return 0; }
}

function App() {
  const [lang, setLang] = useState<'ru' | 'en'>('ru');
  const [status, setStatus] = useState<Status | null>(null);
  const [progress, setProgress] = useState<PreparationProgress | null>(null);
  const [settings, setSettings] = useState(false);
  const [openingFolder, setOpeningFolder] = useState(false);
  const [folderMessage, setFolderMessage] = useState('');
  const [memory, setMemory] = useState<MemorySettings | null>(null);
  const [memorySaving, setMemorySaving] = useState(false);
  const [memoryMessage, setMemoryMessage] = useState('');
  const [modSwitches, setModSwitches] = useState<ModSwitch[] | null>(null);
  const [modMessage, setModMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [message, setMessage] = useState('');
  const [nickname, setNickname] = useState('');
  const [savedNickname, setSavedNickname] = useState('');
  const [profileReady, setProfileReady] = useState(false);
  const [localSkin, setLocalSkin] = useState<LocalProfile['skin']>(null);
  const [skinModel, setSkinModel] = useState<'classic' | 'slim'>('classic');
  const [skinFile, setSkinFile] = useState<File | null>(null);
  const [skinMessage, setSkinMessage] = useState('');
  const [skinHeadFile, setSkinHeadFile] = useState<File | null>(null);
  const [gameOpen, setGameOpen] = useState(false);
  const [skinOpen, setSkinOpen] = useState(false);
  const [gameTime, setGameTime] = useState(0);
  const [gameTarget, setGameTarget] = useState(5);
  const [gameScore, setGameScore] = useState(0);
  const [gameBest, setGameBest] = useState(0);
  const [gameBestReady, setGameBestReady] = useState(false);
  const [gameBestError, setGameBestError] = useState(false);
  useEffect(() => {
    let active = true;
    async function loadBest() {
      try {
        const saved = await window.kayvel.gameBest();
        const migrated = savedGameBest();
        const best = migrated > saved ? await window.kayvel.saveGameBest(migrated) : saved;
        if (active) setGameBest(best);
      } catch { if (active) setGameBestError(true); }
      finally { if (active) setGameBestReady(true); }
    }
    void loadBest();
    return () => { active = false; };
  }, []);
  const t = strings[lang];
  useEffect(() => {
    if (gameTime <= 0 || !gameOpen) return;
    const timer = window.setTimeout(() => setGameTime(time => time - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [gameTime, gameOpen]);
  useEffect(() => {
    if (!gameOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setGameOpen(false); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [gameOpen]);
  useEffect(() => {
    if (!skinOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setSkinOpen(false); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [skinOpen]);
  function hitTarget() {
    if (gameTime <= 0 || !gameBestReady) return;
    const next = gameScore + 1;
    setGameScore(next);
    if (next > gameBest) {
      setGameBest(next);
      void window.kayvel.saveGameBest(next).then(best => setGameBest(current => Math.max(current, best))).catch(() => setGameBestError(true));
    }
    setGameTarget(previous => (previous + 1 + Math.floor(Math.random() * 15)) % 16);
  }
  function startGame() {
    setGameScore(0);
    setGameTarget(Math.floor(Math.random() * 16));
    setGameTime(30);
  }
  function showLocalProfile(profile: LocalProfile) {
    setNickname(profile.nickname);
    setSavedNickname(profile.nickname);
    setLocalSkin(profile.skin);
    setSkinHeadFile(profile.skin ? new File([new Uint8Array(profile.skin.bytes)], `${profile.nickname}.png`, { type: 'image/png' }) : null);
    if (profile.skin) setSkinModel(profile.skin.model);
  }
  useEffect(() => {
    let active = true;
    void window.kayvel.localProfile().then(profile => {
      if (active) { showLocalProfile(profile); setProfileReady(true); }
    }).catch(() => { if (active) setMessage('Не удалось прочитать локальный профиль. Проверьте папку local-player; файлы не изменены.'); });
    return () => { active = false; };
  }, []);
  useEffect(() => watchLauncherStatus<Status>(window.kayvel, {
    status: setStatus,
    progress: setProgress,
    exit: exit => {
      setStatus(current => current ? { ...current, gameRunning: false, preparationProgress: null } : current);
      setMessage(exit.code === 0 ? 'Minecraft закрыт.' : `Minecraft завершился с кодом ${exit.code ?? 'неизвестно'}. Журнал: ${exit.gamePath}\\logs\\latest.log`);
    },
    error: () => setMessage('Launcher IPC unavailable')
  }), []);
  async function saveNickname() {
    setBusy(true);
    try {
      const profile = await window.kayvel.saveLocalNickname(nickname.trim());
      showLocalProfile(profile);
      setMessage(lang === 'ru' ? 'Ник сохранён на этом компьютере. Смена ника может изменить игровую личность и доступ к вещам.' : 'Name saved locally. Changing it can change your in-game identity and inventory.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось сохранить ник.');
    } finally { setBusy(false); }
  }
  async function saveSkinLocally() {
    const selected = skinFile ?? skinHeadFile;
    if (!selected || !savedNickname || nickname !== savedNickname) return;
    setBusy(true);
    try {
      if (selected.size > 1_048_576) throw new Error('Выберите PNG размером не более 1 MiB.');
      const image = await createImageBitmap(selected);
      const valid = image.width === 64 && (image.height === 64 || image.height === 32);
      image.close();
      if (!valid) throw new Error('Нужен PNG 64×64 или 64×32.');
      const profile = await window.kayvel.saveLocalSkin(new Uint8Array(await selected.arrayBuffer()), skinModel);
      showLocalProfile(profile);
      setSkinFile(null);
      setSkinMessage(lang === 'ru' ? 'Копия сохранена. Скин применится при следующем запуске сборки. Видимость другим игрокам не гарантируется.' : 'Copy saved. The skin will be applied the next time you launch the modpack. Other players may not see it.');
    } catch (error) {
      setSkinMessage(error instanceof Error ? error.message : 'Не удалось сохранить скин.');
    } finally { setBusy(false); }
  }
  async function refreshModSwitches() {
    try { setModSwitches(await window.kayvel.modSwitches()); }
    catch (error) {
      setModSwitches(null);
      setModMessage(error instanceof Error ? error.message : 'Не удалось проверить моды.');
    }
  }
  async function refreshMemory() {
    try { setMemory(await window.kayvel.memorySettings()); setMemoryMessage(''); }
    catch (error) { setMemoryMessage(error instanceof Error ? error.message : 'Не удалось прочитать настройку ОЗУ.'); }
  }
  useEffect(() => { void refreshMemory(); }, []);
  async function changeMemory(memoryMb: number) {
    setMemorySaving(true);
    setMemoryMessage('');
    try {
      setMemory(await window.kayvel.saveMemoryMb(memoryMb));
      setMemoryMessage(lang === 'ru' ? 'Сохранено. Применится при запуске игры.' : 'Saved. Applies when the game starts.');
    } catch (error) { setMemoryMessage(error instanceof Error ? error.message : 'Не удалось сохранить настройку ОЗУ.'); }
    finally { setMemorySaving(false); }
  }
  async function openGameFolder() {
    if (openingFolder) return;
    setOpeningFolder(true);
    setFolderMessage('');
    try {
      const result = await window.kayvel.openGameFolder(lang);
      setFolderMessage(result.message);
    } catch { setFolderMessage(lang === 'ru' ? 'Не удалось открыть папку игры в Проводнике.' : 'Could not open the game folder in Explorer.'); }
    finally { setOpeningFolder(false); }
  }
  function toggleSettings() {
    if (!settings) { setFolderMessage(''); setModMessage(''); void refreshModSwitches(); void refreshMemory(); }
    setSettings(!settings);
  }
  async function changeMod(id: ModId, enabled: boolean) {
    setBusy(true);
    setModMessage('');
    try {
      const result = await window.kayvel.setModEnabled(id, enabled);
      setModMessage(result.message);
      await refreshModSwitches();
    } catch (error) { setModMessage(error instanceof Error ? error.message : 'Не удалось переключить мод.'); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    let active = true;
    setCheckingUpdates(true);
    void Promise.allSettled([window.kayvel.checkModpackUpdates(), window.kayvel.checkLauncherUpdates()]).then(() => window.kayvel.status()).then(value => {
      if (active) setStatus(value);
    }).catch(() => { if (active) setMessage('Не удалось проверить обновления сборки.'); }).finally(() => {
      if (active) setCheckingUpdates(false);
    });
    return () => { active = false; };
  }, []);
  async function checkUpdates() {
    if (checkingUpdates || busy) return;
    setCheckingUpdates(true);
    try {
      await window.kayvel.checkModpackUpdates();
      setStatus(await window.kayvel.status());
    } catch { setMessage(lang === 'ru' ? 'Не удалось проверить обновления.' : 'Could not check for updates.'); }
    finally { setCheckingUpdates(false); }
  }
  async function checkLauncherUpdates() {
    if (busy || checkingUpdates) return;
    setCheckingUpdates(true);
    try { await window.kayvel.checkLauncherUpdates(); setStatus(await window.kayvel.status()); }
    catch { setMessage(lang === 'ru' ? 'Не удалось проверить лаунчер.' : 'Could not check launcher updates.'); }
    finally { setCheckingUpdates(false); }
  }
  async function applyLauncherUpdate() {
    if (busy || status?.launcherUpdate.state !== 'available') return;
    setBusy(true);
    try { const result = await window.kayvel.updateLauncher(lang); setMessage(result.message); setStatus(await window.kayvel.status()); }
    catch { setMessage(lang === 'ru' ? 'Не удалось обновить лаунчер.' : 'Could not update launcher.'); }
    finally { setBusy(false); }
  }
  async function applyUpdate() {
    if (busy || status?.modpackUpdate.state !== 'available') return;
    setBusy(true);
    setProgress(null);
    setMessage('');
    try {
      const result = await window.kayvel.updateModpack();
      setMessage(result.message);
      setStatus(await window.kayvel.status());
      await refreshModSwitches();
    } catch { setMessage(lang === 'ru' ? 'Обновление прервано. Не удаляйте резервную копию и файлы .kayvel.' : 'Update interrupted. Do not delete the backup or .kayvel files.'); }
    finally { setBusy(false); }
  }
  async function cancelActiveDownload() {
    try {
      const result = await window.kayvel.cancelDownload();
      setMessage(result.message);
      setStatus(await window.kayvel.status());
    } catch { setMessage(lang === 'ru' ? 'Не удалось запросить отмену.' : 'Could not request cancellation.'); }
  }
  async function downloadAndPlay(retry = false) {
    if (!status?.releaseConfigured || busy) return;
    if (retry && !window.confirm(lang === 'ru' ? 'Незавершённые Java, Minecraft и NeoForge будут сохранены в .kayvel/preparation-backups и скачаны заново. Миры, скриншоты, настройки и модпак не изменяются. Продолжить?' : 'Incomplete Java, Minecraft and NeoForge files will be backed up in .kayvel/preparation-backups and downloaded again. Worlds, screenshots, settings and modpack files are unchanged. Continue?')) return;
    setBusy(true);
    setProgress(null);
    setMessage('');
    try {
      const result = retry ? await window.kayvel.retryDownload(lang) : await window.kayvel.downloadAndPlay(lang);
      setMessage(result.message);
      setStatus(await window.kayvel.status());
    } catch { setMessage(lang === 'ru' ? 'Операция прервана. Проверьте сохранённые файлы; автоматического повтора нет.' : 'Operation interrupted. Inspect the saved files; no automatic retry was made.'); }
    finally { setBusy(false); }
  }
  const updateAvailable = status?.modpackUpdate.state === 'available' || status?.launcherUpdate.state === 'available';
  const updateChecking = checkingUpdates || status?.modpackUpdate.state === 'checking' || status?.launcherUpdate.state === 'checking';
  const updateFailed = status?.modpackUpdate.state === 'error' || status?.launcherUpdate.state === 'error';
  const updateSummary = updateAvailable ? (lang === 'ru' ? 'Доступно обновление' : 'Update available') : updateChecking ? (lang === 'ru' ? 'Проверяем…' : 'Checking…') : updateFailed ? (lang === 'ru' ? 'Не удалось проверить' : 'Could not check') : (lang === 'ru' ? 'Сборка и лаунчер' : 'Modpack and launcher');
  return <div className="shell">
    <header className="titlebar">
      <span className="brand-mini">K<span>◆</span>YVEL</span>
      <div className="window-controls">
        <button aria-label="Свернуть" onClick={() => window.kayvel.window('minimize')}>−</button>
        <button aria-label="Развернуть" onClick={() => window.kayvel.window('maximize')}>□</button>
        <button aria-label="Закрыть" onClick={() => window.kayvel.window('close')}>×</button>
      </div>
    </header>
    <main>
      <div className="topline"><span className="edition">MINECRAFT 1.21.1 <span className="divider">/</span> NEOFORGE</span><nav className="top-tabs" aria-label={lang === 'ru' ? 'Разделы' : 'Sections'}><button className={skinOpen ? 'active' : ''} onClick={() => { setSkinOpen(true); setGameOpen(false); }}>{lang === 'ru' ? 'Скин' : 'Skin'}</button><button className={gameOpen ? 'active' : ''} onClick={() => { setGameOpen(true); setSkinOpen(false); }}>{lang === 'ru' ? 'Мини-игра' : 'Mini-game'}</button></nav><button className="settings" onClick={toggleSettings} aria-label={t.settings} title={t.settings}>⚙</button></div>
      {settings ? <section className="settings-panel"><span className="eyebrow">KAYVEL / {t.settings.toUpperCase()}</span><h1>{t.settings}</h1><label htmlFor="language">{t.language}</label><select id="language" value={lang} onChange={event => setLang(event.target.value as 'ru' | 'en')}><option value="ru">Русский</option><option value="en">English</option></select><div className="path-block"><div className="path-block-heading"><span className="eyebrow">{t.gameFolder}</span><button type="button" className="open-game-folder" disabled={!status || openingFolder} onClick={() => void openGameFolder()}>{lang === 'ru' ? 'Открыть папку' : 'Open folder'}</button></div><code>{status?.gamePath ?? '…'}</code><p>{t.pathHint}</p><p role="status">{folderMessage}</p></div>
      <section className="memory-settings" aria-labelledby="memory-heading"><h2 id="memory-heading">{lang === 'ru' ? 'Оперативная память' : 'Memory'}</h2><label htmlFor="memory-mb">{lang === 'ru' ? 'ОЗУ для Minecraft' : 'RAM for Minecraft'}</label><select id="memory-mb" value={memory?.memoryMb ?? ''} disabled={!memory || memorySaving || busy || !status || status.gameRunning || status.preparingNeoForge || status.preparingVanilla || status.installing || status.modSwitching} onChange={event => void changeMemory(Number(event.target.value))}>{!memory && <option value="">…</option>}{memory && Array.from({ length: (memory.maxMemoryMb - memory.minMemoryMb) / 512 + 1 }, (_, index) => memory.minMemoryMb + index * 512).map(value => <option key={value} value={value}>{value / 1024} {lang === 'ru' ? 'ГБ' : 'GB'}</option>)}</select><p>{memory && (lang === 'ru' ? `На компьютере ${(memory.totalMemoryMb / 1024).toFixed(1)} ГБ · для игры доступно до ${memory.maxMemoryMb / 1024} ГБ. Рекомендуется 3–4 ГБ для этой сборки, если хватает памяти.` : `System RAM: ${(memory.totalMemoryMb / 1024).toFixed(1)} GB · up to ${memory.maxMemoryMb / 1024} GB for the game. 3–4 GB is recommended for this modpack if available.`)}</p><p role="status">{memoryMessage}</p></section>
      <section className="mod-settings" aria-labelledby="mods-heading">
        <div className="mod-settings-head"><h2 id="mods-heading">{lang === 'ru' ? 'Дополнительные моды' : 'Optional mods'}</h2><button type="button" disabled={busy} onClick={() => void refreshModSwitches()}>{lang === 'ru' ? 'Проверить' : 'Refresh'}</button></div>
        <p>{lang === 'ru' ? 'Файл отключённого мода сохраняется, и его можно включить обратно. Работает только с новой установленной подписанной сборкой; старые файлы автоматически не меняются.' : 'Disabled mod files are kept and can be enabled again. A newly installed signed modpack is required; old files are not changed automatically.'}</p>
        {(Object.keys(modLabels) as ModId[]).map(id => {
          const mod = modSwitches?.find(item => item.id === id);
          const available = mod?.state === 'enabled' || mod?.state === 'disabled';
          const stateText = !mod ? (lang === 'ru' ? 'Проверка…' : 'Checking…') : mod.state === 'enabled' ? (lang === 'ru' ? 'Включён' : 'Enabled') : mod.state === 'disabled' ? (lang === 'ru' ? 'Выключен' : 'Disabled') : mod.state === 'conflict' ? (lang === 'ru' ? 'Требуется проверка' : 'Needs inspection') : (lang === 'ru' ? 'Недоступен' : 'Unavailable');
          return <div className="mod-row" key={id}><div><strong>{modLabels[id]}</strong><small>{mod?.message || stateText}</small></div><label className="mod-toggle"><span className="sr-only">{modLabels[id]}</span><input type="checkbox" checked={mod?.state === 'enabled'} disabled={!available || busy || !status || status.gameRunning || status.preparingVanilla || status.preparingNeoForge || status.installing || status.modSwitching} onChange={event => void changeMod(id, event.target.checked)} /><span>{stateText}</span></label></div>;
        })}
        <p role="status">{modMessage}</p>
        <p>{lang === 'ru' ? 'Не переключайте моды, пока Minecraft запущен вне KAYVEL. При конфликте или сбое не удаляйте файлы наугад.' : 'Do not switch mods while Minecraft is running outside KAYVEL. If there is a conflict or failure, do not delete files blindly.'}</p>
      </section>
      <button className="text-button" onClick={toggleSettings}>← {t.back}</button></section> :
      <section className="hero">
        <section className="profile-strip">
          <div className="profile-intro"><SkinHead file={skinHeadFile} label={lang === 'ru' ? 'Голова выбранного скина' : 'Selected skin head'} /><div><span className="eyebrow">{t.profile}</span><strong>{savedNickname || (lang === 'ru' ? 'Укажите ник' : 'Choose a name')}</strong></div></div>
          <div className="local-test"><label htmlFor="nickname">{t.nickname}</label><input id="nickname" value={nickname} disabled={!profileReady || busy} maxLength={16} placeholder="Player_123" autoComplete="off" onChange={event => setNickname(event.target.value)} /><button disabled={!profileReady || busy || nickname === savedNickname || !/^[A-Za-z0-9_]{3,16}$/.test(nickname)} onClick={() => void saveNickname()}>{lang === 'ru' ? 'Сохранить ник' : 'Save name'}</button></div>
        </section>
        <div className="home-grid">
          <section className="identity-panel">
            <div className="home-showcase"><div className="brand-display"><span className="eyebrow">MINECRAFT JAVA EDITION</span><h1>KAYVEL</h1><p>{lang === 'ru' ? 'Твоя команда. Твой мир.' : 'Your team. Your world.'}</p></div><section className="home-skin" aria-label={lang === 'ru' ? 'Скин на главном экране' : 'Skin on home screen'}><div className="home-skin-heading"><span className="eyebrow">{savedNickname || t.profile}</span><button type="button" onClick={() => { setSkinOpen(true); setGameOpen(false); }}>{lang === 'ru' ? 'Изменить скин' : 'Change skin'}</button></div>{!skinOpen && <SkinPreview3D file={skinFile ?? skinHeadFile} model={skinModel} lang={lang} />}</section></div>
          </section>
        </div>
        <div className="launch-bar">
          <div className="launch-copy"><span className="eyebrow">{t.game}</span><strong>{status?.gameRunning ? t.running : status?.neoforgeReady ? t.neoReady : t.neoWaiting}</strong><small role="status">{message}</small></div>
          <div className="actions"><button className="play" disabled={!status?.releaseConfigured || busy || status.preparingVanilla || status.preparingNeoForge || status.installing || status.modSwitching || status.gameRunning || !profileReady || !savedNickname || nickname !== savedNickname} onClick={() => void downloadAndPlay(Boolean(status?.preparationIncomplete))}>{status?.gameRunning ? t.running : busy ? t.preparing : status?.preparationIncomplete ? (lang === 'ru' ? 'Повторить загрузку' : 'Retry download') : status?.neoforgeReady ? t.play : (lang === 'ru' ? 'Скачать и играть' : 'Download and play')}<span>→</span></button></div>
        </div>
        {status?.downloadActive && <div className="download-controls"><button type="button" disabled={status.downloadCancelling} onClick={() => void cancelActiveDownload()}>{status.downloadCancelling ? (lang === 'ru' ? 'Останавливаем…' : 'Stopping…') : (lang === 'ru' ? 'Отменить загрузку' : 'Cancel download')}</button><small>{lang === 'ru' ? 'Текущая запись файлов или локальная подготовка NeoForge завершится безопасно. Игра после отмены не запустится.' : 'Any current file write or local NeoForge task will finish safely. Cancellation will not launch the game.'}</small></div>}
        <details className={`home-updates${updateAvailable ? ' has-update' : ''}`}>
          <summary><span>{lang === 'ru' ? 'Обновления' : 'Updates'}</span><small role="status">{updateSummary}</small></summary>
          <div className="home-update-panels">
        <ModpackUpdatePanel status={status?.modpackUpdate ?? null} busy={busy || !status || status.gameRunning || status.preparingNeoForge || status.preparingVanilla || status.installing || status.modSwitching} checking={checkingUpdates} lang={lang} onCheck={() => void checkUpdates()} onUpdate={() => void applyUpdate()} />
        <LauncherUpdatePanel status={status?.launcherUpdate ?? null} busy={busy || checkingUpdates || !status || status.gameRunning || status.preparingNeoForge || status.preparingVanilla || status.installing || status.modSwitching} lang={lang} onCheck={() => void checkLauncherUpdates()} onUpdate={() => void applyLauncherUpdate()} />
          </div>
        </details>
        {progress && !status?.gameRunning && <PreparationMeter progress={progress} lang={lang} />}
      </section>}
 {skinOpen && !settings && <div className="game-overlay" onMouseDown={event => { if (event.target === event.currentTarget) setSkinOpen(false); }}><section className="skin-dialog" role="dialog" aria-modal="true" aria-label={t.skinPreview}>
        <div className="game-dialog-head"><div><span className="eyebrow">KAYVEL / {lang === 'ru' ? 'СКИН' : 'SKIN'}</span><h2>{t.skinPreview}</h2></div><button className="game-close" aria-label={t.back} onClick={() => setSkinOpen(false)}>×</button></div>
        <div className="skin-dialog-body"><div className="skin-viewer"><SkinPreview3D file={skinFile ?? skinHeadFile} model={skinModel} lang={lang} /><span>{lang === 'ru' ? 'Перетащите мышью для вращения · колёсико для масштаба' : 'Drag to rotate · scroll to zoom'}</span></div>
          <div className="skin-panel skin-controls"><strong>{skinFile?.name || (localSkin ? `${savedNickname}.png · ${localSkin.model}` : t.skinPreviewHint)}</strong>
            <div className="skin-actions"><label className="skin-upload">{t.chooseSkin}<input type="file" accept="image/png" disabled={busy} onChange={event => { setSkinFile(event.currentTarget.files?.[0] ?? null); event.currentTarget.value = ''; setSkinMessage(''); }} /></label></div>
            <div className="skin-meta"><label htmlFor="skin-model">{lang === 'ru' ? 'Модель' : 'Model'}</label><select id="skin-model" disabled={busy} value={skinModel} onChange={event => setSkinModel(event.target.value as 'classic' | 'slim')}><option value="classic">Classic</option><option value="slim">Slim</option></select></div>
            <button className="skin-submit" disabled={!profileReady || busy || !savedNickname || nickname !== savedNickname || (!skinFile && (!localSkin || (skinModel === localSkin.model && localSkin.copyReady)))} onClick={() => void saveSkinLocally()}>{localSkin ? (lang === 'ru' ? 'Сохранить изменения' : 'Save changes') : (lang === 'ru' ? 'Сохранить скин' : 'Save skin')}</button>
            <p className="skin-note">{lang === 'ru' ? 'Сначала сохраните ник. Выбранный PNG применяется локально при следующем запуске сборки через CustomSkinLoader. Скин не загружается на сторонние сайты; другие игроки могут его не видеть.' : 'Save your name first. Your PNG is applied locally through CustomSkinLoader the next time you launch the modpack. It is not uploaded to third-party sites; other players may not see it.'}</p>
            {localSkin && <div className="skin-copy-path"><span>{localSkin.copyReady ? (lang === 'ru' ? 'Копия PNG:' : 'PNG copy:') : (lang === 'ru' ? 'Копия отсутствует или изменена извне:' : 'Copy is missing or changed externally:')}</span><code>{localSkin.copyPath}</code></div>}
            <p className="skin-note" role="status">{skinMessage}</p>
          </div></div>
      </section></div>}
      {gameOpen && !settings && <div className="game-overlay" onMouseDown={event => { if (event.target === event.currentTarget) setGameOpen(false); }}><section className="game-dialog" role="dialog" aria-modal="true" aria-label={t.gameTitle}>
        <div className="game-dialog-head"><div><span className="eyebrow">{t.gameSection} / KAYVEL</span><h2>{t.gameTitle}</h2></div><button className="game-close" aria-label={t.back} onClick={() => setGameOpen(false)}>×</button></div>
        <div className="game-info"><span>{t.gameScore}<strong>{gameScore}</strong></span><span>{t.gameBest}<strong>{gameBest}</strong></span><span>{lang === 'ru' ? 'ВРЕМЯ' : 'TIME'}<strong>{gameTime}с</strong></span></div>
        <div className="game-board">{Array.from({ length: 16 }, (_, index) => <button key={index} className={`game-tile ${gameTime > 0 && index === gameTarget ? 'target' : ''}`} disabled={gameTime <= 0 || index !== gameTarget} onClick={hitTarget} aria-label={`${t.gameCell} ${index + 1}`}>{gameTime > 0 && index === gameTarget ? '💩' : ''}</button>)}</div>
        <div className="game-dialog-foot"><p role="status">{gameBestError ? (lang === 'ru' ? 'Не удалось сохранить рекорд на диск. Проверьте доступ к папке данных лаунчера.' : 'Could not save the record to disk. Check access to launcher data.') : gameTime > 0 ? (lang === 'ru' ? 'Нажимай на Паспартама, пока не истекло время!' : 'Hit Passepartout before time runs out!') : t.gameHint}</p><button className="game-play" disabled={!gameBestReady} onClick={startGame}>{gameTime > 0 ? (lang === 'ru' ? 'ЗАНОВО' : 'RESTART') : t.gamePlay}</button></div>
      </section></div>}
    </main>
    <footer><span className="footer-version">{t.version}</span></footer>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);

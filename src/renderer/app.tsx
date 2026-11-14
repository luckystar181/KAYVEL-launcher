import React, { useEffect, useState } from 'react';
import { SkinPreview3D } from './skin-preview-3d';
import { SkinHead } from './skin-head';
import { createRoot } from 'react-dom/client';
import './style.css';

type Status = { releaseConfigured: boolean; gamePath: string; vanillaPath: string; vanillaReady: boolean; preparingVanilla: boolean; neoforgeReady: boolean; preparingNeoForge: boolean; gameRunning: boolean; javaFound: boolean; installing: boolean; modSwitching: boolean };
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
      localProfile(): Promise<LocalProfile>;
      saveLocalNickname(nickname: string): Promise<LocalProfile>;
      saveLocalSkin(bytes: Uint8Array, model: 'classic' | 'slim'): Promise<LocalProfile>;
      news(): Promise<{ id: string; date: string; title: string; text: string }[]>;
      gameBest(): Promise<number>;
      saveGameBest(score: number): Promise<number>;
      skinByNickname(nickname: string): Promise<Result & { bytes?: number[]; model?: 'classic' | 'slim' }>;
      modSwitches(): Promise<ModSwitch[]>;
      setModEnabled(id: ModId, enabled: boolean): Promise<Result>;
      install(): Promise<Result>;
      playVanilla(language: 'ru' | 'en'): Promise<Result>;
      playNeoForge(language: 'ru' | 'en'): Promise<Result>;
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
    downloadReady: 'Подписанный релиз доступен для установки файлов модпака', version: 'Версия лаунчера 0.1.0 · Разработка',
    language: 'Язык', back: 'Назад', gameFolder: 'Папка игры',
    stage: 'СОСТОЯНИЕ ПРОЕКТА', pack: 'Модпак', game: 'Запуск игры',
    soon: 'В разработке', waiting: 'Ожидает публикации', available: 'Подписанный релиз настроен',
    pathHint: 'Сюда устанавливаются файлы модпака; NeoForge устанавливается отдельно.',
    vanilla: 'Ванильная 1.21.1', vanillaInstall: '1.21.1 НЕДОСТУПНА', vanillaPlay: 'ЗАПУСТИТЬ ТЕСТ',
    nickname: 'Ник игрока', localHint: 'Ник сохраняется на этом компьютере. Whitelist и пароль проверяются сервером, а не лаунчером.',
    vanillaReady: 'Установлена для локального теста', vanillaWaiting: 'Не установлена', running: 'Игра запущена',
    noJava: 'Java 21 не найдена; автоматическая загрузка отключена', preparationBlocked: 'Подготовка Minecraft и NeoForge временно отключена: загрузчики ещё не проверены на сохранность файлов и отсутствие повторов.', vanillaFolder: 'Папка ванильной игры', neoInstall: 'NEOFORGE НЕДОСТУПЕН', neoPlay: 'ЗАПУСТИТЬ NEOFORGE', neoReady: 'Установлен для локального теста', neoWaiting: 'Не установлен', neoHint: 'Модпак устанавливается отдельно. Локальный запуск не подтверждает допуск на сервер.',
    news: 'Новости', newsTitle: 'Новости KAYVEL', newsEmpty: 'Пока тихо', newsHint: 'Здесь появятся обновления сервера, события и важные объявления.', gameSection: 'Мини-игра', gameTitle: 'Ударь Паспартама', gameHint: 'Поймай Паспартама за 30 секунд: нажимай на появляющуюся цель и побей свой рекорд.', gameCell: 'Паспартам', gameScore: 'СЧЁТ', gameBest: 'РЕКОРД', gameSoon: 'Скоро', gamePlay: 'ИГРАТЬ', skinPreview: 'Предпросмотр скина', chooseSkin: 'Загрузить PNG', chooseNameMc: 'Найти по нику Minecraft', skinPreviewHint: 'PNG 64×64 или 64×32, до 1 MiB. Поиск по нику — через сервисы Minecraft, не NameMC.'
  },
  en: {
    subtitle: 'Private server · Minecraft Java Edition 1.21.1 · NeoForge',
    description: 'A place for your team. Everything you need in one place.',
    install: 'INSTALL', play: 'PLAY', settings: 'Settings',
    preparing: 'Preparing files…', noRelease: 'No modpack release has been published',
    downloadReady: 'A signed modpack release is available for file installation', version: 'Launcher 0.1.0 · Development',
    language: 'Language', back: 'Back', gameFolder: 'Game folder',
    stage: 'PROJECT STATUS', pack: 'Modpack', game: 'Game launch',
    soon: 'In development', waiting: 'Awaiting release', available: 'Signed release configured',
    pathHint: 'Modpack files are installed here; NeoForge is installed separately.',
    vanilla: 'Vanilla 1.21.1', vanillaInstall: '1.21.1 UNAVAILABLE', vanillaPlay: 'LAUNCH TEST',
    nickname: 'Player name', localHint: 'Your name is saved on this computer. The server checks its whitelist and password, not the launcher.',
    vanillaReady: 'Installed for local testing', vanillaWaiting: 'Not installed', running: 'Game running',
    noJava: 'Java 21 was not found; automatic download is disabled', preparationBlocked: 'Minecraft and NeoForge preparation is temporarily disabled: the downloaders have not yet been verified to preserve existing files and avoid retries.', vanillaFolder: 'Vanilla game folder', neoInstall: 'NEOFORGE UNAVAILABLE', neoPlay: 'LAUNCH NEOFORGE', neoReady: 'Installed for local testing', neoWaiting: 'Not installed', neoHint: 'The modpack is installed separately. Local launch does not grant server access.',
    news: 'News', newsTitle: 'KAYVEL news', newsEmpty: 'Quiet for now', newsHint: 'Server updates, events and important announcements will appear here.', gameSection: 'Mini-game', gameTitle: 'Hit Passepartout', gameHint: 'Catch Passepartout in 30 seconds: tap the target and beat your best score.', gameCell: 'Passepartout', gameScore: 'SCORE', gameBest: 'BEST', gameSoon: 'Coming soon', gamePlay: 'PLAY', skinPreview: 'Skin preview', chooseSkin: 'Upload PNG', chooseNameMc: 'Find by Minecraft name', skinPreviewHint: 'PNG 64×64 or 64×32, up to 1 MiB. Name lookup uses Minecraft services, not NameMC.'
  }
};

async function normalizeMinecraftSkin(bytes: number[]): Promise<Blob> {
  const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
  try {
    if (image.width !== 64 || image.height !== 32) return new Blob([new Uint8Array(bytes)], { type: 'image/png' });
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext('2d')!;
    context.imageSmoothingEnabled = false;
    context.drawImage(image, 0, 0);
    const mirror = (sx: number, sy: number, width: number, height: number, dx: number, dy: number) => {
      context.save();
      context.translate(dx + width, dy);
      context.scale(-1, 1);
      context.drawImage(image, sx, sy, width, height, 0, 0, width, height);
      context.restore();
    };
    for (const [oldX, newX] of [[40, 32], [0, 16]]) {
      mirror(oldX + 4, 16, 4, 4, newX + 4, 48);
      mirror(oldX + 8, 16, 4, 4, newX + 8, 48);
      mirror(oldX + 8, 20, 4, 12, newX, 52);
      mirror(oldX + 4, 20, 4, 12, newX + 4, 52);
      mirror(oldX, 20, 4, 12, newX + 8, 52);
      mirror(oldX + 12, 20, 4, 12, newX + 12, 52);
    }
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG conversion failed');
    return blob;
  } finally { image.close(); }
}

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
  const [settings, setSettings] = useState(false);
  const [modSwitches, setModSwitches] = useState<ModSwitch[] | null>(null);
  const [modMessage, setModMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [nickname, setNickname] = useState('');
  const [savedNickname, setSavedNickname] = useState('');
  const [profileReady, setProfileReady] = useState(false);
  const [localSkin, setLocalSkin] = useState<LocalProfile['skin']>(null);
  const [skinModel, setSkinModel] = useState<'classic' | 'slim'>('classic');
  const [skinFile, setSkinFile] = useState<File | null>(null);
  const [skinNickname, setSkinNickname] = useState('');
  const [skinMessage, setSkinMessage] = useState('');
  const [skinHeadFile, setSkinHeadFile] = useState<File | null>(null);
  const [newsItems, setNewsItems] = useState<{ id: string; date: string; title: string; text: string }[]>([]);
  const [newsError, setNewsError] = useState(false);
  const [gameOpen, setGameOpen] = useState(false);
  const [skinOpen, setSkinOpen] = useState(false);
  const [newsOpen, setNewsOpen] = useState(false);
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
  useEffect(() => {
    if (!newsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setNewsOpen(false); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [newsOpen]);
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
  useEffect(() => {
    void window.kayvel.news().then(setNewsItems).catch(() => { setNewsItems([]); setNewsError(true); });
  }, []);
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
  useEffect(() => {
    void window.kayvel.status().then(setStatus).catch(() => setMessage('Launcher IPC unavailable'));
    const unsubscribe = window.kayvel.onGameExit(exit => {
      setMessage(exit.code === 0 ? 'Minecraft закрыт.' : `Minecraft завершился с кодом ${exit.code ?? 'неизвестно'}. Журнал: ${exit.gamePath}\\logs\\latest.log`);
      void window.kayvel.status().then(setStatus).catch(() => {});
    });
    return unsubscribe;
  }, []);
  async function findSkinByNickname() {
    setBusy(true);
    try {
      const result = await window.kayvel.skinByNickname(skinNickname.trim());
      setSkinMessage(result.message);
      if (result.ok && result.bytes && result.model) {
        const png = await normalizeMinecraftSkin(result.bytes);
        setSkinFile(new File([png], `${skinNickname.trim()}.png`, { type: 'image/png' }));
        setSkinModel(result.model);
      }
    } catch { setSkinMessage('Не удалось получить скин. Попробуйте загрузить PNG.'); }
    finally { setBusy(false); }
  }
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
      setSkinMessage(lang === 'ru' ? 'Копия сохранена локально. В игру и другим игрокам она пока не передана.' : 'A local copy was saved. It has not been installed in the game or shared with other players.');
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
  function toggleSettings() {
    if (!settings) { setModMessage(''); void refreshModSwitches(); }
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
  async function vanillaAction() {
    if (!status?.vanillaReady) return;
    setBusy(true);
    setMessage(lang === 'ru' ? 'Запуск Minecraft…' : 'Launching Minecraft…');
    try {
      const result = await window.kayvel.playVanilla(lang);
      const current = await window.kayvel.status();
      setStatus(current);
      if (!result.ok || current.gameRunning) setMessage(result.message);
    } catch { setMessage('Не удалось запустить Minecraft.'); }
    finally { setBusy(false); }
  }
  async function neoAction() {
    if (!status?.neoforgeReady) return;
    setBusy(true);
    setMessage(lang === 'ru' ? 'Запуск NeoForge…' : 'Launching NeoForge…');
    try {
      const result = await window.kayvel.playNeoForge(lang);
      const current = await window.kayvel.status();
      setStatus(current);
      if (!result.ok || current.gameRunning) setMessage(result.message);
    } catch { setMessage('Не удалось запустить NeoForge.'); }
    finally { setBusy(false); }
  }
  async function install() {
    setBusy(true);
    setMessage('');
    try {
      const result = await window.kayvel.install();
      setMessage(result.message);
      setStatus(await window.kayvel.status());
    } catch { setMessage('Не удалось выполнить установку.'); }
    finally { setBusy(false); }
  }
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
      <div className="topline"><span className="edition">MINECRAFT 1.21.1 <span className="divider">/</span> NEOFORGE</span><nav className="top-tabs" aria-label={lang === 'ru' ? 'Разделы' : 'Sections'}><button className={skinOpen ? 'active' : ''} onClick={() => { setSkinOpen(true); setGameOpen(false); setNewsOpen(false); }}>{lang === 'ru' ? 'Скин' : 'Skin'}</button><button className={gameOpen ? 'active' : ''} onClick={() => { setGameOpen(true); setSkinOpen(false); setNewsOpen(false); }}>{lang === 'ru' ? 'Мини-игра' : 'Mini-game'}</button><button className={newsOpen ? 'active' : ''} onClick={() => { setNewsOpen(true); setSkinOpen(false); setGameOpen(false); setNewsError(false); void window.kayvel.news().then(setNewsItems).catch(() => { setNewsItems([]); setNewsError(true); }); }}>{t.news}</button></nav><button className="settings" onClick={toggleSettings} aria-label={t.settings} title={t.settings}>⚙</button></div>
      {settings ? <section className="settings-panel"><span className="eyebrow">KAYVEL / {t.settings.toUpperCase()}</span><h1>{t.settings}</h1><label htmlFor="language">{t.language}</label><select id="language" value={lang} onChange={event => setLang(event.target.value as 'ru' | 'en')}><option value="ru">Русский</option><option value="en">English</option></select><div className="path-block"><span className="eyebrow">{t.gameFolder}</span><code>{status?.gamePath ?? '…'}</code><p>{t.pathHint}</p><span className="eyebrow">{t.vanillaFolder}</span><code>{status?.vanillaPath ?? '…'}</code></div>
      <p>{t.localHint} {lang === 'ru' ? 'Для новой сборки нужен отдельный подписанный релиз без Core. Локальный ник не подтверждает личность.' : 'A new signed release without Core is required. A local name does not authenticate you.'}</p>
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
          <div className="profile-intro"><SkinHead file={skinHeadFile} label={lang === 'ru' ? 'Голова выбранного скина' : 'Selected skin head'} /><div><span className="eyebrow">{t.nickname}</span><strong>{savedNickname || (lang === 'ru' ? 'Укажите ник' : 'Choose a name')}</strong><small>{t.localHint}</small></div></div>
          <div className="local-test"><label htmlFor="nickname">{t.nickname}</label><input id="nickname" value={nickname} disabled={!profileReady || busy} maxLength={16} placeholder="Player_123" autoComplete="off" onChange={event => setNickname(event.target.value)} /><button disabled={!profileReady || busy || nickname === savedNickname || !/^[A-Za-z0-9_]{3,16}$/.test(nickname)} onClick={() => void saveNickname()}>{lang === 'ru' ? 'Сохранить ник' : 'Save name'}</button></div>
        </section>
        <div className="home-grid">
          <section className="identity-panel">
            <span className="eyebrow">MINECRAFT 1.21.1 / NEOFORGE</span>
            <div className="home-showcase"><div className="brand-display"><span className="brand-diamond">◆</span><h1>KAYVEL</h1></div><section className="home-skin" aria-label={lang === 'ru' ? 'Скин на главном экране' : 'Skin on home screen'}><div className="home-skin-heading"><span className="eyebrow">{lang === 'ru' ? 'ПРЕДПРОСМОТР СКИНА' : 'SKIN PREVIEW'}</span><button type="button" onClick={() => { setSkinOpen(true); setGameOpen(false); setNewsOpen(false); }}>{lang === 'ru' ? 'Выбрать скин' : 'Choose skin'}</button></div>{!skinOpen && <SkinPreview3D file={skinFile ?? skinHeadFile} model={skinModel} lang={lang} />}</section></div>
          </section>
        </div>
        <div className="launch-bar">
          <div className="launch-copy"><span className="eyebrow">{t.game}</span><strong>{status?.neoforgeReady ? t.neoReady : t.neoWaiting}</strong><small>{message || (status?.javaFound ? t.neoHint : t.noJava)}</small>{status && (!status.vanillaReady || !status.neoforgeReady) && <small>{t.preparationBlocked}</small>}</div>
          <div className="actions"><button className="play" disabled={!status?.vanillaReady || busy || status.preparingVanilla || status.preparingNeoForge || status.gameRunning || !profileReady || !savedNickname || nickname !== savedNickname} onClick={() => void vanillaAction()}>{status?.vanillaReady ? t.vanillaPlay : t.vanillaInstall}<span>→</span></button><button className="install" disabled={!status?.neoforgeReady || busy || status.preparingVanilla || status.preparingNeoForge || status.gameRunning || !profileReady || !savedNickname || nickname !== savedNickname} onClick={() => void neoAction()}>{status?.neoforgeReady ? t.neoPlay : t.neoInstall}</button><button className="install" disabled={!status?.releaseConfigured || busy} onClick={() => void install()}>{t.install}</button></div>
        </div>
      </section>}
      {newsOpen && !settings && <div className="game-overlay" onMouseDown={event => { if (event.target === event.currentTarget) setNewsOpen(false); }}><section className="news-dialog" role="dialog" aria-modal="true" aria-label={t.newsTitle}>
        <div className="game-dialog-head"><div><span className="eyebrow">KAYVEL / {t.news.toUpperCase()}</span><h2>{t.newsTitle}</h2></div><button className="game-close" aria-label={t.back} onClick={() => setNewsOpen(false)}>×</button></div>
        <div className="news-dialog-content">{newsError ? <p role="alert">{lang === 'ru' ? 'Не удалось прочитать news.json в папке данных лаунчера. Проверьте формат файла.' : 'Could not read news.json in the launcher data folder. Check the file format.'}</p> : newsItems.length ? <div className="news-list">{newsItems.map(item => <article className="news-item" key={item.id}><time dateTime={item.date}>{item.date}</time><h3>{item.title}</h3><p>{item.text}</p></article>)}</div> : <div className="news-empty"><div className="updates-empty-icon">✦</div><strong>{t.newsEmpty}</strong><p>{t.newsHint}</p></div>}<div className="updates-footer"><span className="status-dot" /> {lang === 'ru' ? 'Локальные новости · news.json в папке данных лаунчера' : 'Local news · news.json in the launcher data folder'}</div></div>
      </section></div>}
 {skinOpen && !settings && <div className="game-overlay" onMouseDown={event => { if (event.target === event.currentTarget) setSkinOpen(false); }}><section className="skin-dialog" role="dialog" aria-modal="true" aria-label={t.skinPreview}>
        <div className="game-dialog-head"><div><span className="eyebrow">KAYVEL / {lang === 'ru' ? 'СКИН' : 'SKIN'}</span><h2>{t.skinPreview}</h2></div><button className="game-close" aria-label={t.back} onClick={() => setSkinOpen(false)}>×</button></div>
        <div className="skin-dialog-body"><div className="skin-viewer"><SkinPreview3D file={skinFile ?? skinHeadFile} model={skinModel} lang={lang} /><span>{lang === 'ru' ? 'Перетащите мышью для вращения · колёсико для масштаба' : 'Drag to rotate · scroll to zoom'}</span></div>
          <div className="skin-panel skin-controls"><strong>{skinFile?.name || (localSkin ? `${savedNickname}.png · ${localSkin.model}` : t.skinPreviewHint)}</strong>
            <div className="skin-actions"><label className="skin-upload">{t.chooseSkin}<input type="file" accept="image/png" disabled={busy} onChange={event => { setSkinFile(event.currentTarget.files?.[0] ?? null); event.currentTarget.value = ''; setSkinMessage(''); }} /></label></div>
            <div className="skin-lookup"><input aria-label={lang === 'ru' ? 'Ник Minecraft для поиска скина' : 'Minecraft name for skin lookup'} placeholder={lang === 'ru' ? 'Ник Minecraft' : 'Minecraft name'} maxLength={16} disabled={busy} value={skinNickname} onChange={event => setSkinNickname(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !busy && /^[A-Za-z0-9_]{3,16}$/.test(skinNickname.trim())) void findSkinByNickname(); }} /><button disabled={busy || !/^[A-Za-z0-9_]{3,16}$/.test(skinNickname.trim())} onClick={() => void findSkinByNickname()}>{t.chooseNameMc}</button></div>
            <div className="skin-meta"><label htmlFor="skin-model">{lang === 'ru' ? 'Модель' : 'Model'}</label><select id="skin-model" disabled={busy} value={skinModel} onChange={event => setSkinModel(event.target.value as 'classic' | 'slim')}><option value="classic">Classic</option><option value="slim">Slim</option></select></div>
            <button className="skin-submit" disabled={!profileReady || busy || !savedNickname || nickname !== savedNickname || (!skinFile && (!localSkin || (skinModel === localSkin.model && localSkin.copyReady)))} onClick={() => void saveSkinLocally()}>{localSkin ? (lang === 'ru' ? 'Сохранить изменения' : 'Save changes') : (lang === 'ru' ? 'Сохранить скин' : 'Save skin')}</button>
            <p className="skin-note">{lang === 'ru' ? 'Сначала сохраните ник. Копия сохраняется только в лаунчере: в игру не установлена и другим игрокам не передаётся.' : 'Save your name first. The copy stays in the launcher: it is not installed in the game or shared with other players.'}</p>
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
    <footer><span className="status-dot"/><span>{lang === 'ru' ? 'Локальный профиль · скин в игре пока не подключён' : 'Local profile · in-game skins are not connected yet'}</span><span className="footer-version">{t.version}</span></footer>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);

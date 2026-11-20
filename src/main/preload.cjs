const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kayvel', {
  status: () => ipcRenderer.invoke('kayvel:status'),
  checkLauncherUpdates: () => ipcRenderer.invoke('kayvel:launcher-check'),
  updateLauncher: (language) => ipcRenderer.invoke('kayvel:launcher-update', language),
  checkModpackUpdates: () => ipcRenderer.invoke('kayvel:modpack-check'),
  updateModpack: () => ipcRenderer.invoke('kayvel:modpack-update'),
  openGuideLink: (link) => ipcRenderer.invoke('kayvel:open-guide-link', link),
  openGameFolder: (language) => ipcRenderer.invoke('kayvel:open-game-folder', language),
  memorySettings: () => ipcRenderer.invoke('kayvel:memory-settings'),
  saveMemoryMb: (memoryMb) => ipcRenderer.invoke('kayvel:memory-save', memoryMb),
  localProfile: () => ipcRenderer.invoke('kayvel:local-profile'),
  saveLocalNickname: (nickname) => ipcRenderer.invoke('kayvel:local-nickname-save', nickname),
  gameBest: () => ipcRenderer.invoke('kayvel:game-best'),
  saveGameBest: (score) => ipcRenderer.invoke('kayvel:game-best-save', score),
  modSwitches: () => ipcRenderer.invoke('kayvel:mod-switches'),
  setModEnabled: (id, enabled) => ipcRenderer.invoke('kayvel:mod-switch-set', id, enabled),
  install: () => ipcRenderer.invoke('kayvel:install'),
  installVanilla: () => ipcRenderer.invoke('kayvel:install-vanilla'),
  playVanilla: (language) => ipcRenderer.invoke('kayvel:play-vanilla', language),
  installNeoForge: () => ipcRenderer.invoke('kayvel:install-neoforge'),
  playNeoForge: (language) => ipcRenderer.invoke('kayvel:play-neoforge', language),
  cancelDownload: () => ipcRenderer.invoke('kayvel:cancel-download'),
  retryDownload: (language) => ipcRenderer.invoke('kayvel:retry-download', language),
  downloadAndPlay: (language) => ipcRenderer.invoke('kayvel:download-and-play', language),
  onPreparationProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('kayvel:preparation-progress', listener);
    return () => ipcRenderer.removeListener('kayvel:preparation-progress', listener);
  },
  onGameExit: (callback) => {
    const listener = (_event, exit) => callback(exit);
    ipcRenderer.on('kayvel:game-exit', listener);
    return () => ipcRenderer.removeListener('kayvel:game-exit', listener);
  },
  window: (action) => {
    if (['minimize', 'maximize', 'close'].includes(action)) ipcRenderer.send('kayvel:window', action);
  }
});

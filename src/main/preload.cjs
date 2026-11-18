const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kayvel', {
  status: () => ipcRenderer.invoke('kayvel:status'),
  checkModpackUpdates: () => ipcRenderer.invoke('kayvel:modpack-check'),
  updateModpack: () => ipcRenderer.invoke('kayvel:modpack-update'),
  openGameFolder: (language) => ipcRenderer.invoke('kayvel:open-game-folder', language),
  memorySettings: () => ipcRenderer.invoke('kayvel:memory-settings'),
  saveMemoryMb: (memoryMb) => ipcRenderer.invoke('kayvel:memory-save', memoryMb),
  localProfile: () => ipcRenderer.invoke('kayvel:local-profile'),
  saveLocalNickname: (nickname) => ipcRenderer.invoke('kayvel:local-nickname-save', nickname),
  saveLocalSkin: (bytes, model) => ipcRenderer.invoke('kayvel:local-skin-save', bytes, model),
  gameBest: () => ipcRenderer.invoke('kayvel:game-best'),
  saveGameBest: (score) => ipcRenderer.invoke('kayvel:game-best-save', score),
  modSwitches: () => ipcRenderer.invoke('kayvel:mod-switches'),
  setModEnabled: (id, enabled) => ipcRenderer.invoke('kayvel:mod-switch-set', id, enabled),
  install: () => ipcRenderer.invoke('kayvel:install'),
  installVanilla: () => ipcRenderer.invoke('kayvel:install-vanilla'),
  playVanilla: (language) => ipcRenderer.invoke('kayvel:play-vanilla', language),
  installNeoForge: () => ipcRenderer.invoke('kayvel:install-neoforge'),
  playNeoForge: (language) => ipcRenderer.invoke('kayvel:play-neoforge', language),
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

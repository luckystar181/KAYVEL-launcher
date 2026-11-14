const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kayvel', {
  status: () => ipcRenderer.invoke('kayvel:status'),
  localProfile: () => ipcRenderer.invoke('kayvel:local-profile'),
  saveLocalNickname: (nickname) => ipcRenderer.invoke('kayvel:local-nickname-save', nickname),
  saveLocalSkin: (bytes, model) => ipcRenderer.invoke('kayvel:local-skin-save', bytes, model),
  news: () => ipcRenderer.invoke('kayvel:news'),
  gameBest: () => ipcRenderer.invoke('kayvel:game-best'),
  saveGameBest: (score) => ipcRenderer.invoke('kayvel:game-best-save', score),
  skinByNickname: (nickname) => ipcRenderer.invoke('kayvel:skin-by-nickname', nickname),
  modSwitches: () => ipcRenderer.invoke('kayvel:mod-switches'),
  setModEnabled: (id, enabled) => ipcRenderer.invoke('kayvel:mod-switch-set', id, enabled),
  install: () => ipcRenderer.invoke('kayvel:install'),
  installVanilla: () => ipcRenderer.invoke('kayvel:install-vanilla'),
  playVanilla: (language) => ipcRenderer.invoke('kayvel:play-vanilla', language),
  installNeoForge: () => ipcRenderer.invoke('kayvel:install-neoforge'),
  playNeoForge: (language) => ipcRenderer.invoke('kayvel:play-neoforge', language),
  onGameExit: (callback) => {
    const listener = (_event, exit) => callback(exit);
    ipcRenderer.on('kayvel:game-exit', listener);
    return () => ipcRenderer.removeListener('kayvel:game-exit', listener);
  },
  window: (action) => {
    if (['minimize', 'maximize', 'close'].includes(action)) ipcRenderer.send('kayvel:window', action);
  }
});

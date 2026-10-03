const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  pingServers: () => ipcRenderer.invoke('servers:ping'),
  loginDiscord: () => ipcRenderer.invoke('auth:discord'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  cancelLogin: () => ipcRenderer.invoke('auth:cancel'),
  setUsername: (name) => ipcRenderer.invoke('profile:set-username', name),
  play: (serverId) => ipcRenderer.invoke('game:play', serverId),
  openInvite: () => ipcRenderer.invoke('app:open-invite'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (partial) => ipcRenderer.invoke('settings:save', partial),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  pickJava: () => ipcRenderer.invoke('settings:pick-java'),
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, data) => cb(data)),
  onLog: (cb) => ipcRenderer.on('log', (_e, line) => cb(line)),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: (cb) => ipcRenderer.on('update-state', (_e, data) => cb(data)),
  onPlayState: (cb) => ipcRenderer.on('play-state', (_e, data) => cb(data))
});

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('get-state'),
  lanStatus: () => ipcRenderer.invoke('lan-status'),
  setPhoneLan: (enabled) => ipcRenderer.invoke('set-phone-lan', enabled),
  saveConfig: (partial) => ipcRenderer.invoke('save-config', partial),
  hubStart: () => ipcRenderer.invoke('hub-start'),
  hubStop: () => ipcRenderer.invoke('hub-stop'),
  hubRestart: (fileBase) => ipcRenderer.invoke('hub-restart', fileBase),
  playReplay: (base) => ipcRenderer.invoke('play-replay', base),
  deleteReplay: (base) => ipcRenderer.invoke('delete-replay', base),
  playState: () => ipcRenderer.invoke('play-state'),
  refreshReplays: () => ipcRenderer.invoke('refresh-replays'),
  openPath: (which) => ipcRenderer.invoke('open-path', which),
  saveUiPrefs: (partial) => ipcRenderer.invoke('save-ui-prefs', partial),
  onLog: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('hub:log', handler)
    return () => ipcRenderer.removeListener('hub:log', handler)
  },
  onStatus: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('hub:status', handler)
    return () => ipcRenderer.removeListener('hub:status', handler)
  },
  onPlay: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('hub:play', handler)
    return () => ipcRenderer.removeListener('hub:play', handler)
  }
})

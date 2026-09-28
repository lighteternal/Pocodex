const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pocodex', {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  command: (action, args = {}) => ipcRenderer.invoke('command', action, args),
  showHome: () => ipcRenderer.invoke('show-home'),
  hideHome: () => ipcRenderer.invoke('hide-home'),
  showUpdates: () => ipcRenderer.invoke('show-updates'),
  hideUpdates: () => ipcRenderer.invoke('hide-updates'),
  quit: () => ipcRenderer.invoke('quit-app'),
  startup: enabled => ipcRenderer.invoke('startup', enabled),
  addSource: () => ipcRenderer.invoke('add-source'),
  exportSave: () => ipcRenderer.invoke('export-save'),
  cardImage: (rect, kind) => ipcRenderer.invoke('card-image', rect, kind),
  hitRegion: hit => ipcRenderer.send('hit-region', hit),
  moveBuddy: delta => ipcRenderer.send('move-buddy', delta),
  onState: callback => { const listener = (_event, message) => callback(message); ipcRenderer.on('state', listener); return () => ipcRenderer.removeListener('state', listener); },
  onFault: callback => { const listener = (_event, message) => callback(message); ipcRenderer.on('fault', listener); return () => ipcRenderer.removeListener('fault', listener); },
  onNavigate: callback => { const listener = (_event, page) => callback(page); ipcRenderer.on('navigate', listener); return () => ipcRenderer.removeListener('navigate', listener); },
});

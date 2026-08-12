const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('twedelUpdates', {
  getState: () => ipcRenderer.invoke('update:get-state'),
  check: () => ipcRenderer.invoke('update:check'),
  download: () => ipcRenderer.invoke('update:download'),
  install: () => ipcRenderer.invoke('update:install'),
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('update:state', handler);
    return () => ipcRenderer.removeListener('update:state', handler);
  },
});

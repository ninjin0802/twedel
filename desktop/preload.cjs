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
contextBridge.exposeInMainWorld('twedelExternal', {
  openSupportPage: () => ipcRenderer.invoke('external:open-support'),
  openDeveloperProfile: () => ipcRenderer.invoke('external:open-developer-profile'),
});
contextBridge.exposeInMainWorld('twedelCredentials', {
  set: (input) => ipcRenderer.invoke('credentials:set', input),
});
contextBridge.exposeInMainWorld('twedelApi', {
  request: (path, init) => ipcRenderer.invoke('api:request', { path, init }),
  subscribe: (path, listener) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const channel = `api:event:${id}`;
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, handler);
    void ipcRenderer.invoke('api:subscribe', { id, path });
    return () => {
      ipcRenderer.removeListener(channel, handler);
      void ipcRenderer.invoke('api:unsubscribe', id);
    };
  },
});

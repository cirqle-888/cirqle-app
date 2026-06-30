'use strict'

/**
 * Preload shared by the chrome views (toolbar, splitter, drag overlay).
 * Exposes a minimal, explicit IPC surface as `window.desk`.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desk', {
  preset: (p) => ipcRenderer.send('layout:preset', p),
  reload: (which) => ipcRenderer.send('reload', which),
  goBack: () => ipcRenderer.send('goBack'),
  goForward: () => ipcRenderer.send('goForward'),
  waAdd: () => ipcRenderer.send('wa:add'),
  waSwitch: (id) => ipcRenderer.send('wa:switch', id),
  capture: () => ipcRenderer.send('capture:clipboard'),
  retry: (pane) => ipcRenderer.send('retry', pane),
  splitterStart: () => ipcRenderer.send('splitter:start'),
  splitterDrag: (screenX) => ipcRenderer.send('splitter:drag', screenX),
  splitterEnd: () => ipcRenderer.send('splitter:end'),
  version: () => ipcRenderer.invoke('app:version'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
})

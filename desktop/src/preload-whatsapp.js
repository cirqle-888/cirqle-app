'use strict'
const { contextBridge, ipcRenderer } = require('electron')
// Only the bundled error page needs a retry control.
if (location.protocol === 'file:') contextBridge.exposeInMainWorld('desk', { retry: (pane) => ipcRenderer.send('retry', pane) })

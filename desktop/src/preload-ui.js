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
  toggleFullscreen: () => ipcRenderer.send('toggleFullscreen'),
  waAdd: () => ipcRenderer.send('wa:add'),
  waSwitch: (id) => ipcRenderer.send('wa:switch', id),
  waRemove: (id) => ipcRenderer.send('wa:remove', id),
  waRename: (id, label) => ipcRenderer.send('wa:rename', { id, label }),
  capture: () => ipcRenderer.send('capture:clipboard'),
  retry: (pane) => ipcRenderer.send('retry', pane),
  splitterStart: () => ipcRenderer.send('splitter:start'),
  splitterDrag: (screenX) => ipcRenderer.send('splitter:drag', screenX),
  splitterEnd: () => ipcRenderer.send('splitter:end'),
  version: () => ipcRenderer.invoke('app:version'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onDownloads: (cb) => ipcRenderer.on('downloads', (_e, d) => cb(d)),

  // Notification badge in the toolbar (relayed from the Cirqle web view).
  onNotifBadge: (cb) => ipcRenderer.on('notif-badge', (_e, n) => cb(n)),
  openNotifications: () => ipcRenderer.send('cirqle:openNotifications'),

  // Downloads panel (Chrome/Safari-style shelf)
  toggleDownloads: () => ipcRenderer.send('downloads:toggle'),
  closeDownloads: () => ipcRenderer.send('downloads:close'),
  dlOpen: (id) => ipcRenderer.send('downloads:open', id),
  dlReveal: (id) => ipcRenderer.send('downloads:reveal', id),
  dlRemove: (id) => ipcRenderer.send('downloads:remove', id),
  dlClear: () => ipcRenderer.send('downloads:clear'),
  dlOpenFolder: () => ipcRenderer.send('downloads:openFolder'),
  dlCopy: (id) => ipcRenderer.send('downloads:copy', id),
  dlShareWA: (id) => ipcRenderer.send('downloads:shareWA', id),
  dlQuickLook: (id) => ipcRenderer.send('downloads:quicklook', id),
  dlStartDrag: (id) => ipcRenderer.send('downloads:startDrag', id),
  onDownloadsList: (cb) => ipcRenderer.on('downloads:list', (_e, list) => cb(list)),

  // Duplicate / compare a 2nd Cirqle page side-by-side
  cirqleCompareToggle: () => ipcRenderer.send('cirqle:compareToggle'),

  // Download flying-to-shelf animation
  reportDownloadBtn: (rect) => ipcRenderer.send('fx:report-btn', rect),
  onFxFly: (cb) => ipcRenderer.on('fx:fly', (_e, d) => cb(d)),
  fxDone: () => ipcRenderer.send('fx:done'),
  onDownloadsPulse: (cb) => ipcRenderer.on('downloads:pulse', () => cb()),
})

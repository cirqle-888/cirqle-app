'use strict'

/**
 * Preload attached to the Cirqle web view. Exposes a desktop marker and relays
 * captured content from the main process into the page as a `cirqle:capture`
 * window event — which the Quick Capture screen listens for
 * (src/app/(dashboard)/dashboard/capture/capture-client.tsx).
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__CIRQLE_DESKTOP__', {
  version: 1,
  retry: (pane) => ipcRenderer.send('retry', pane),
})

ipcRenderer.on('cirqle:capture', (_e, payload) => {
  try {
    window.dispatchEvent(new CustomEvent('cirqle:capture', { detail: payload }))
  } catch { /* page not ready */ }
})

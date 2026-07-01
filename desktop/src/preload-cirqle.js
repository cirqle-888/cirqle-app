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
  updateLogo: (url) => ipcRenderer.send('cirqle:logo', url),

  /**
   * Share a canvas-rendered image (e.g. a payment receipt PNG data URL) to the
   * linked WhatsApp pane. `action` is one of:
   *   'copy'     — copy image to clipboard + focus WhatsApp (paste with ⌘V)   [default]
   *   'paste'    — additionally auto-paste into the currently-open chat
   *   'download' — save into the common Downloads + reveal in Finder to drag in
   * Resolves to { ok, action, ... }.
   */
  shareReceipt: (dataUrl, filename, action = 'copy') =>
    ipcRenderer.invoke('share:receipt', { dataUrl, filename, action }),
})

ipcRenderer.on('cirqle:capture', (_e, payload) => {
  try {
    window.dispatchEvent(new CustomEvent('cirqle:capture', { detail: payload }))
  } catch { /* page not ready */ }
})

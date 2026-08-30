'use strict'

/**
 * Preload attached to the Cirqle web view. Exposes a desktop marker and relays
 * captured content from the main process into the page as a `cirqle:capture`
 * window event — which the Quick Capture screen listens for
 * (src/app/(dashboard)/dashboard/capture/capture-client.tsx).
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__CIRQLE_DESKTOP__', {
  version: 4,
  retry: (pane) => ipcRenderer.send('retry', pane),
  updateLogo: (url) => ipcRenderer.send('cirqle:logo', url),

  /**
   * Write text to the OS clipboard from the main process. The page's own
   * navigator.clipboard rejects whenever this view isn't the focused document,
   * which is most of the time in a multi-pane shell — src/lib/clipboard.ts
   * tries this first and falls back to the web APIs outside the desktop.
   */
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),

  /**
   * Fire a native OS notification (system tone + high-priority dock bounce),
   * handled in the main process. Called by the web app's DesktopNotifier for
   * new chat messages and bell notifications. Payload:
   * `{ title, body, tag?, url? }` where url is an in-app path the click
   * handler navigates the Cirqle pane to.
   */
  notify: (payload) => ipcRenderer.send('cirqle:notify', payload),

  /**
   * Report the current unread count (chat + notifications) so the desktop
   * shell can show a top-bar bell badge + a dock badge. Called by the web
   * app's FloatingCommsWidget whenever the total changes.
   */
  setBadge: (count) => ipcRenderer.send('cirqle:badge', count),

  /**
   * Share a canvas-rendered image (e.g. a payment receipt PNG data URL) to the
   * linked WhatsApp pane. `action` is one of:
   *   'copy'     — copy image to clipboard + focus WhatsApp (paste with ⌘V)   [default]
   *   'paste'    — additionally auto-paste into the currently-open chat
   *   'download' — save into the common Downloads + reveal in Finder to drag in
   * `caption`, if given, is best-effort typed into WhatsApp's image-caption box
   * after the auto-paste (only applies to the 'paste' action — 'copy'/'download'
   * don't touch the composer, so there's no caption box to type into yet).
   * Resolves to { ok, action, ... }.
   */
  shareReceipt: (dataUrl, filename, action = 'copy', caption) =>
    ipcRenderer.invoke('share:receipt', { dataUrl, filename, action, caption }),

  /**
   * Whether the PERSON is at the machine (v4+). Resolves to
   * `{ idleSeconds, locked }` straight from the OS.
   *
   * The web app's presence feature calls this once a minute instead of reading
   * page visibility, because a desktop window is hidden most of the time while
   * its owner is right in front of it — see src/main/presence.js and
   * src/lib/presence/activity.ts. Older shells lack this, and the web app
   * falls back to the browser rule.
   */
  presence: {
    query: () => ipcRenderer.invoke('presence:query'),
  },
})

ipcRenderer.on('cirqle:capture', (_e, payload) => {
  try {
    window.__pendingCirqleCapture = payload
    window.dispatchEvent(new CustomEvent('cirqle:capture', { detail: payload }))
  } catch { /* page not ready */ }
})

// Toolbar bell click, relayed to whatever page is currently loaded — the
// FloatingCommsWidget (mounted globally in the dashboard layout) listens for
// this and pops its Alerts tab open.
ipcRenderer.on('cirqle:openNotifications', () => {
  try {
    window.dispatchEvent(new CustomEvent('cirqle:openNotifications'))
  } catch { /* page not ready */ }
})

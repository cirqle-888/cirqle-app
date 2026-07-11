'use strict'

/**
 * Native notifications domain: high-priority OS notifications relayed from
 * the Cirqle web view (system tone + critical dock bounce), the unread-count
 * badge relay (toolbar bell + dock/app badge), and the toolbar bell click.
 *
 * Pure extraction from main.js — behavior and channels unchanged. register()
 * installs the same three ipcMain handlers main.js used to own.
 */
const { app, ipcMain, Notification } = require('electron')

const CH = require('../shared/ipc-channels')

const deps = {
  getWin: () => null,
  getChrome: () => null,
  getCirqle: () => null,
  ensureCirqleVisible: () => {},
  cirqleUrl: '',
}
function init(d) { Object.assign(deps, d) }

function register() {
// ── Native notifications (from the Cirqle web view's DesktopNotifier) ─────────
// High-priority OS notification with the system notification tone + a critical
// dock bounce, fired regardless of which pane is focused (a chat message that
// arrives while the user is in the WhatsApp pane still alerts them). Clicking
// focuses the window, reveals the Cirqle pane, and navigates to the source.
let lastNotifyAt = 0
ipcMain.on(CH.CIRQLE_NOTIFY, (_e, payload) => {
  try {
    if (!Notification.isSupported()) return
    const now = Date.now()
    // Light rate-limit so a burst (e.g. backfill) can't spam the OS.
    if (now - lastNotifyAt < 400) return
    lastNotifyAt = now

    const title = String(payload?.title || 'Cirqle').slice(0, 120)
    const body = String(payload?.body || '').slice(0, 240)
    const url = typeof payload?.url === 'string' ? payload.url : null

    const n = new Notification({
      title,
      body,
      silent: false,          // play the system notification tone
      timeoutType: 'default',
      tag: payload?.tag ? String(payload.tag) : undefined,
    })
    n.on('click', () => {
      const w = deps.getWin()
      if (w) {
        if (w.isMinimized && w.isMinimized()) w.restore?.()
        w.show?.()
        w.focus?.()
      }
      if (deps.getCirqle()) {
        deps.ensureCirqleVisible()
        if (url) { try { deps.getCirqle().webContents.loadURL(deps.cirqleUrl + url) } catch { /* bad url — ignore */ } }
        deps.getCirqle().webContents.focus()
      }
    })
    n.show()

    // High priority: bounce the dock until the app is focused (macOS), and
    // flash the taskbar on Windows/Linux.
    if (process.platform === 'darwin' && app.dock) app.dock.bounce('critical')
    else { const wf = deps.getWin(); if (wf && wf.flashFrame) wf.flashFrame(true) }
  } catch (err) {
    console.error('[notify] failed:', err)
  }
})

// ── Unread badge relay (Cirqle web view → toolbar bell + dock) ────────────────
ipcMain.on(CH.CIRQLE_BADGE, (_e, count) => {
  const n = Math.max(0, parseInt(count, 10) || 0)
  const ch = deps.getChrome(); if (ch) ch.webContents.send(CH.NOTIF_BADGE, n)
  try {
    // macOS: numeric dock badge. Others: taskbar overlay isn't per-count, so
    // just use the app badge count where supported.
    if (process.platform === 'darwin' && app.dock) app.dock.setBadge(n > 0 ? String(n) : '')
    if (typeof app.setBadgeCount === 'function') app.setBadgeCount(n)
  } catch { /* badge unsupported on this platform */ }
})

// Toolbar bell click → reveal + focus the Cirqle pane and tell the currently
// loaded page to pop open its notifications panel (FloatingCommsWidget,
// mounted globally) — NOT a navigation. The old behavior forced a jump to
// /dashboard/chat, which lands on the full chat page rather than showing
// notifications at all.
ipcMain.on(CH.CIRQLE_OPEN_NOTIFICATIONS, () => {
  deps.ensureCirqleVisible()
  if (deps.getCirqle()) {
    deps.getCirqle().webContents.send(CH.CIRQLE_OPEN_NOTIFICATIONS)
    deps.getCirqle().webContents.focus()
  }
})
}

module.exports = { init, register }

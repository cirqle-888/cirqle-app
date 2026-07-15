'use strict'

/**
 * Cirqle Desktop — main process.
 *
 * One window, two side-by-side web views: Cirqle on the left, WhatsApp Web on
 * the right. Electron loads web.whatsapp.com as a top-level page (not an
 * iframe), so X-Frame-Options doesn't apply — the proven Rambox/Ferdi pattern.
 *
 * Workflow is fully manual: you copy in the WhatsApp pane and paste into
 * Cirqle. The "New request from clipboard" action (toolbar / ⌘⇧N), the native
 * Capture menu's clipboard history, and the New-record shortcuts all drive
 * Cirqle's Quick Capture via the `cirqle:capture` window event (preload-cirqle).
 */

const { app, BaseWindow, WebContentsView, ipcMain, globalShortcut, clipboard, shell, Menu, nativeImage, screen, Notification } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

const CH = require('./shared/ipc-channels')
const { state, saveSettings } = require('./main/settings')
const dl = require('./main/downloads')
const wa = require('./main/whatsapp')
const layoutMod = require('./main/layout')
const menus = require('./main/menus')
const notifications = require('./main/notifications')
const updates = require('./main/updates')
const tray = require('./main/tray')
const deeplinks = require('./main/deeplinks')
const { buildMenu, wireContextMenu, truncate, FILE_URL_RE } = menus

menus.init({
  getWin: () => win,
  reloadCirqle: () => { if (cirqle) cirqle.webContents.loadURL(CIRQLE_URL) },
  sendTextToCirqle: (t) => sendTextToCirqle(t),
  sendClipboardToCirqle: () => sendClipboardToCirqle(),
  navigate: (r) => navigate(r),
  getClipHistory: () => clipHistory,
})
const { layout, applyPreset, TOOLBAR_H, SPLITTER_W, MIN_RATIO, MAX_RATIO } = layoutMod

layoutMod.init({
  getWin: () => win,
  getChrome: () => chrome,
  getCirqle: () => cirqle,
  getCirqle2: () => cirqle2,
  getSplitter: () => splitter,
  getOverlay: () => overlay,
})
const { whatsapps, WHATSAPP_URL, CHROME_UA, focusWhatsapp, pasteIntoWhatsappComposer, shareImageToWhatsApp, shareFileToWhatsApp, dropFileIntoWhatsApp, createWhatsappView } = wa

wa.init({
  getWin: () => win,
  sendStateToChrome: () => { if (chrome) chrome.webContents.send(CH.STATE, state) },
  applyPreset: (p) => applyPreset(p),
  layout: () => layout(),
  wireContextMenu: (v, c) => wireContextMenu(v, c),
  loadError: (v, u, p) => loadError(v, u, p),
})

dl.init({
  getWin: () => win,
  getChrome: () => chrome,
  buildMenu: () => buildMenu(),
  shareFileToWhatsApp: (p, o) => shareFileToWhatsApp(p, o),
  closeOtherPopups: () => closeOtherPopups(),
  truncate: (x, n) => truncate(x, n),
})

const CIRQLE_URL = (process.env.CIRQLE_URL || 'https://app.cirqle.work').replace(/\/$/, '')
let win, chrome, cirqle, cirqle2, splitter, overlay

const DL_PANEL_W = 380
const DL_PANEL_H = 460

// Recent clipboard items (newest first), surfaced in the Capture menu.
const clipHistory = []
let lastClip = ''

// New-window (target=_blank / window.open) links from the Cirqle pane: if they
// point at a file (report / invoice PDF, Excel, CSV, image) download it into the
// Cirqle folder so it lands in the tray; otherwise open in the system browser.
function makeWindowOpenHandler(getView) {
  return ({ url }) => {
    if (FILE_URL_RE.test(url) || url.includes('/storage/v1/object/')) {
      try { getView().webContents.downloadURL(url); return { action: 'deny' } } catch { /* fall through to browser */ }
    }
    shell.openExternal(url)
    return { action: 'deny' }
  }
}

function dataUrlToImage(dataUrl) {
  try { return nativeImage.createFromDataURL(dataUrl) } catch { return null }
}
// Dismiss any other transient floating layer so only one is ever open.
function closeOtherPopups() {
  if (overlay) { win.contentView.removeChildView(overlay); overlay = null }
}

function createCirqle2() {
  if (cirqle2) return
  cirqle2 = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload-cirqle.js') } })
  cirqle2.webContents.loadURL(cirqle.webContents.getURL() || CIRQLE_URL)
  dl.wireDownloads(cirqle2.webContents.session, 'cirqle')
  wireContextMenu(cirqle2, true)
  dl.wireEscToCloseDownloads(cirqle2)
  cirqle2.webContents.setWindowOpenHandler(makeWindowOpenHandler(() => cirqle2))
  cirqle2.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) loadError(cirqle2, CIRQLE_URL, 'cirqle')
  })
  win.contentView.addChildView(cirqle2)
  // Keep splitter + toolbar (and any floating panel) above the new pane.
  win.contentView.removeChildView(splitter); win.contentView.addChildView(splitter)
  win.contentView.removeChildView(chrome); win.contentView.addChildView(chrome)
  dl.raiseDownloadsPanel()
}

// ── Drive Cirqle's Quick Capture ──────────────────────────────────────────────
function ensureCirqleVisible() {
  if (!state.showCirqle) applyPreset(state.showWhatsapp ? '50' : 'hideWA')
}

function sendTextToCirqle(text) {
  ensureCirqleVisible()
  const target = CIRQLE_URL + '/dashboard/capture'
  const send = () => {
    if (text && text.trim()) {
      cirqle.webContents.send(CH.CIRQLE_CAPTURE, { text })
    }
  }
  if (!(cirqle.webContents.getURL() || '').includes('/dashboard/capture')) {
    cirqle.webContents.loadURL(target)
    cirqle.webContents.once('did-finish-load', () => setTimeout(send, 400)) // let React mount the listener
  } else {
    send()
  }
  cirqle.webContents.focus()
}
const sendClipboardToCirqle = () => sendTextToCirqle(clipboard.readText())

function navigate(route) {
  ensureCirqleVisible()
  cirqle.webContents.loadURL(CIRQLE_URL + route)
  cirqle.webContents.focus()
}

// ── Failed loads → a friendly fallback page with Retry ────────────────────────
function loadError(view, url, pane) {
  view.webContents.loadFile(path.join(__dirname, 'error.html'), { query: { url, pane } })
}

function createViews() {
  // Always start on WhatsApp in the right pane — the 2nd Cirqle is created
  // on demand and not restored across restarts.
  state.rightPane = 'whatsapp'

  chrome = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload-ui.js') } })
  chrome.webContents.loadFile(path.join(__dirname, 'host.html'))
  chrome.webContents.once('did-finish-load', () => chrome.webContents.send(CH.STATE, state))

  dl.wireEscToCloseDownloads(chrome) // Esc from the toolbar view closes the panel too

  cirqle = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload-cirqle.js') } })
  cirqle.webContents.loadURL(CIRQLE_URL)
  dl.wireDownloads(cirqle.webContents.session, 'cirqle') // capture report / invoice / receipt downloads
  wireContextMenu(cirqle, true)                       // Chrome-style right-click menu
  dl.wireEscToCloseDownloads(cirqle)                     // Esc closes the downloads panel
  cirqle.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) loadError(cirqle, CIRQLE_URL, 'cirqle')
  })

  // Ensure activeWa is valid
  if (!state.waAccounts.find(a => a.id === state.activeWa)) {
    if (state.waAccounts.length > 0) state.activeWa = state.waAccounts[0].id
  }

  state.waAccounts.forEach(account => {
    createWhatsappView(account.id)
  })

  splitter = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload-ui.js') } })
  splitter.webContents.loadFile(path.join(__dirname, 'splitter.html'))

  // Cirqle pane downloads report/invoice file links into the tray; WhatsApp
  // links keep opening in the system browser.
  cirqle.webContents.setWindowOpenHandler(makeWindowOpenHandler(() => cirqle))
  for (const v of Object.values(whatsapps)) {
    v.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  }

  win.contentView.addChildView(cirqle)
  Object.values(whatsapps).forEach(waView => win.contentView.addChildView(waView))
  win.contentView.addChildView(splitter)
  win.contentView.addChildView(chrome) // toolbar on top
}

function pollClipboard() {
  try {
    const t = clipboard.readText()
    if (t && t.trim() && t !== lastClip) {
      lastClip = t
      clipHistory.unshift(t)
      if (clipHistory.length > 20) clipHistory.pop()
      buildMenu() // refresh the Recent Clipboard submenu
    }
  } catch { /* ignore */ }
}

notifications.init({
  getWin: () => win,
  getChrome: () => chrome,
  getCirqle: () => cirqle,
  ensureCirqleVisible: () => ensureCirqleVisible(),
  cirqleUrl: CIRQLE_URL,
})
notifications.register()


// ── IPC from the toolbar / splitter / overlay / error page ────────────────────
ipcMain.on(CH.LAYOUT_PRESET, (_e, p) => applyPreset(p))
ipcMain.on(CH.RELOAD, (_e, which) => {
  if (which === 'cirqle' && cirqle) cirqle.webContents.loadURL(CIRQLE_URL)
  if (which === 'whatsapp') {
    // The right-pane reload button reloads whatever occupies the right slot.
    if (state.rightPane === 'cirqle2' && cirqle2) cirqle2.webContents.reload()
    else if (whatsapps[state.activeWa]) whatsapps[state.activeWa].webContents.reload()
  }
})
ipcMain.on(CH.GO_BACK, () => { if (cirqle && cirqle.webContents.canGoBack()) cirqle.webContents.goBack() })
ipcMain.on(CH.GO_FORWARD, () => { if (cirqle && cirqle.webContents.canGoForward()) cirqle.webContents.goForward() })
ipcMain.on(CH.TOGGLE_FULLSCREEN, () => { if (win) win.setFullScreen(!win.isFullScreen()) })
// ── Downloads panel ───────────────────────────────────────────────────────────
ipcMain.on(CH.DOWNLOADS_TOGGLE, dl.toggleDownloadsPanel)
ipcMain.on(CH.DOWNLOADS_CLOSE, dl.closeDownloadsPanel)
ipcMain.on(CH.DOWNLOADS_OPEN, (_e, id) => { const d = dl.findDownload(id); if (d) shell.openPath(d.path) })
ipcMain.on(CH.DOWNLOADS_REVEAL, (_e, id) => { const d = dl.findDownload(id); if (d) shell.showItemInFolder(d.path) })
ipcMain.on(CH.DOWNLOADS_REMOVE, (_e, id) => dl.removeDownload(id))
ipcMain.on(CH.DOWNLOADS_CLEAR, dl.clearDownloads)
ipcMain.on(CH.DOWNLOADS_OPEN_FOLDER, () => shell.openPath(dl.downloadsDir()))
ipcMain.on(CH.DOWNLOADS_COPY, (_e, id) => {
  const d = dl.findDownload(id)
  if (!d) return
  if (dl.isImageFile(d.path)) { const img = nativeImage.createFromPath(d.path); if (!img.isEmpty()) clipboard.writeImage(img); else clipboard.writeText(d.path) }
  else clipboard.writeText(d.path)
})
ipcMain.on(CH.DOWNLOADS_SHARE_WA, (_e, id) => { const d = dl.findDownload(id); if (d) shareFileToWhatsApp(d.path) })
ipcMain.on(CH.DOWNLOADS_QUICKLOOK, (_e, id) => { const d = dl.findDownload(id); if (d && fs.existsSync(d.path)) dl.quickLookFile(d.path) })
// Native OS file drag from a shelf item → drop onto WhatsApp, Finder, anywhere.
ipcMain.on(CH.DOWNLOADS_START_DRAG, async (e, id) => {
  const d = dl.findDownload(id)
  if (!d) { console.warn('[drag] startDrag: no download record for id', id); return }
  if (!fs.existsSync(d.path)) { console.warn('[drag] startDrag: file no longer exists at', d.path); return }
  // dlCatcher is a full-window transparent scrim that sits ABOVE the WhatsApp/
  // Cirqle views (so a click anywhere outside the panel dismisses it). During a
  // native OS drag, macOS hit-tests by z-order — the drop was landing on that
  // invisible catcher instead of passing through to WhatsApp, so the file
  // silently vanished. Hide it for the (synchronous, blocking) duration of the
  // drag so the view underneath can actually receive the drop.
  // dlCatcher is a full-window transparent scrim ABOVE the panes; while it's
  // visible, a native drop over the WhatsApp pane lands on IT (no drop
  // handler) and silently vanishes. startDrag() returns IMMEDIATELY on this
  // Electron version (verified: cursor still at the drag origin when it
  // returns), so a finally{ show() } re-covers the panes mid-drag and defeats
  // the fix. Instead: hide the catcher now and re-show it once the drag is
  // over — detected by polling the cursor from the drag origin (see below).
  dl.setCatcherVisible(false)
  try {
    e.sender.startDrag({ file: d.path, icon: await dl.dragIconFor(d.path) })
    console.log('[drag] startDrag issued for', d.name)
  } catch (err) {
    console.error('[drag] startDrag failed with resolved icon, retrying with fallback icon:', err)
    try {
      e.sender.startDrag({ file: d.path, icon: FALLBACK_DRAG_ICON })
    } catch (err2) {
      console.error('[drag] startDrag failed even with fallback icon — giving up:', err2)
      dl.setCatcherVisible(true)
      return
    }
  }

  // Watch the drag from main: sample the cursor until it stops moving for a
  // moment away from the origin (= the user dropped), then re-arm the catcher.
  // If the drop point is inside the active WhatsApp pane, also complete the
  // drop synthetically — Chromium won't deliver an own-app drag to an own-app
  // WebContentsView, so without this the release does nothing.
  const cb0 = win.getContentBounds()
  const start = screen.getCursorScreenPoint()
  let last = { x: start.x, y: start.y }
  let stillFor = 0
  let ticks = 0
  const timer = setInterval(async () => {
    ticks++
    const pt = screen.getCursorScreenPoint()
    const moved = Math.abs(pt.x - last.x) > 2 || Math.abs(pt.y - last.y) > 2
    const awayFromStart = Math.abs(pt.x - start.x) > 40 || Math.abs(pt.y - start.y) > 40
    last = { x: pt.x, y: pt.y }
    if (moved || !awayFromStart) { stillFor = 0 } else { stillFor++ }
    // 3 quiet samples (~450ms) away from the origin ≈ the drop happened.
    // 20s cap: give up and just restore the catcher.
    if (stillFor >= 3 || ticks > 130) {
      clearInterval(timer)
      dl.setCatcherVisible(true)
      if (ticks > 130) return
      try {
        const wa = whatsapps[state.activeWa]
        if (!wa || state.rightPane === 'cirqle2' || !state.showWhatsapp) return
        const x = pt.x - cb0.x, y = pt.y - cb0.y
        const wb = wa.getBounds()
        const pb = dl.getPanelBounds()
        const inWa = x >= wb.x && x <= wb.x + wb.width && y >= wb.y && y <= wb.y + wb.height
        const inPanel = pb && x >= pb.x && x <= pb.x + pb.width && y >= pb.y && y <= pb.y + pb.height
        console.log('[drag] drop-end hit test:', JSON.stringify({ cursor: { x, y }, waBounds: wb, inWa, inPanel }))
        if (inWa && !inPanel) {
          const r = await dropFileIntoWhatsApp(wa, d.path)
          console.log('[drag] synthetic drop result:', JSON.stringify(r))
          if (r.ok) dl.closeDownloadsPanel() // get the shelf out of the way of WhatsApp's attach preview
        }
      } catch (err) {
        console.error('[drag] post-drag WhatsApp handoff failed:', err)
      }
    }
  }, 150)
})

// ── Download flying-animation callbacks ───────────────────────────────────────
ipcMain.on(CH.FX_REPORT_BTN, (_e, rect) => dl.setDlBtnRect(rect))
ipcMain.on(CH.FX_DONE, () => dl.fxDone())

// ── Duplicate / compare: toggle a 2nd Cirqle page in the right pane ───────────
ipcMain.on(CH.CIRQLE_COMPARE_TOGGLE, () => {
  if (state.rightPane === 'cirqle2') {
    state.rightPane = 'whatsapp' // back to WhatsApp
  } else {
    createCirqle2()
    cirqle2.webContents.loadURL(cirqle.webContents.getURL() || CIRQLE_URL) // duplicate current page
    state.rightPane = 'cirqle2'
    state.showCirqle = true
    state.showWhatsapp = true
    if (state.ratio < 0.3 || state.ratio > 0.7) state.ratio = 0.5
  }
  layout(); saveSettings()
  if (chrome) chrome.webContents.send(CH.STATE, state)
})

// ── Share (from the Cirqle pane → the linked WhatsApp pane) ────────────────────
// action: 'copy' (copy image + focus WA), 'paste' (auto-paste into open chat),
// 'download' (save into common downloads + reveal in Finder to drag in).
ipcMain.handle(CH.SHARE_RECEIPT, (_e, { dataUrl, filename, action, caption } = {}) => {
  if (action === 'download') {
    const p = dl.saveDataUrlToDownloads(dataUrl, filename)
    if (p) { focusWhatsapp(); shell.showItemInFolder(p) }
    return { ok: !!p, action: 'download', path: p }
  }
  const img = dataUrlToImage(dataUrl)
  if (!img || img.isEmpty()) return { ok: false, reason: 'bad-image' }
  const r = shareImageToWhatsApp(img, { autoPaste: action === 'paste', caption })
  return { ...r, action }
})
// The web app's clipboard helper falls back to this: navigator.clipboard
// rejects inside a WebContentsView that isn't the focused document, but the
// main process can always write to the OS clipboard.
ipcMain.handle(CH.CLIPBOARD_WRITE, (_e, text) => {
  try { clipboard.writeText(String(text ?? '')); return true }
  catch { return false }
})
ipcMain.on(CH.CAPTURE_CLIPBOARD, sendClipboardToCirqle)
ipcMain.on(CH.RETRY, (_e, pane) => {
  if (pane === 'whatsapp' && whatsapps[state.activeWa]) whatsapps[state.activeWa].webContents.loadURL(WHATSAPP_URL, { userAgent: CHROME_UA })
  else if (cirqle) cirqle.webContents.loadURL(CIRQLE_URL)
})
ipcMain.handle(CH.APP_VERSION, () => app.getVersion())

ipcMain.on(CH.WA_ADD, () => {
  const newId = Date.now().toString()
  state.waAccounts.push({ id: newId, label: `WA ${state.waAccounts.length + 1}` })
  state.activeWa = newId
  createWhatsappView(newId)
  layout()
  saveSettings()
  if (chrome) chrome.webContents.send(CH.STATE, state)
})

ipcMain.on(CH.WA_SWITCH, (_e, id) => {
  // Clicking a WhatsApp tab always brings WhatsApp back into the right pane,
  // even if it was showing a 2nd Cirqle page.
  state.rightPane = 'whatsapp'
  state.activeWa = id
  state.showWhatsapp = true
  layout()
  saveSettings()
  if (chrome) chrome.webContents.send(CH.STATE, state)
})

ipcMain.on(CH.WA_REMOVE, (_e, id) => {
  if (state.waAccounts.length <= 1) return // Keep at least one
  state.waAccounts = state.waAccounts.filter(a => a.id !== id)
  if (state.activeWa === id) {
    state.activeWa = state.waAccounts[0].id
  }
  if (whatsapps[id]) {
    if (win) win.contentView.removeChildView(whatsapps[id])
    // The view isn't easily destroyed in modern Electron without just letting it get GC'd, 
    // but we can at least remove it from the map.
    delete whatsapps[id]
  }
  layout()
  saveSettings()
  if (chrome) chrome.webContents.send(CH.STATE, state)
})

ipcMain.on(CH.WA_RENAME, (_e, { id, label }) => {
  const account = state.waAccounts.find(a => a.id === id)
  if (account) {
    account.label = label || account.label
    saveSettings()
    if (chrome) chrome.webContents.send(CH.STATE, state)
  }
})

ipcMain.on(CH.CIRQLE_LOGO, (_e, url) => {
  if (state.logoUrl !== url) {
    state.logoUrl = url
    if (chrome) chrome.webContents.send(CH.STATE, state)
  }
})

// Draggable splitter: on drag start we float a full-body overlay view that keeps
// receiving mouse events even as the pointer passes over the two web views.
ipcMain.on(CH.SPLITTER_START, () => {
  dl.closeDownloadsPanel() // only one floating layer at a time
  if (overlay) return
  overlay = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload-ui.js') } })
  overlay.setBackgroundColor('#00000000')
  win.contentView.addChildView(overlay)
  layout()
  overlay.webContents.loadFile(path.join(__dirname, 'overlay.html'))
})
ipcMain.on(CH.SPLITTER_DRAG, (_e, screenX) => {
  const b = win.getContentBounds()
  state.ratio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, (screenX - b.x) / b.width))
  layout()
})
ipcMain.on(CH.SPLITTER_END, () => {
  if (overlay) { win.contentView.removeChildView(overlay); overlay = null }
  saveSettings()
  if (chrome) chrome.webContents.send(CH.STATE, state)
})

// macOS: closing the window should hide it (keep the app + all views alive in
// the dock) rather than destroy it. Destroying leaves no window for the dock
// click to reopen — the previous behavior forced a full quit + relaunch.
let quitting = false

deeplinks.init({
  navigate: (r) => navigate(r),
  showApp: () => {
    if (!win) return
    if (win.isMinimized && win.isMinimized()) win.restore?.()
    win.show?.(); win.focus?.()
  },
})
// Single-instance lock + protocol registration must precede ready — a
// cirqle:// link can be the reason this process was launched.
if (!deeplinks.register()) return

app.whenReady().then(() => {
  // ── Microphone for chat voice notes ─────────────────────────────────────
  // 1. macOS: ask the OS once (shows the system dialog; remembered after).
  //    Requires NSMicrophoneUsageDescription in Info.plist (electron-builder.yml).
  if (process.platform === 'darwin') {
    const { systemPreferences } = require('electron')
    if (systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      systemPreferences.askForMediaAccess('microphone').catch(() => {})
    }
  }
  // 2. Chromium layer: grant getUserMedia to our own app, deny everyone else.
  //    (Without this handler Electron silently DENIES media requests — the
  //    reason voice recording showed "Microphone access is needed".)
  const { session } = require('electron')
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = details?.requestingUrl || wc?.getURL() || ''
    const trusted = url.startsWith(CIRQLE_URL) || url.startsWith('https://web.whatsapp.com')
    if ((permission === 'media' || permission === 'microphone' || permission === 'audioCapture') && trusted) {
      return callback(true)
    }
    if (permission === 'notifications' && trusted) return callback(true)
    callback(false)
  })

  dl.loadDownloads() // restore the downloads history (files that still exist on disk)
  win = new BaseWindow({ width: 1440, height: 900, minWidth: 900, minHeight: 600, title: 'Cirqle Desktop' })
  createViews()
  buildMenu()
  layout()
  win.on('resize', layout)
  win.on('close', (e) => {
    if (process.platform === 'darwin' && !quitting) {
      e.preventDefault()
      // Hiding a window that's in native fullscreen strands its (now empty)
      // fullscreen Space as a black screen. Leave fullscreen first and hide
      // only after the transition completes.
      if (win.isFullScreen()) {
        win.once('leave-full-screen', () => win.hide())
        win.setFullScreen(false)
      } else {
        win.hide()
      }
    }
  })
  globalShortcut.register('CommandOrControl+Shift+N', sendClipboardToCirqle)
  setInterval(pollClipboard, 1500)
  updates.startPeriodicChecks()
  tray.init({
    getWin: () => win,
    sendClipboardToCirqle: () => sendClipboardToCirqle(),
    navigate: (r) => navigate(r),
  })
  tray.create()
})

app.on('activate', () => { if (win && !win.isDestroyed()) win.show() })
app.on('before-quit', () => { quitting = true })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (qlProcess) { try { qlProcess.kill() } catch { /* already exited */ } } })

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
const TOOLBAR_H = 48
const SPLITTER_W = 6
const MIN_RATIO = 0.2
const MAX_RATIO = 0.8

const QUICK_ACTIONS = [
  { label: 'Request / Quick Capture', route: '/dashboard/capture' },
  { label: 'Client', route: '/dashboard/clients' },
  { label: 'Task', route: '/dashboard/tasks' },
  { label: 'Offer', route: '/dashboard/apps/offer-intake' },
  { label: 'Invoice', route: '/dashboard/invoices' },
  { label: 'Quotation', route: '/dashboard/quotations' },
]


let win, chrome, cirqle, cirqle2, splitter, overlay

const DL_PANEL_W = 380
const DL_PANEL_H = 460

// Recent clipboard items (newest first), surfaced in the Capture menu.
const clipHistory = []
let lastClip = ''

// New-window (target=_blank / window.open) links from the Cirqle pane: if they
// point at a file (report / invoice PDF, Excel, CSV, image) download it into the
// Cirqle folder so it lands in the tray; otherwise open in the system browser.
const FILE_URL_RE = /\.(pdf|xlsx?|csv|docx?|pptx?|png|jpe?g|zip)(\?|#|$)/i
function makeWindowOpenHandler(getView) {
  return ({ url }) => {
    if (FILE_URL_RE.test(url) || url.includes('/storage/v1/object/')) {
      try { getView().webContents.downloadURL(url); return { action: 'deny' } } catch { /* fall through to browser */ }
    }
    shell.openExternal(url)
    return { action: 'deny' }
  }
}
const truncate = (s, n = 60) => { const one = String(s).replace(/\s+/g, ' ').trim(); return one.length > n ? one.slice(0, n) + '…' : one }

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

// ── Context menu (both panes, context-aware — Chrome/Safari style) ─────────────
function wireContextMenu(view, isCirqle) {
  view.webContents.on('context-menu', (_e, params) => {
    dl.closeDownloadsPanel() // opening a menu dismisses the downloads panel
    const wc = view.webContents
    const items = []
    const isImage = params.mediaType === 'image' && !!params.srcURL
    const link = params.linkURL
    const flags = params.editFlags || {}

    if (isImage) {
      items.push({ label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) })
      items.push({ label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) })
      items.push({ label: 'Save Image to Downloads', click: () => { try { wc.downloadURL(params.srcURL) } catch { /* ignore */ } } })
      if (isCirqle) {
        // From Cirqle → push straight into the WhatsApp pane.
        items.push({ type: 'separator' })
        items.push({
          label: 'Share Image to Linked WhatsApp',
          click: () => { wc.copyImageAt(params.x, params.y); setTimeout(() => { const wa = focusWhatsapp(); pasteIntoWhatsappComposer(wa) }, 120) },
        })
      }
      items.push({ type: 'separator' })
    }

    if (link) {
      items.push({ label: 'Open Link', click: () => view.webContents.loadURL(link) })
      items.push({ label: 'Open Link in Browser', click: () => shell.openExternal(link) })
      items.push({ label: 'Copy Link', click: () => clipboard.writeText(link) })
      if (FILE_URL_RE.test(link) || link.includes('/storage/v1/object/')) {
        items.push({ label: 'Download to Common Downloads', click: () => { try { wc.downloadURL(link) } catch { /* ignore */ } } })
      }
      items.push({ type: 'separator' })
    }

    // Editing / selection actions, gated on Chromium's own edit flags.
    if (params.isEditable) {
      items.push({ role: 'cut', enabled: flags.canCut })
      items.push({ role: 'copy', enabled: flags.canCopy })
      items.push({ role: 'paste', enabled: flags.canPaste })
      items.push({ role: 'selectAll' })
    } else if (params.selectionText && params.selectionText.trim()) {
      items.push({ role: 'copy' })
      items.push({ role: 'selectAll' })
    }

    if (!items.length) return
    // Trim a trailing separator if one ended the list.
    while (items.length && items[items.length - 1].type === 'separator') items.pop()
    Menu.buildFromTemplate(items).popup({ window: win })
  })
}

// ── Layout: position each view from the window size + ratio + visibility ──────
function layout() {
  if (!win) return
  const b = win.getContentBounds()
  const currentToolbarH = state.showToolbar ? TOOLBAR_H : 0
  const bodyY = currentToolbarH
  const bodyH = b.height - currentToolbarH
  
  if (state.showToolbar) {
    chrome.setBounds({ x: 0, y: 0, width: b.width, height: currentToolbarH })
    chrome.setVisible(true)
  } else {
    chrome.setVisible(false)
  }

  const both = state.showCirqle && state.showWhatsapp

  // Hide every right-slot candidate first (all WhatsApp views + the 2nd Cirqle),
  // then show only the one the user has selected for the right pane.
  for (const id in whatsapps) whatsapps[id].setVisible(false)
  if (cirqle2) cirqle2.setVisible(false)

  const activeRight = (state.rightPane === 'cirqle2' && cirqle2) ? cirqle2 : whatsapps[state.activeWa]

  if (both) {
    const splitX = Math.round(b.width * state.ratio)
    cirqle.setBounds({ x: 0, y: bodyY, width: splitX - SPLITTER_W / 2, height: bodyH })
    splitter.setBounds({ x: splitX - SPLITTER_W / 2, y: bodyY, width: SPLITTER_W, height: bodyH })
    if (activeRight) activeRight.setBounds({ x: splitX + SPLITTER_W / 2, y: bodyY, width: b.width - splitX - SPLITTER_W / 2, height: bodyH })
    splitter.setVisible(true)
  } else {
    splitter.setVisible(false)
    if (state.showCirqle) {
      cirqle.setBounds({ x: 0, y: bodyY, width: b.width, height: bodyH })
    } else if (state.showWhatsapp && activeRight) {
      activeRight.setBounds({ x: 0, y: bodyY, width: b.width, height: bodyH })
    }
  }

  cirqle.setVisible(state.showCirqle)
  if (state.showWhatsapp && activeRight) activeRight.setVisible(true)
  if (overlay) overlay.setBounds({ x: 0, y: bodyY, width: b.width, height: bodyH })
  dl.onLayout()
}

function applyPreset(p) {
  if (p === '50') Object.assign(state, { ratio: 0.5, showCirqle: true, showWhatsapp: true })
  else if (p === '75') Object.assign(state, { ratio: 0.75, showCirqle: true, showWhatsapp: true })
  else if (p === '25') Object.assign(state, { ratio: 0.25, showCirqle: true, showWhatsapp: true })
  else if (p === 'hideWA') Object.assign(state, { showWhatsapp: false, showCirqle: true })
  else if (p === 'hideCirqle') Object.assign(state, { showCirqle: false, showWhatsapp: true })
  else if (p === 'toggleToolbar') Object.assign(state, { showToolbar: !state.showToolbar })
  layout(); saveSettings()
  if (chrome) chrome.webContents.send(CH.STATE, state)
}

// ── Drive Cirqle's Quick Capture ──────────────────────────────────────────────
function ensureCirqleVisible() {
  if (!state.showCirqle) applyPreset(state.showWhatsapp ? '50' : 'hideWA')
}

function sendTextToCirqle(text) {
  if (!text || !text.trim()) return
  ensureCirqleVisible()
  const target = CIRQLE_URL + '/dashboard/capture'
  const send = () => cirqle.webContents.send(CH.CIRQLE_CAPTURE, { text })
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

// Native menu — unclipped, so clipboard history + New-record shortcuts live here
// (a dropdown inside the 48px toolbar view would be clipped to its bounds).
function buildMenu() {
  const recent = clipHistory.length
    ? clipHistory.map((h) => ({ label: truncate(h), click: () => sendTextToCirqle(h) }))
    : [{ label: '(clipboard history is empty)', enabled: false }]

  const menu = Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'Capture',
      submenu: [
        { label: 'New Request from Clipboard', accelerator: 'CmdOrCtrl+Shift+N', click: sendClipboardToCirqle },
        { label: 'Recent Clipboard', submenu: recent },
        { type: 'separator' },
        { label: 'New', submenu: QUICK_ACTIONS.map((a) => ({ label: a.label, click: () => navigate(a.route) })) },
      ],
    },
    // REQUIRED on macOS: without the Edit menu's roles, Cmd+C / Cmd+V don't work
    // in the web views — which would break the entire copy-paste workflow.
    { role: 'editMenu' },
    { label: 'Downloads', submenu: dl.downloadsMenuTemplate() },
    {
      label: 'View',
      submenu: [
        { label: 'Reload Cirqle', accelerator: 'CmdOrCtrl+R', click: () => cirqle && cirqle.webContents.loadURL(CIRQLE_URL) },
        { label: 'Reload WhatsApp', click: () => whatsapps[state.activeWa] && whatsapps[state.activeWa].webContents.reload() },
        { type: 'separator' },
        { label: 'Split 50 / 50', click: () => applyPreset('50') },
        { label: 'Cirqle 75 / WhatsApp 25', click: () => applyPreset('75') },
        { label: 'Cirqle 25 / WhatsApp 75', click: () => applyPreset('25') },
        { label: 'Hide WhatsApp', click: () => applyPreset('hideWA') },
        { label: 'Hide Cirqle', click: () => applyPreset('hideCirqle') },
        { type: 'separator' },
        { label: 'Toggle Toolbar', accelerator: 'CmdOrCtrl+T', click: () => applyPreset('toggleToolbar') },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ])
  Menu.setApplicationMenu(menu)
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
      if (win) {
        if (win.isMinimized && win.isMinimized()) win.restore?.()
        win.show?.()
        win.focus?.()
      }
      if (cirqle) {
        ensureCirqleVisible()
        if (url) { try { cirqle.webContents.loadURL(CIRQLE_URL + url) } catch { /* bad url — ignore */ } }
        cirqle.webContents.focus()
      }
    })
    n.show()

    // High priority: bounce the dock until the app is focused (macOS), and
    // flash the taskbar on Windows/Linux.
    if (process.platform === 'darwin' && app.dock) app.dock.bounce('critical')
    else if (win && win.flashFrame) win.flashFrame(true)
  } catch (err) {
    console.error('[notify] failed:', err)
  }
})

// ── Unread badge relay (Cirqle web view → toolbar bell + dock) ────────────────
ipcMain.on(CH.CIRQLE_BADGE, (_e, count) => {
  const n = Math.max(0, parseInt(count, 10) || 0)
  if (chrome) chrome.webContents.send(CH.NOTIF_BADGE, n)
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
  ensureCirqleVisible()
  if (cirqle) {
    cirqle.webContents.send(CH.CIRQLE_OPEN_NOTIFICATIONS)
    cirqle.webContents.focus()
  }
})

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
ipcMain.handle(CH.SHARE_RECEIPT, (_e, { dataUrl, filename, action } = {}) => {
  if (action === 'download') {
    const p = dl.saveDataUrlToDownloads(dataUrl, filename)
    if (p) { focusWhatsapp(); shell.showItemInFolder(p) }
    return { ok: !!p, action: 'download', path: p }
  }
  const img = dataUrlToImage(dataUrl)
  if (!img || img.isEmpty()) return { ok: false, reason: 'bad-image' }
  const r = shareImageToWhatsApp(img, { autoPaste: action === 'paste' })
  return { ...r, action }
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
})

app.on('activate', () => { if (win && !win.isDestroyed()) win.show() })
app.on('before-quit', () => { quitting = true })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (qlProcess) { try { qlProcess.kill() } catch { /* already exited */ } } })

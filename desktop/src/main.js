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

// Dev escape hatch: run a second instance (own settings + single-instance
// lock) alongside the installed app. Must precede every app.getPath() reader.
if (process.env.CIRQLE_USERDATA) app.setPath('userData', process.env.CIRQLE_USERDATA)

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
  reloadCirqle: () => reloadCirqleView(),
  sendTextToCirqle: (t) => sendTextToCirqle(t),
  sendClipboardToCirqle: () => sendClipboardToCirqle(),
  navigate: (r) => navigate(r),
  getClipHistory: () => clipHistory,
})
const { layout, applyPreset, TOOLBAR_H, MIN_RATIO, MAX_RATIO, MAX_PANES } = layoutMod

layoutMod.init({
  getWin: () => win,
  getChrome: () => chrome,
  getCirqle: () => cirqle,
  getCirqle2: () => cirqle2,
  getWebs: () => webs,
  getSplitters: () => splitters,
  getOverlay: () => overlay,
  ensureView: (pane) => ensureView(pane),
  ensureSplitters: (n) => ensureSplitters(n),
})
const { whatsapps, WHATSAPP_URL, CHROME_UA, focusWhatsapp, pasteIntoWhatsappComposer, shareImageToWhatsApp, shareFileToWhatsApp, dropFileIntoWhatsApp, createWhatsappView } = wa

wa.init({
  getWin: () => win,
  sendStateToChrome: () => { if (chrome) chrome.webContents.send(CH.STATE, state) },
  applyPreset: (p) => applyPreset(p),
  layout: () => layout(),
  wireContextMenu: (v, c) => wireContextMenu(v, c),
  loadError: (v, u, p) => loadError(v, u, p),
  ensureWaPane: (id) => ensureWaPane(id),
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
let win, chrome, cirqle, cirqle2, overlay
const splitters = []   // one per pane boundary, managed by ensureSplitters()
const webs = {}        // built-in browser panes, keyed by web-tab id

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

// Views are z-ordered by insertion; panes never overlap each other but the
// splitters + toolbar (and any floating panel) must stay above every pane.
// Call after adding ANY pane view.
function raiseChrome() {
  if (!win) return
  for (const s of splitters) { win.contentView.removeChildView(s); win.contentView.addChildView(s) }
  if (chrome) { win.contentView.removeChildView(chrome); win.contentView.addChildView(chrome) }
  dl.raiseDownloadsPanel()
}

function makeSplitter(i) {
  const s = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload-ui.js') } })
  s.webContents.loadFile(path.join(__dirname, 'splitter.html'), { query: { i: String(i) } })
  return s
}
// Keep exactly n splitter views alive (n = pane count − 1).
function ensureSplitters(n) {
  while (splitters.length < n) {
    const s = makeSplitter(splitters.length)
    splitters.push(s)
    if (win) win.contentView.addChildView(s)
  }
  while (splitters.length > n) {
    const s = splitters.pop()
    if (win) { try { win.contentView.removeChildView(s) } catch { /* detached */ } }
    try { s.webContents.close() } catch { /* closed */ }
  }
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
  raiseChrome()
}

// ── Built-in browser panes ────────────────────────────────────────────────────
// Hardened: shared 'persist:web' session (logins survive restarts), sandboxed
// renderer, no preload/node access, every site permission denied, downloads
// wired into the common shelf. window.open lands in a new split when there's
// room, else navigates the same pane.
const WEB_HOME = 'https://www.google.com/'
let webSessionWired = false

function webTabFor(id) { return state.webTabs.find(t => t.id === id) }

function createWebView(id) {
  if (webs[id]) return
  const tab = webTabFor(id)
  if (!tab) return
  const v = new WebContentsView({
    webPreferences: { partition: 'persist:web', sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  v.webContents.setUserAgent(wa.CHROME_UA)
  if (!webSessionWired) {
    webSessionWired = true
    dl.wireDownloads(v.webContents.session, 'browser')
    v.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  }
  wireContextMenu(v, false)
  dl.wireEscToCloseDownloads(v)
  v.webContents.on('did-navigate', (_e, url) => { tab.url = url; saveSettings(); layoutMod.broadcast() })
  v.webContents.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (isMainFrame) { tab.url = url; saveSettings(); layoutMod.broadcast() }
  })
  v.webContents.on('page-title-updated', (_e, title) => {
    tab.label = truncate(title || 'Web', 16); layoutMod.broadcast()
  })
  v.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      if (state.panes.length < MAX_PANES) addWebPane(url)
      else v.webContents.loadURL(url)
    } else {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  v.webContents.loadURL(tab.url || WEB_HOME)
  webs[id] = v
  win.contentView.addChildView(v)
  raiseChrome()
}

function addWebPane(url) {
  const id = `w${state.webSeq++}`
  state.webTabs.push({ id, label: `Web ${state.webTabs.length + 1}`, url: url || WEB_HOME })
  state.activeWeb = id
  return layoutMod.addPane(`web:${id}`)
}

function destroyWebView(id) {
  const v = webs[id]
  if (!v) return
  try { win.contentView.removeChildView(v) } catch { /* detached */ }
  try { v.webContents.close() } catch { /* closed */ }
  delete webs[id]
}

// Lazy view resolver: layout() calls this for every pane it's about to place,
// so a pane can exist in state long before its web view has been created.
// This is also what makes WhatsApp lazy — only VISIBLE accounts get a view.
function ensureView(pane) {
  if (pane === 'cirqle2') { createCirqle2(); return }
  if (pane.startsWith('wa:')) {
    const id = pane.slice(3)
    const account = state.waAccounts.find(a => a.id === id)
    if (account && !whatsapps[id]) {
      wa.createWhatsappView(id)
      raiseChrome()
    }
    return
  }
  if (pane.startsWith('web:')) createWebView(pane.slice(4))
}

// Bring a WhatsApp account on screen: reuse its pane if visible, swap it into
// an existing WhatsApp slot, or add a new split. Unpauses the account.
function ensureWaPane(id) {
  if (!id) return
  const account = state.waAccounts.find(a => a.id === id)
  if (account && account.paused) { account.paused = false }
  state.activeWa = id
  const pane = `wa:${id}`
  if (state.panes.includes(pane)) { layoutMod.syncLegacy(); layout(); saveSettings(); layoutMod.broadcast(); return }
  const existingWa = state.panes.find(p => p.startsWith('wa:'))
  if (existingWa) layoutMod.replacePane(existingWa, pane)
  else if (!layoutMod.addPane(pane)) {
    // No room (4 panes, none of them WhatsApp): swap the rightmost non-Cirqle pane.
    const victim = [...state.panes].reverse().find(p => p !== 'cirqle') || state.panes[state.panes.length - 1]
    layoutMod.replacePane(victim, pane)
  }
}

// ── Drive Cirqle's Quick Capture ──────────────────────────────────────────────
function ensureCirqleVisible() {
  if (!state.panes.includes('cirqle')) layoutMod.addPane('cirqle', { front: true })
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

// Reload the Cirqle pane IN PLACE. Both reload paths (Cmd/Ctrl+R and the
// toolbar button) used to call loadURL(CIRQLE_URL), which is the site ROOT —
// and the web app redirects / to /dashboard. So reloading from any working
// page silently threw that page away and bounced you to the dashboard.
// reload() keeps the current URL. The guard matters: after a failed load the
// pane sits on the error.html file:// page, where reload() would just redraw
// the error — there we still want the home URL. Retry (CH.RETRY) keeps its own
// loadURL for the same reason.
function reloadCirqleView() {
  if (!cirqle) return
  const wc = cirqle.webContents
  if (wc.getURL().startsWith(CIRQLE_URL)) wc.reload()
  else wc.loadURL(CIRQLE_URL)
}

function createViews() {
  // The 2nd Cirqle (compare) is never restored across restarts.
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
  // Cirqle pane downloads report/invoice file links into the tray; WhatsApp
  // links keep opening in the system browser.
  cirqle.webContents.setWindowOpenHandler(makeWindowOpenHandler(() => cirqle))

  // Ensure activeWa is valid
  if (!state.waAccounts.find(a => a.id === state.activeWa)) {
    if (state.waAccounts.length > 0) state.activeWa = state.waAccounts[0].id
  }
  // Drop panes whose backing account/tab no longer exists (or is paused).
  state.panes = state.panes.filter(p => {
    if (p.startsWith('wa:')) {
      const a = state.waAccounts.find(x => x.id === p.slice(3))
      return !!a && !a.paused
    }
    if (p.startsWith('web:')) return !!webTabFor(p.slice(4))
    return p === 'cirqle' // cirqle2 was already stripped by settings migration
  })
  if (state.panes.length === 0) state.panes = ['cirqle']
  layoutMod.syncLegacy()

  win.contentView.addChildView(cirqle)
  win.contentView.addChildView(chrome) // toolbar on top; raiseChrome() keeps it there

  // NOTE: WhatsApp/browser views are NOT created here. layout() → ensureView()
  // creates views only for panes actually on screen — accounts you aren't
  // looking at (and paused ones) cost nothing at startup.
}

// ── Hidden-toolbar hover peek ────────────────────────────────────────────────
// With the toolbar hidden, parking the cursor at the very top of the window
// slides it in as an overlay (panes don't reflow); moving back down past it
// slides it away again. ⌘T still toggles it permanently.
let toolbarPeek = false
let peekSlide = null
function slideToolbar(show) {
  if (!win || !chrome) return
  if (peekSlide) { clearInterval(peekSlide); peekSlide = null }
  const width = win.getContentBounds().width
  let step = 0
  const STEPS = 4 // ~60ms of slide — visible motion without feeling laggy
  chrome.setVisible(true)
  peekSlide = setInterval(() => {
    step++
    const t = step / STEPS
    const y = show ? Math.round(-TOOLBAR_H * (1 - t)) : Math.round(-TOOLBAR_H * t)
    chrome.setBounds({ x: 0, y, width, height: TOOLBAR_H })
    if (step >= STEPS) {
      clearInterval(peekSlide); peekSlide = null
      if (!show) chrome.setVisible(false)
    }
  }, 15)
}
function pollToolbarPeek() {
  if (!win || !chrome || state.showToolbar) { toolbarPeek = false; return }
  if (!win.isVisible() || win.isMinimized()) return
  let pt
  try { pt = screen.getCursorScreenPoint() } catch { return }
  const b = win.getContentBounds()
  const inX = pt.x >= b.x && pt.x <= b.x + b.width
  const dy = pt.y - b.y
  if (!toolbarPeek && inX && dy >= 0 && dy <= 4) {
    toolbarPeek = true
    slideToolbar(true)
  } else if (toolbarPeek && (!inX || dy < 0 || dy > TOOLBAR_H + 12)) {
    toolbarPeek = false
    slideToolbar(false)
  }
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
  if (which === 'cirqle') reloadCirqleView()
  if (which === 'whatsapp' && whatsapps[state.activeWa]) whatsapps[state.activeWa].webContents.reload()
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
        // Only hand off when the active WhatsApp pane is actually on screen.
        if (!wa || !state.panes.includes(`wa:${state.activeWa}`)) return
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

// ── Duplicate / compare: toggle a 2nd Cirqle page as a split ─────────────────
ipcMain.on(CH.CIRQLE_COMPARE_TOGGLE, () => {
  if (state.panes.includes('cirqle2')) {
    layoutMod.removePane('cirqle2')
  } else if (layoutMod.addPane('cirqle2')) {
    // addPane → layout → ensureView created the view; duplicate the current page.
    if (cirqle2) cirqle2.webContents.loadURL(cirqle.webContents.getURL() || CIRQLE_URL)
  }
})

// ── Splits: native "+" menu (the toolbar view is 48px tall — an HTML dropdown
// would be clipped at its edge, so the menu must be a native popup) ──────────
function paneTitle(p) {
  if (p === 'cirqle') return 'Cirqle'
  if (p === 'cirqle2') return 'Cirqle (copy)'
  if (p.startsWith('wa:')) return (state.waAccounts.find(a => a.id === p.slice(3)) || {}).label || 'WhatsApp'
  if (p.startsWith('web:')) return (webTabFor(p.slice(4)) || {}).label || 'Browser'
  return p
}
ipcMain.on(CH.SPLIT_MENU, () => {
  const full = state.panes.length >= MAX_PANES
  const add = []
  if (!state.panes.includes('cirqle'))
    add.push({ label: 'Cirqle', click: () => layoutMod.addPane('cirqle', { front: true }) })
  add.push({
    label: 'Duplicate Cirqle (compare)',
    enabled: !full && !state.panes.includes('cirqle2') && state.panes.includes('cirqle'),
    click: () => { if (layoutMod.addPane('cirqle2') && cirqle2) cirqle2.webContents.loadURL(cirqle.webContents.getURL() || CIRQLE_URL) },
  })
  for (const a of state.waAccounts) {
    if (state.panes.includes(`wa:${a.id}`)) continue
    add.push({
      label: `WhatsApp — ${a.label}${a.paused ? ' (paused)' : ''}`,
      enabled: !full,
      click: () => { if (a.paused) a.paused = false; layoutMod.addPane(`wa:${a.id}`) },
    })
  }
  add.push({ label: 'New Browser', enabled: !full, click: () => addWebPane() })

  const template = [
    { label: `Add a split (${state.panes.length}/${MAX_PANES})`, enabled: false },
    ...add,
  ]
  if (state.panes.length > 1) {
    template.push({ type: 'separator' }, { label: 'Close a split', enabled: false })
    for (const p of state.panes) {
      template.push({ label: `Close ${paneTitle(p)}`, click: () => ipcMain.emit(CH.SPLIT_CLOSE, null, p) })
    }
  }
  // NOTE: no { window } option — win is a BaseWindow, and popup() only accepts
  // a BrowserWindow; passing it makes the popup silently fail on some versions.
  Menu.buildFromTemplate(template).popup()
})

// ── Splits: add / close panes; built-in browser navigation ───────────────────
ipcMain.on(CH.SPLIT_ADD, (_e, pane) => {
  if (!pane || typeof pane !== 'object') return
  if (pane.kind === 'cirqle2') {
    if (!state.panes.includes('cirqle2') && layoutMod.addPane('cirqle2') && cirqle2) {
      cirqle2.webContents.loadURL(cirqle.webContents.getURL() || CIRQLE_URL)
    }
  } else if (pane.kind === 'cirqle') {
    layoutMod.addPane('cirqle', { front: true })
  } else if (pane.kind === 'wa' && pane.id) {
    const account = state.waAccounts.find(a => a.id === pane.id)
    if (!account) return
    if (account.paused) account.paused = false
    layoutMod.addPane(`wa:${pane.id}`)
  } else if (pane.kind === 'web') {
    addWebPane(pane.url)
  }
})

ipcMain.on(CH.SPLIT_CLOSE, (_e, pane) => {
  if (typeof pane !== 'string') return
  if (!layoutMod.removePane(pane)) return
  // Closing a browser split closes its tab too — a hidden loaded browser is
  // exactly the resource drain this feature exists to avoid.
  if (pane.startsWith('web:')) {
    const id = pane.slice(4)
    destroyWebView(id)
    state.webTabs = state.webTabs.filter(t => t.id !== id)
    if (state.activeWeb === id) state.activeWeb = state.webTabs[0]?.id ?? null
    saveSettings(); layoutMod.broadcast()
  }
})

ipcMain.on(CH.WEB_NAV, (_e, { id, op, url } = {}) => {
  const v = webs[id]
  if (!v) return
  const wc = v.webContents
  if (op === 'back' && wc.canGoBack()) wc.goBack()
  else if (op === 'forward' && wc.canGoForward()) wc.goForward()
  else if (op === 'reload') wc.reload()
  else if (op === 'url' && typeof url === 'string' && url.trim()) {
    let target = url.trim()
    // Bare words become a search; bare domains get https://.
    if (!/^[a-z]+:\/\//i.test(target)) {
      target = /^[\w-]+(\.[\w-]+)+(\/|$|\?)/.test(target)
        ? `https://${target}`
        : `https://www.google.com/search?q=${encodeURIComponent(target)}`
    }
    wc.loadURL(target)
  }
  state.activeWeb = id
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
  ensureWaPane(newId) // swaps into the current WhatsApp slot (or adds a split)
})

// Clicking a WhatsApp tab brings that account on screen — into the existing
// WhatsApp slot if there is one, as a new split otherwise. Unpauses it.
ipcMain.on(CH.WA_SWITCH, (_e, id) => ensureWaPane(id))

ipcMain.on(CH.WA_REMOVE, (_e, id) => {
  if (state.waAccounts.length <= 1) return // Keep at least one
  state.waAccounts = state.waAccounts.filter(a => a.id !== id)
  if (state.activeWa === id) state.activeWa = state.waAccounts[0].id
  const pane = `wa:${id}`
  if (state.panes.includes(pane)) {
    if (!layoutMod.removePane(pane)) layoutMod.replacePane(pane, `wa:${state.activeWa}`)
  }
  wa.destroyWhatsappView(id)
  layout(); saveSettings()
  if (chrome) chrome.webContents.send(CH.STATE, state)
})

// Mute: silence every sound from that account's pane (message chimes included)
// so a message to a group you're in from 3 linked accounts dings once, not 3×.
ipcMain.on(CH.WA_MUTE, (_e, { id, muted } = {}) => {
  const account = state.waAccounts.find(a => a.id === id)
  if (!account) return
  account.muted = !!muted
  if (whatsapps[id]) whatsapps[id].webContents.setAudioMuted(!!muted)
  saveSettings()
  if (chrome) chrome.webContents.send(CH.STATE, state)
})

// Pause: fully unload the account — no network, no memory, no notifications —
// until its tab is clicked again. The login session survives in its partition.
ipcMain.on(CH.WA_PAUSE, (_e, { id, paused } = {}) => {
  const account = state.waAccounts.find(a => a.id === id)
  if (!account) return
  account.paused = !!paused
  if (paused) {
    const pane = `wa:${id}`
    if (state.panes.includes(pane) && !layoutMod.removePane(pane)) {
      // It was the only pane — fall back to Cirqle.
      layoutMod.replacePane(pane, 'cirqle')
    }
    wa.destroyWhatsappView(id)
  } else {
    ensureWaPane(id)
  }
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
  // Only absolute http(s)/data URLs can render in the file:// toolbar chrome;
  // anything else (relative path, junk) clears back to the bundled mark. The
  // result is persisted, so a dead URL from an old deploy is also flushed out
  // of layout.json the next time the page reports its logo.
  const clean = (typeof url === 'string' && /^(https?:|data:image\/)/i.test(url)) ? url : ''
  if (state.logoUrl !== clean) {
    state.logoUrl = clean
    saveSettings()
    if (chrome) chrome.webContents.send(CH.STATE, state)
  }
})

// Draggable splitters: on drag start we float a full-body overlay view that
// keeps receiving mouse events even as the pointer passes over the web views.
// The boundary index rides along in the overlay's query string.
ipcMain.on(CH.SPLITTER_START, (_e, i) => {
  dl.closeDownloadsPanel() // only one floating layer at a time
  if (overlay) return
  overlay = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload-ui.js') } })
  overlay.setBackgroundColor('#00000000')
  win.contentView.addChildView(overlay)
  layout()
  overlay.webContents.loadFile(path.join(__dirname, 'overlay.html'), { query: { i: String(i ?? 0) } })
})
ipcMain.on(CH.SPLITTER_DRAG, (_e, { i, screenX } = {}) => {
  const b = win.getContentBounds()
  layoutMod.dragBoundary(i ?? 0, (screenX - b.x) / b.width)
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
  setInterval(pollToolbarPeek, 150)
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
app.on('will-quit', () => { globalShortcut.unregisterAll(); dl.killQuickLook() })

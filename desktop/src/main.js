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

const { app, BaseWindow, WebContentsView, ipcMain, globalShortcut, clipboard, shell, Menu } = require('electron')
const path = require('path')
const fs = require('fs')

const CIRQLE_URL = (process.env.CIRQLE_URL || 'https://app.cirqle.work').replace(/\/$/, '')
const WHATSAPP_URL = 'https://web.whatsapp.com/'
// A current desktop Chrome UA — WhatsApp Web rejects Electron's default UA
// ("update your browser"). The single most common reason these wrappers fail.
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

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

// ── Persisted layout (a tiny JSON file; avoids an ESM-only dependency) ────────
const settingsFile = () => path.join(app.getPath('userData'), 'layout.json')
const loadSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) } catch { return {} } }
const saveSettings = () => { try { fs.writeFileSync(settingsFile(), JSON.stringify(state)) } catch { /* best effort */ } }

let win, chrome, cirqle, splitter, overlay
const whatsapps = {} // keyed by id
const state = Object.assign({ 
  ratio: 0.5, 
  showCirqle: true, 
  showWhatsapp: true,
  showToolbar: true,
  waAccounts: [{ id: 'default', label: 'WA 1' }],
  activeWa: 'default'
}, loadSettings())

// Recent clipboard items (newest first), surfaced in the Capture menu.
const clipHistory = []
let lastClip = ''

// Downloads (reports / invoices) saved from the Cirqle pane. Session-only,
// newest first. Surfaced via the toolbar ⬇ button and a native popup menu so
// the user can open them or reveal them in Finder to drag into WhatsApp.
const downloads = []
const downloadsDir = () => path.join(app.getPath('downloads'), 'Cirqle')
function uniquePath(dir, name) {
  let p = path.join(dir, name)
  const ext = path.extname(name)
  const base = path.basename(name, ext)
  let i = 1
  while (fs.existsSync(p)) { p = path.join(dir, `${base} (${i++})${ext}`) }
  return p
}
function wireDownloads(sess) {
  if (!sess || sess.__cirqleDownloadsWired) return
  sess.__cirqleDownloadsWired = true
  sess.on('will-download', (_event, item) => {
    try {
      const dir = downloadsDir()
      fs.mkdirSync(dir, { recursive: true })
      const savePath = uniquePath(dir, item.getFilename() || 'download')
      item.setSavePath(savePath)
      item.once('done', (_e, st) => {
        if (st !== 'completed') return
        downloads.unshift({ name: path.basename(savePath), path: savePath, at: Date.now() })
        if (downloads.length > 30) downloads.pop()
        if (chrome) chrome.webContents.send('downloads', { count: downloads.length, latest: path.basename(savePath) })
        buildMenu()
      })
    } catch { /* fall back to Electron's default download handling */ }
  })
}
function downloadsMenuTemplate() {
  const items = downloads.length
    ? downloads.map((d) => ({
        label: truncate(d.name, 48),
        submenu: [
          { label: 'Open', click: () => shell.openPath(d.path) },
          { label: 'Show in Folder (drag into WhatsApp)', click: () => shell.showItemInFolder(d.path) },
        ],
      }))
    : [{ label: '(no downloads yet)', enabled: false }]
  return [
    ...items,
    { type: 'separator' },
    { label: 'Open Downloads Folder', click: () => shell.openPath(downloadsDir()) },
    { label: 'Clear List', enabled: downloads.length > 0, click: () => { downloads.length = 0; if (chrome) chrome.webContents.send('downloads', { count: 0 }); buildMenu() } },
  ]
}
function popupDownloadsMenu() {
  const menu = Menu.buildFromTemplate(downloadsMenuTemplate())
  if (win) menu.popup({ window: win })
}
const truncate = (s, n = 60) => { const one = String(s).replace(/\s+/g, ' ').trim(); return one.length > n ? one.slice(0, n) + '…' : one }

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
  
  // Hide all whatsapp views first
  for (const id in whatsapps) whatsapps[id].setVisible(false)
  
  const activeWaView = whatsapps[state.activeWa]

  if (both) {
    const splitX = Math.round(b.width * state.ratio)
    cirqle.setBounds({ x: 0, y: bodyY, width: splitX - SPLITTER_W / 2, height: bodyH })
    splitter.setBounds({ x: splitX - SPLITTER_W / 2, y: bodyY, width: SPLITTER_W, height: bodyH })
    if (activeWaView) activeWaView.setBounds({ x: splitX + SPLITTER_W / 2, y: bodyY, width: b.width - splitX - SPLITTER_W / 2, height: bodyH })
    splitter.setVisible(true)
  } else {
    splitter.setVisible(false)
    if (state.showCirqle) {
      cirqle.setBounds({ x: 0, y: bodyY, width: b.width, height: bodyH })
    } else if (state.showWhatsapp && activeWaView) {
      activeWaView.setBounds({ x: 0, y: bodyY, width: b.width, height: bodyH })
    }
  }
  
  cirqle.setVisible(state.showCirqle)
  if (state.showWhatsapp && activeWaView) activeWaView.setVisible(true)
  if (overlay) overlay.setBounds({ x: 0, y: bodyY, width: b.width, height: bodyH })
}

function applyPreset(p) {
  if (p === '50') Object.assign(state, { ratio: 0.5, showCirqle: true, showWhatsapp: true })
  else if (p === '75') Object.assign(state, { ratio: 0.75, showCirqle: true, showWhatsapp: true })
  else if (p === '25') Object.assign(state, { ratio: 0.25, showCirqle: true, showWhatsapp: true })
  else if (p === 'hideWA') Object.assign(state, { showWhatsapp: false, showCirqle: true })
  else if (p === 'hideCirqle') Object.assign(state, { showCirqle: false, showWhatsapp: true })
  else if (p === 'toggleToolbar') Object.assign(state, { showToolbar: !state.showToolbar })
  layout(); saveSettings()
  if (chrome) chrome.webContents.send('state', state)
}

// ── Drive Cirqle's Quick Capture ──────────────────────────────────────────────
function ensureCirqleVisible() {
  if (!state.showCirqle) applyPreset(state.showWhatsapp ? '50' : 'hideWA')
}

function sendTextToCirqle(text) {
  if (!text || !text.trim()) return
  ensureCirqleVisible()
  const target = CIRQLE_URL + '/dashboard/capture'
  const send = () => cirqle.webContents.send('cirqle:capture', { text })
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
  chrome = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload-ui.js') } })
  chrome.webContents.loadFile(path.join(__dirname, 'host.html'))
  chrome.webContents.once('did-finish-load', () => chrome.webContents.send('state', state))

  cirqle = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload-cirqle.js') } })
  cirqle.webContents.loadURL(CIRQLE_URL)
  wireDownloads(cirqle.webContents.session) // capture report / invoice downloads
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

  for (const v of [cirqle, ...Object.values(whatsapps)]) {
    v.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  }

  win.contentView.addChildView(cirqle)
  Object.values(whatsapps).forEach(waView => win.contentView.addChildView(waView))
  win.contentView.addChildView(splitter)
  win.contentView.addChildView(chrome) // toolbar on top
}

function createWhatsappView(id) {
  if (whatsapps[id]) return
  const wa = new WebContentsView({ webPreferences: { partition: `persist:whatsapp:${id}`, preload: path.join(__dirname, 'preload-ui.js') } })
  wa.webContents.setUserAgent(CHROME_UA)
  wa.webContents.loadURL(WHATSAPP_URL, { userAgent: CHROME_UA })
  wa.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) loadError(wa, WHATSAPP_URL, 'whatsapp')
  })
  wa.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  whatsapps[id] = wa
  if (win) win.contentView.addChildView(wa)
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
    { label: 'Downloads', submenu: downloadsMenuTemplate() },
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

// ── IPC from the toolbar / splitter / overlay / error page ────────────────────
ipcMain.on('layout:preset', (_e, p) => applyPreset(p))
ipcMain.on('reload', (_e, which) => {
  if (which === 'cirqle' && cirqle) cirqle.webContents.loadURL(CIRQLE_URL)
  if (which === 'whatsapp' && whatsapps[state.activeWa]) whatsapps[state.activeWa].webContents.reload()
})
ipcMain.on('goBack', () => { if (cirqle && cirqle.webContents.canGoBack()) cirqle.webContents.goBack() })
ipcMain.on('goForward', () => { if (cirqle && cirqle.webContents.canGoForward()) cirqle.webContents.goForward() })
ipcMain.on('toggleFullscreen', () => { if (win) win.setFullScreen(!win.isFullScreen()) })
ipcMain.on('downloads:menu', popupDownloadsMenu)
ipcMain.on('capture:clipboard', sendClipboardToCirqle)
ipcMain.on('retry', (_e, pane) => {
  if (pane === 'whatsapp' && whatsapps[state.activeWa]) whatsapps[state.activeWa].webContents.loadURL(WHATSAPP_URL, { userAgent: CHROME_UA })
  else if (cirqle) cirqle.webContents.loadURL(CIRQLE_URL)
})
ipcMain.handle('app:version', () => app.getVersion())

ipcMain.on('wa:add', () => {
  const newId = Date.now().toString()
  state.waAccounts.push({ id: newId, label: `WA ${state.waAccounts.length + 1}` })
  state.activeWa = newId
  createWhatsappView(newId)
  layout()
  saveSettings()
  if (chrome) chrome.webContents.send('state', state)
})

ipcMain.on('wa:switch', (_e, id) => {
  if (state.activeWa === id) return
  state.activeWa = id
  state.showWhatsapp = true
  layout()
  saveSettings()
  if (chrome) chrome.webContents.send('state', state)
})

ipcMain.on('wa:remove', (_e, id) => {
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
  if (chrome) chrome.webContents.send('state', state)
})

ipcMain.on('wa:rename', (_e, { id, label }) => {
  const account = state.waAccounts.find(a => a.id === id)
  if (account) {
    account.label = label || account.label
    saveSettings()
    if (chrome) chrome.webContents.send('state', state)
  }
})

ipcMain.on('cirqle:logo', (_e, url) => {
  if (state.logoUrl !== url) {
    state.logoUrl = url
    if (chrome) chrome.webContents.send('state', state)
  }
})

// Draggable splitter: on drag start we float a full-body overlay view that keeps
// receiving mouse events even as the pointer passes over the two web views.
ipcMain.on('splitter:start', () => {
  if (overlay) return
  overlay = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload-ui.js') } })
  overlay.setBackgroundColor('#00000000')
  win.contentView.addChildView(overlay)
  layout()
  overlay.webContents.loadFile(path.join(__dirname, 'overlay.html'))
})
ipcMain.on('splitter:drag', (_e, screenX) => {
  const b = win.getContentBounds()
  state.ratio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, (screenX - b.x) / b.width))
  layout()
})
ipcMain.on('splitter:end', () => {
  if (overlay) { win.contentView.removeChildView(overlay); overlay = null }
  saveSettings()
  if (chrome) chrome.webContents.send('state', state)
})

app.whenReady().then(() => {
  win = new BaseWindow({ width: 1440, height: 900, minWidth: 900, minHeight: 600, title: 'Cirqle Desktop' })
  createViews()
  buildMenu()
  layout()
  win.on('resize', layout)
  globalShortcut.register('CommandOrControl+Shift+N', sendClipboardToCirqle)
  setInterval(pollClipboard, 1500)
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('will-quit', () => globalShortcut.unregisterAll())

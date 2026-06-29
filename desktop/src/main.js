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

let win, chrome, cirqle, whatsapp, splitter, overlay
const state = Object.assign({ ratio: 0.5, showCirqle: true, showWhatsapp: true }, loadSettings())

// Recent clipboard items (newest first), surfaced in the Capture menu.
const clipHistory = []
let lastClip = ''
const truncate = (s, n = 60) => { const one = String(s).replace(/\s+/g, ' ').trim(); return one.length > n ? one.slice(0, n) + '…' : one }

// ── Layout: position each view from the window size + ratio + visibility ──────
function layout() {
  if (!win) return
  const b = win.getContentBounds()
  const bodyY = TOOLBAR_H
  const bodyH = b.height - TOOLBAR_H
  chrome.setBounds({ x: 0, y: 0, width: b.width, height: TOOLBAR_H })

  const both = state.showCirqle && state.showWhatsapp
  if (both) {
    const splitX = Math.round(b.width * state.ratio)
    cirqle.setBounds({ x: 0, y: bodyY, width: splitX - SPLITTER_W / 2, height: bodyH })
    splitter.setBounds({ x: splitX - SPLITTER_W / 2, y: bodyY, width: SPLITTER_W, height: bodyH })
    whatsapp.setBounds({ x: splitX + SPLITTER_W / 2, y: bodyY, width: b.width - splitX - SPLITTER_W / 2, height: bodyH })
    splitter.setVisible(true)
  } else {
    splitter.setVisible(false)
    const only = state.showCirqle ? cirqle : whatsapp
    only.setBounds({ x: 0, y: bodyY, width: b.width, height: bodyH })
  }
  cirqle.setVisible(state.showCirqle)
  whatsapp.setVisible(state.showWhatsapp)
  if (overlay) overlay.setBounds({ x: 0, y: bodyY, width: b.width, height: bodyH })
}

function applyPreset(p) {
  if (p === '50') Object.assign(state, { ratio: 0.5, showCirqle: true, showWhatsapp: true })
  else if (p === '75') Object.assign(state, { ratio: 0.75, showCirqle: true, showWhatsapp: true })
  else if (p === '25') Object.assign(state, { ratio: 0.25, showCirqle: true, showWhatsapp: true })
  else if (p === 'hideWA') Object.assign(state, { showWhatsapp: false, showCirqle: true })
  else if (p === 'hideCirqle') Object.assign(state, { showCirqle: false, showWhatsapp: true })
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
  cirqle.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) loadError(cirqle, CIRQLE_URL, 'cirqle')
  })

  whatsapp = new WebContentsView({ webPreferences: { partition: 'persist:whatsapp:default', preload: path.join(__dirname, 'preload-ui.js') } })
  whatsapp.webContents.setUserAgent(CHROME_UA)
  whatsapp.webContents.loadURL(WHATSAPP_URL, { userAgent: CHROME_UA })
  whatsapp.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) loadError(whatsapp, WHATSAPP_URL, 'whatsapp')
  })

  splitter = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload-ui.js') } })
  splitter.webContents.loadFile(path.join(__dirname, 'splitter.html'))

  // External links (target=_blank) open in the system browser, not in-app.
  for (const v of [cirqle, whatsapp]) {
    v.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  }

  win.contentView.addChildView(cirqle)
  win.contentView.addChildView(whatsapp)
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
    {
      label: 'View',
      submenu: [
        { label: 'Reload Cirqle', accelerator: 'CmdOrCtrl+R', click: () => cirqle && cirqle.webContents.loadURL(CIRQLE_URL) },
        { label: 'Reload WhatsApp', click: () => whatsapp && whatsapp.webContents.reload() },
        { type: 'separator' },
        { label: 'Split 50 / 50', click: () => applyPreset('50') },
        { label: 'Cirqle 75 / WhatsApp 25', click: () => applyPreset('75') },
        { label: 'Cirqle 25 / WhatsApp 75', click: () => applyPreset('25') },
        { label: 'Hide WhatsApp', click: () => applyPreset('hideWA') },
        { label: 'Hide Cirqle', click: () => applyPreset('hideCirqle') },
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
  if (which === 'whatsapp' && whatsapp) whatsapp.webContents.reload()
})
ipcMain.on('capture:clipboard', sendClipboardToCirqle)
ipcMain.on('retry', (_e, pane) => {
  if (pane === 'whatsapp' && whatsapp) whatsapp.webContents.loadURL(WHATSAPP_URL, { userAgent: CHROME_UA })
  else if (cirqle) cirqle.webContents.loadURL(CIRQLE_URL)
})
ipcMain.handle('app:version', () => app.getVersion())

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

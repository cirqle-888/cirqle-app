'use strict'

/**
 * Cirqle Desktop — main process.
 *
 * One window, two side-by-side web views: Cirqle on the left, WhatsApp Web on
 * the right. Electron loads web.whatsapp.com as a top-level page (not an
 * iframe), so X-Frame-Options doesn't apply — the proven Rambox/Ferdi pattern.
 *
 * Workflow is fully manual: you copy in the WhatsApp pane and paste into
 * Cirqle. The "New request from clipboard" action (toolbar / ⌘⇧N) reads the
 * clipboard, opens Cirqle's Quick Capture, and prefills it via the
 * `cirqle:capture` window event (see preload-cirqle.js).
 */

const { app, BaseWindow, WebContentsView, ipcMain, globalShortcut, clipboard, shell, Menu } = require('electron')
const path = require('path')
const fs = require('fs')

const CIRQLE_URL = (process.env.CIRQLE_URL || 'https://app.cirqle.work').replace(/\/$/, '')
const WHATSAPP_URL = 'https://web.whatsapp.com/'
// A current desktop Chrome UA — WhatsApp Web rejects Electron's default UA
// ("update your browser"). This is the single most common reason wrappers fail.
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const TOOLBAR_H = 48
const SPLITTER_W = 6
const MIN_RATIO = 0.2
const MAX_RATIO = 0.8

// ── Persisted layout (a tiny JSON file; avoids an ESM-only dependency) ────────
const settingsFile = () => path.join(app.getPath('userData'), 'layout.json')
const loadSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) } catch { return {} } }
const saveSettings = () => { try { fs.writeFileSync(settingsFile(), JSON.stringify(state)) } catch { /* best effort */ } }

let win, chrome, cirqle, whatsapp, splitter, overlay
const state = Object.assign({ ratio: 0.5, showCirqle: true, showWhatsapp: true }, loadSettings())

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

// ── Clipboard → Cirqle Quick Capture (the core manual workflow) ───────────────
function sendClipboardToCirqle() {
  const text = clipboard.readText()
  if (!text || !text.trim()) return
  if (!state.showCirqle) applyPreset(state.showWhatsapp ? '50' : 'hideWA')
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

function createViews() {
  chrome = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload-ui.js') } })
  chrome.webContents.loadFile(path.join(__dirname, 'host.html'))
  chrome.webContents.once('did-finish-load', () => chrome.webContents.send('state', state))

  cirqle = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload-cirqle.js') } })
  cirqle.webContents.loadURL(CIRQLE_URL)

  whatsapp = new WebContentsView({ webPreferences: { partition: 'persist:whatsapp:default' } })
  whatsapp.webContents.setUserAgent(CHROME_UA)
  whatsapp.webContents.loadURL(WHATSAPP_URL, { userAgent: CHROME_UA })

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

function buildMenu() {
  const menu = Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Request from Clipboard', accelerator: 'CmdOrCtrl+Shift+N', click: sendClipboardToCirqle },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    // REQUIRED on macOS: without the Edit menu's roles, Cmd+C / Cmd+V don't work
    // in the web views — which would break the entire copy-paste workflow.
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reload Cirqle', accelerator: 'CmdOrCtrl+R', click: () => cirqle && cirqle.webContents.reload() },
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

// ── IPC from the toolbar / splitter / overlay ─────────────────────────────────
ipcMain.on('layout:preset', (_e, p) => applyPreset(p))
ipcMain.on('reload', (_e, which) => {
  if (which === 'cirqle' && cirqle) cirqle.webContents.reload()
  if (which === 'whatsapp' && whatsapp) whatsapp.webContents.reload()
})
ipcMain.on('capture:clipboard', sendClipboardToCirqle)
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
})

app.whenReady().then(() => {
  win = new BaseWindow({ width: 1440, height: 900, minWidth: 900, minHeight: 600, title: 'Cirqle Desktop' })
  createViews()
  buildMenu()
  layout()
  win.on('resize', layout)
  globalShortcut.register('CommandOrControl+Shift+N', sendClipboardToCirqle)
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('will-quit', () => globalShortcut.unregisterAll())

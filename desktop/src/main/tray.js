'use strict'

/**
 * Menu-bar / system-tray icon. Lightweight by design: mirrors actions that
 * already exist elsewhere (the Quick menu, downloads, the update notifier) —
 * no new capabilities, just reachability while the window is hidden.
 */
const { app, Tray, Menu, nativeImage, dialog } = require('electron')
const path = require('path')

const dl = require('./downloads')
const updates = require('./updates')
const quick = require('./quick-actions')

const deps = {
  getWin: () => null,
}
function init(d) { Object.assign(deps, d) }

let tray = null // keep the reference — a GC'd Tray vanishes from the menu bar

function showApp() {
  const w = deps.getWin()
  if (!w) return
  if (w.isMinimized && w.isMinimized()) w.restore?.()
  w.show?.()
  w.focus?.()
}
function hideApp() {
  const w = deps.getWin()
  if (w) w.hide?.()
}

function trayIcon() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'icon.png'))
  // 18px fits the macOS menu bar and Windows tray cleanly.
  return img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 18, height: 18 })
}

function create() {
  if (tray) return tray
  tray = new Tray(trayIcon())
  tray.setToolTip('Cirqle Desktop')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show App', click: showApp },
    { label: 'Hide App', click: hideApp },
    { type: 'separator' },
    { label: 'Downloads', click: () => { showApp(); dl.toggleDownloadsPanel() } },
    // The same list as the toolbar's Quick menu (quick-actions.js). Each one
    // brings the window forward first, so it works with the app hidden.
    ...quick.template(),
    { type: 'separator' },
    { label: 'Check for Updates…', click: () => updates.checkForUpdates({ interactive: true }) },
    {
      label: 'About Cirqle Desktop',
      click: () => {
        dialog.showMessageBox({
          type: 'info',
          message: 'Cirqle Desktop',
          detail: `Version ${app.getVersion()}\nCirqle + WhatsApp Web, side by side.`,
        })
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]))
  return tray
}

module.exports = { init, create }

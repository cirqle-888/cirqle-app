'use strict'
const path = require('path')
const { pathToFileURL } = require('url')
const APP_ORIGINS = [process.env.CIRQLE_URL || 'https://app.cirqle.work', process.env.STUDIO_URL || 'https://flyer.cirqle.work'].map(u => new URL(u).origin)
const LOCAL_PAGES = new Set(['host.html', 'splitter.html', 'overlay.html', 'downloads.html', 'dl-catcher.html', 'download-fx.html'].map(f => pathToFileURL(path.join(__dirname, '..', f)).href))
const ERROR_PAGE = pathToFileURL(path.join(__dirname, '..', 'error.html')).href
const APP_CHANNELS = new Set(['retry', 'cirqle:logo', 'clipboard:write', 'cirqle:notify', 'cirqle:badge', 'share:receipt', 'presence:query', 'pane:saveStatus'])
function origin(url) { try { return new URL(url).origin } catch { return null } }
function allowed(event, channel) {
  if (!event) return true // Native menu actions use ipcMain.emit internally.
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame) return false
  const url = frame.url.split('?')[0].split('#')[0]
  if (LOCAL_PAGES.has(url)) return true
  if (channel === 'client-workspace:open') return origin(frame.url) === APP_ORIGINS[0]
  if (url === ERROR_PAGE) return channel === 'retry'
  return APP_ORIGINS.includes(origin(frame.url)) && APP_CHANNELS.has(channel)
}
function install(ipcMain) {
  const on = ipcMain.on.bind(ipcMain), handle = ipcMain.handle.bind(ipcMain)
  ipcMain.on = (channel, listener) => on(channel, (event, ...args) => { if (allowed(event, channel)) return listener(event, ...args) })
  ipcMain.handle = (channel, listener) => handle(channel, (event, ...args) => {
    if (!allowed(event, channel)) throw new Error('Desktop action unavailable for this page')
    return listener(event, ...args)
  })
}
function openExternal(shell, url) {
  try { if (['https:', 'http:', 'mailto:', 'tel:'].includes(new URL(url).protocol)) return shell.openExternal(url) } catch {}
}
function protectNavigation(view, shell, origins = APP_ORIGINS) {
  for (const name of ['will-navigate', 'will-redirect']) view.webContents.on(name, (event, url) => {
    if (origins.includes(origin(url))) return
    event.preventDefault()
    openExternal(shell, url)
  })
}
module.exports = { install, allowed, origin, openExternal, protectNavigation }

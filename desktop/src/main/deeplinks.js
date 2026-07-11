'use strict'

/**
 * cirqle:// deep links + the file-open extension point.
 *
 * Supported today (extensible — add a key to ROUTES):
 *   cirqle://dashboard | tasks | quotations | invoices | payroll | settings
 *   cirqle://open?path=/dashboard/anything   (escape hatch for future links)
 *
 * macOS delivers links via 'open-url'; Windows/Linux deliver them as argv of
 * a second instance, so the single-instance lock lives here too (the second
 * instance forwards its argv and exits — also the standard Windows pattern).
 *
 * File associations: none are registered today (deliberate — the app is a
 * web shell with no owned file type). The extension point is
 * registerFileHandler(): 'open-file' / file-path argv already route through
 * it, so adding an association later is electron-builder config plus one
 * handler — no lifecycle rework.
 */
const { app } = require('electron')

const deps = {
  navigate: () => {},
  showApp: () => {},
}
function init(d) { Object.assign(deps, d) }

const PROTOCOL = 'cirqle'

// Extensible route map: host → in-app path.
const ROUTES = {
  dashboard: '/dashboard',
  tasks: '/dashboard/tasks',
  quotations: '/dashboard/quotations',
  invoices: '/dashboard/invoices',
  payroll: '/dashboard/payroll',
  settings: '/dashboard/settings',
}

function routeFor(rawUrl) {
  let u
  try { u = new URL(rawUrl) } catch { return null }
  if (u.protocol !== `${PROTOCOL}:`) return null
  if (u.host === 'open') {
    const p = u.searchParams.get('path')
    // Only in-app absolute paths — never let a link steer the pane off-site.
    if (p && p.startsWith('/')) return p
    return null
  }
  const base = ROUTES[u.host]
  if (!base) return null
  // cirqle://tasks/123 → /dashboard/tasks/123
  return base + (u.pathname && u.pathname !== '/' ? u.pathname : '')
}

function handleUrl(rawUrl) {
  const route = routeFor(rawUrl)
  if (!route) return false
  deps.showApp()
  deps.navigate(route)
  return true
}

// ── File-open extension point ────────────────────────────────────────────────
const fileHandlers = []
/** Register a handler(filePath) → boolean handled. None exist today. */
function registerFileHandler(fn) { fileHandlers.push(fn) }
function handleFile(filePath) {
  for (const fn of fileHandlers) { if (fn(filePath)) return true }
  return false
}

/**
 * Must run BEFORE app.whenReady resolves ('open-url' can arrive at launch).
 * Returns false when this process lost the single-instance race and is
 * quitting — the caller must stop booting.
 */
function register() {
  // Single-instance: required for Windows/Linux deep links (the OS launches a
  // new process per link; it forwards argv here and exits).
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) { app.quit(); return false }

  app.on('second-instance', (_e, argv) => {
    deps.showApp()
    const link = argv.find((a) => typeof a === 'string' && a.startsWith(`${PROTOCOL}://`))
    if (link) handleUrl(link)
    const file = argv.find((a) => typeof a === 'string' && !a.startsWith('-') && !a.startsWith(`${PROTOCOL}://`) && /\.[a-z0-9]+$/i.test(a))
    if (file) handleFile(file)
  })

  // macOS link + file delivery.
  app.on('open-url', (e, url) => { e.preventDefault(); handleUrl(url) })
  app.on('open-file', (e, filePath) => { if (handleFile(filePath)) e.preventDefault() })

  // OS-level protocol registration. In dev (electron .) this points at the
  // Electron binary with args; packaged builds use the Info.plist/registry
  // entries from electron-builder config.
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [require('path').resolve(process.argv[1])])
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL)
  }
  return true
}

module.exports = { init, register, handleUrl, routeFor, registerFileHandler, ROUTES }

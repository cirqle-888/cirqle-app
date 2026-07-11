'use strict'

/**
 * Lightweight update notifier.
 *
 * The app ships unsigned (no Apple Developer account), and Squirrel.Mac
 * refuses unsigned updates — so electron-updater is off the table until the
 * app is signed + notarized. Instead: fetch a tiny version manifest, compare
 * against app.getVersion(), and offer a download link.
 *
 * Swap path to a real auto-updater later WITHOUT changing the UI surface:
 * keep checkForUpdates(opts) and startPeriodicChecks() as the only entry
 * points and replace their internals with electron-updater calls.
 *
 * Manifest (desktop/latest.json on the repo's main branch):
 *   { "version": "0.6.0", "url": "https://github.com/.../releases" }
 */
const { app, dialog, shell, Notification } = require('electron')

const FEED_URL =
  process.env.CIRQLE_UPDATE_FEED ||
  'https://raw.githubusercontent.com/cirqle-888/cirqle-app/main/desktop/latest.json'

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000 // 6h
let notifiedVersion = null // notify once per newer version per session

function parseVer(v) {
  return String(v || '0').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
}
function isNewer(remote, local) {
  const r = parseVer(remote), l = parseVer(local)
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true
    if ((r[i] || 0) < (l[i] || 0)) return false
  }
  return false
}

async function fetchManifest() {
  const res = await fetch(FEED_URL, { headers: { 'cache-control': 'no-cache' } })
  if (!res.ok) throw new Error(`feed ${res.status}`)
  return res.json()
}

/**
 * interactive=true → always tell the user the outcome (menu/tray click).
 * interactive=false → silent unless a new version is found (startup/periodic).
 */
async function checkForUpdates({ interactive = false } = {}) {
  let manifest
  try {
    manifest = await fetchManifest()
  } catch (err) {
    if (interactive) {
      dialog.showMessageBox({ type: 'info', message: 'Could not check for updates', detail: String(err.message || err) })
    }
    return { ok: false, error: String(err) }
  }

  const current = app.getVersion()
  const latest = manifest?.version
  if (!latest || !isNewer(latest, current)) {
    if (interactive) {
      dialog.showMessageBox({ type: 'info', message: 'Cirqle Desktop is up to date', detail: `Version ${current}` })
    }
    return { ok: true, updateAvailable: false, current }
  }

  const url = manifest.url || 'https://github.com/cirqle-888/cirqle-app/releases'
  if (!interactive && notifiedVersion === latest) return { ok: true, updateAvailable: true, latest }
  notifiedVersion = latest

  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: `Update available: ${latest}`,
    detail: `You have ${current}. Download the new build, then drag it to Applications as usual.`,
    buttons: ['Download', 'Later'],
    defaultId: 0,
    cancelId: 1,
  })
  if (response === 0) shell.openExternal(url)
  return { ok: true, updateAvailable: true, latest, accepted: response === 0 }
}

let timer = null
function startPeriodicChecks() {
  if (timer) return
  // First check shortly after launch (don't block startup), then every 6h.
  setTimeout(() => { checkForUpdates({ interactive: false }).catch(() => {}) }, 15_000)
  timer = setInterval(() => { checkForUpdates({ interactive: false }).catch(() => {}) }, CHECK_EVERY_MS)
}

module.exports = { checkForUpdates, startPeriodicChecks }

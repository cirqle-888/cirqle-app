'use strict'

/**
 * Common Downloads domain: the shared download list (both panes), its
 * persistence, the floating shelf panel + scrim, the fly-to-button FX
 * overlay, Quick Look, drag-out icons, and the native Downloads submenu.
 *
 * Pure extraction from main.js — behavior unchanged. Cross-domain refs
 * (window, toolbar view, menu rebuild, WhatsApp share) are injected via
 * init() as lazy getters so module load order doesn't matter.
 */
const { app, WebContentsView, shell, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

const CH = require('../shared/ipc-channels')
const { state } = require('./settings')

const TOOLBAR_H = 48
const DL_PANEL_W = 380
const DL_PANEL_H = 460

const deps = {
  getWin: () => null,
  getChrome: () => null,
  buildMenu: () => {},
  shareFileToWhatsApp: () => {},
  closeOtherPopups: () => {},
  truncate: (x) => String(x),
}
function init(d) { Object.assign(deps, d) }

// Downloads-owned views + FX state (moved from main.js's declarations).
let downloadsPanel = null
let dlCatcher = null
let fxOverlay = null
let fxInFlight = 0        // number of icons currently animating; overlay removed at 0
let dlBtnRect = null      // ⬇ button rect (window coords), reported by host.html

// ── Common Downloads ──────────────────────────────────────────────────────────
// Every file saved from EITHER pane (Cirqle reports/invoices/receipts, or images
// & files saved from WhatsApp Web) lands in one shared list — a Chrome/Safari-style
// downloads shelf surfaced as a floating panel (⬇ toolbar button). The list is
// persisted across restarts (metadata only) so history survives like a browser's.
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|heic)(\?|#|$)/i
const downloads = [] // { id, name, path, at, size, source, done, received, total }
const downloadsDir = () => path.join(app.getPath('downloads'), 'Cirqle')
const downloadsStore = () => path.join(app.getPath('userData'), 'downloads.json')
let dlSeq = 0

function loadDownloads() {
  try {
    const raw = JSON.parse(fs.readFileSync(downloadsStore(), 'utf8'))
    if (Array.isArray(raw)) {
      // Drop entries whose file no longer exists on disk (like a browser prunes).
      for (const d of raw) {
        if (d && d.path && fs.existsSync(d.path)) {
          downloads.push({ ...d, id: ++dlSeq, done: true })
        }
      }
    }
  } catch { /* first run / corrupt — start empty */ }
}
function saveDownloads() {
  try {
    const slim = downloads
      .filter((d) => d.done)
      .slice(0, 60)
      .map(({ name, path: p, at, size, source }) => ({ name, path: p, at, size, source }))
    fs.writeFileSync(downloadsStore(), JSON.stringify(slim))
  } catch { /* best effort */ }
}
function isImageFile(nameOrPath) { return IMAGE_EXT_RE.test(nameOrPath || '') }
function pushDownloadsUpdate() {
  if (deps.getChrome()) deps.getChrome().webContents.send(CH.DOWNLOADS, { count: downloads.filter((d) => d.done).length })
  if (downloadsPanel) downloadsPanel.webContents.send(CH.DOWNLOADS_LIST, downloadsForPanel())
}
function downloadsForPanel() {
  return downloads.map((d) => ({
    id: d.id,
    name: d.name,
    at: d.at,
    size: d.size || 0,
    source: d.source || 'cirqle',
    done: !!d.done,
    received: d.received || 0,
    total: d.total || 0,
    isImage: isImageFile(d.path || d.name),
    // Local file preview for images — file:// path the panel can render as a thumbnail.
    thumb: d.done && isImageFile(d.path || d.name) ? 'file://' + encodeURI(d.path) : null,
  }))
}
function uniquePath(dir, name) {
  let p = path.join(dir, name)
  const ext = path.extname(name)
  const base = path.basename(name, ext)
  let i = 1
  while (fs.existsSync(p)) { p = path.join(dir, `${base} (${i++})${ext}`) }
  return p
}
function wireDownloads(sess, source) {
  if (!sess || sess.__cirqleDownloadsWired) return
  sess.__cirqleDownloadsWired = true
  sess.on('will-download', (_event, item) => {
    try {
      const dir = downloadsDir()
      fs.mkdirSync(dir, { recursive: true })
      const savePath = uniquePath(dir, item.getFilename() || 'download')
      item.setSavePath(savePath)
      const rec = {
        id: ++dlSeq,
        name: path.basename(savePath),
        path: savePath,
        at: Date.now(),
        size: 0,
        source: source || 'cirqle',
        done: false,
        received: 0,
        total: item.getTotalBytes() || 0,
      }
      downloads.unshift(rec)
      while (downloads.length > 60) downloads.pop()
      pushDownloadsUpdate()
      flyDownloadFx(source) // animate an icon flying to the ⬇ shelf button
      item.on('updated', (_e, st) => {
        if (st === 'progressing') {
          rec.received = item.getReceivedBytes()
          rec.total = item.getTotalBytes() || rec.total
          pushDownloadsUpdate()
        }
      })
      item.once('done', (_e, st) => {
        if (st === 'completed') {
          rec.done = true
          try { rec.size = fs.statSync(savePath).size } catch { /* ignore */ }
          pushDownloadsUpdate()
          saveDownloads()
          deps.buildMenu()
        } else {
          // interrupted / cancelled — drop it from the list
          const i = downloads.indexOf(rec)
          if (i >= 0) downloads.splice(i, 1)
          pushDownloadsUpdate()
        }
      })
    } catch { /* fall back to Electron's default download handling */ }
  })
}
function removeDownload(id) {
  const i = downloads.findIndex((d) => d.id === id)
  if (i >= 0) { downloads.splice(i, 1); pushDownloadsUpdate(); saveDownloads(); deps.buildMenu() }
}
function clearDownloads() {
  downloads.length = 0
  pushDownloadsUpdate(); saveDownloads(); deps.buildMenu()
}

// ── Quick Look (macOS) ──────────────────────────────────────────────────────
// Electron has no native Quick Look API, but every Mac ships `qlmanage` (the
// same CLI the OS uses internally) — `qlmanage -p <file>` pops the real,
// native Quick Look panel (spacebar-to-close, resizable, full codec/preview
// support for images/PDFs/docs). Track the one running instance and kill it
// before starting another so re-triggering Quick Look on a new file swaps the
// panel's content instead of stacking duplicate windows.
let qlProcess = null
function quickLookFile(filePath) {
  if (process.platform !== 'darwin') return
  if (qlProcess) { try { qlProcess.kill() } catch { /* already exited */ } }
  qlProcess = spawn('qlmanage', ['-p', filePath], { stdio: 'ignore' })
  qlProcess.on('exit', () => { qlProcess = null })
  qlProcess.on('error', () => { qlProcess = null })
}

// The compact native "Downloads" submenu still lives in the menu bar (unclipped);
// the rich actions live in the floating panel.
function downloadsMenuTemplate() {
  const done = downloads.filter((d) => d.done)
  const items = done.length
    ? done.slice(0, 15).map((d) => ({
        label: deps.truncate(d.name, 48),
        submenu: [
          { label: 'Quick Look', accelerator: 'Space', click: () => quickLookFile(d.path) },
          { label: 'Open', click: () => shell.openPath(d.path) },
          { label: 'Show in Folder', click: () => shell.showItemInFolder(d.path) },
          { label: 'Share to Linked WhatsApp', click: () => deps.shareFileToWhatsApp(d.path) },
        ],
      }))
    : [{ label: '(no downloads yet)', enabled: false }]
  return [
    ...items,
    { type: 'separator' },
    { label: 'Open Downloads Folder', click: () => shell.openPath(downloadsDir()) },
    { label: 'Clear List', enabled: done.length > 0, click: clearDownloads },
  ]
}


// Save a data URL (e.g. a canvas-rendered receipt PNG) into the common downloads.
function saveDataUrlToDownloads(dataUrl, filename) {
  try {
    const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl)
    if (!m) return null
    const dir = downloadsDir()
    fs.mkdirSync(dir, { recursive: true })
    const savePath = uniquePath(dir, filename || 'download.png')
    fs.writeFileSync(savePath, Buffer.from(m[2], 'base64'))
    const rec = {
      id: ++dlSeq, name: path.basename(savePath), path: savePath, at: Date.now(),
      size: fs.statSync(savePath).size, source: 'cirqle', done: true, received: 0, total: 0,
    }
    downloads.unshift(rec)
    while (downloads.length > 60) downloads.pop()
    pushDownloadsUpdate(); saveDownloads(); deps.buildMenu()
    flyDownloadFx('cirqle') // receipt/canvas saves get the flying animation too
    return savePath
  } catch { return null }
}


// ── Downloads panel (floating Chrome/Safari-style shelf) ──────────────────────
// The 48px toolbar view clips its own content, so the panel is its own
// WebContentsView floated on top, anchored under the ⬇ button.
function positionDownloadsPanel() {
  if (!deps.getWin()) return
  const b = deps.getWin().getContentBounds()
  // The catch layer spans the whole window so a click ANYWHERE outside the panel
  // (either pane or the toolbar) dismisses it — exactly like a browser scrim.
  if (dlCatcher) dlCatcher.setBounds({ x: 0, y: 0, width: b.width, height: b.height })
  if (!downloadsPanel) return
  const w = Math.min(DL_PANEL_W, b.width - 16)
  const h = Math.min(DL_PANEL_H, b.height - TOOLBAR_H - 16)
  downloadsPanel.setBounds({ x: Math.max(8, b.width - w - 10), y: (state.showToolbar ? TOOLBAR_H : 0) + 4, width: w, height: h })
}
function openDownloadsPanel() {
  if (downloadsPanel) return
  deps.closeOtherPopups() // only one floating panel at a time
  // 1) Transparent full-window catch layer, UNDER the panel. A transparent
  //    WebContentsView still receives mouse events (same trick the splitter drag
  //    overlay uses), so a click anywhere on it = a click outside the panel →
  //    dismiss. This is far more reliable than blur/focus events across the
  //    separate WebContentsViews of the Cirqle / WhatsApp panes.
  dlCatcher = new WebContentsView({ webPreferences: { preload: path.join(__dirname, '..', 'preload-ui.js') } })
  dlCatcher.setBackgroundColor('#00000000')
  deps.getWin().contentView.addChildView(dlCatcher)
  dlCatcher.webContents.loadFile(path.join(__dirname, '..', 'dl-catcher.html'))
  // 2) The panel itself, stacked ON TOP of the catcher — clicks inside it hit the
  //    panel (its own WebContentsView), so they never reach the catcher.
  downloadsPanel = new WebContentsView({ webPreferences: { preload: path.join(__dirname, '..', 'preload-ui.js') } })
  downloadsPanel.setBackgroundColor('#00000000')
  deps.getWin().contentView.addChildView(downloadsPanel)
  downloadsPanel.webContents.loadFile(path.join(__dirname, '..', 'downloads.html'))
  downloadsPanel.webContents.once('did-finish-load', () => {
    downloadsPanel.webContents.send(CH.DOWNLOADS_LIST, downloadsForPanel())
    downloadsPanel.webContents.focus() // keyboard (Esc) goes to the panel
  })
  positionDownloadsPanel()
}
function closeDownloadsPanel() {
  if (downloadsPanel) { deps.getWin().contentView.removeChildView(downloadsPanel); downloadsPanel = null }
  if (dlCatcher) { deps.getWin().contentView.removeChildView(dlCatcher); dlCatcher = null }
}
function toggleDownloadsPanel() {
  if (downloadsPanel) closeDownloadsPanel()
  else openDownloadsPanel()
}
// Keep the catcher + panel on top after another view is (re)added to the window.
function raiseDownloadsPanel() {
  if (!downloadsPanel || !deps.getWin()) return
  if (dlCatcher) { deps.getWin().contentView.removeChildView(dlCatcher); deps.getWin().contentView.addChildView(dlCatcher) }
  deps.getWin().contentView.removeChildView(downloadsPanel); deps.getWin().contentView.addChildView(downloadsPanel)
}
// Esc closes the panel no matter which pane holds keyboard focus. Harmless when
// the panel is closed (does nothing, doesn't preventDefault → panes keep their Esc).
function wireEscToCloseDownloads(view) {
  view.webContents.on('before-input-event', (_e, input) => {
    if (downloadsPanel && input.type === 'keyDown' && input.key === 'Escape') closeDownloadsPanel()
  })
}

// ── Download "flying to the shelf" animation (Chrome/Safari style) ─────────────
// A transient, full-window transparent overlay flies a little download icon from
// the pane that triggered the download to the ⬇ toolbar button, then the button
// pulses. Like the downloads panel/catcher, a transparent WebContentsView still
// captures mouse events, so the overlay exists ONLY while an icon is in flight
// (~0.6s) and is removed the instant the last one lands — a click the user is
// very unlikely to make right after clicking "download".
function paneCenter(source) {
  const b = deps.getWin().getContentBounds()
  const toolbarH = state.showToolbar ? TOOLBAR_H : 0
  const bodyH = b.height - toolbarH
  const both = state.showCirqle && state.showWhatsapp
  if (source === 'whatsapp') {
    const splitX = both ? Math.round(b.width * state.ratio) : 0
    const w = both ? (b.width - splitX) : b.width
    return { x: splitX + w / 2, y: toolbarH + bodyH / 2 }
  }
  const w = both ? Math.round(b.width * state.ratio) : b.width
  return { x: w / 2, y: toolbarH + bodyH / 2 }
}
function dlBtnCenter() {
  const b = deps.getWin().getContentBounds()
  if (dlBtnRect && state.showToolbar) return { x: dlBtnRect.x + dlBtnRect.w / 2, y: dlBtnRect.y + dlBtnRect.h / 2 }
  return { x: b.width - 40, y: state.showToolbar ? TOOLBAR_H / 2 : 12 }
}
// Pending safety-net timers, one per in-flight icon — see flyDownloadFx().
const fxTimeouts = []
// Well past the ~560ms CSS animation in download-fx.html; only fires if the
// real onfinish → fx:done round-trip never arrives.
const FX_SAFETY_MS = 1500

function ensureFxOverlay() {
  if (fxOverlay) return
  fxOverlay = new WebContentsView({ webPreferences: { preload: path.join(__dirname, '..', 'preload-ui.js') } })
  fxOverlay.setBackgroundColor('#00000000')
  deps.getWin().contentView.addChildView(fxOverlay) // topmost while it lives
  fxOverlay.webContents.loadFile(path.join(__dirname, '..', 'download-fx.html'))
  const b = deps.getWin().getContentBounds()
  fxOverlay.setBounds({ x: 0, y: 0, width: b.width, height: b.height })
  console.log('[fx] overlay created')
}
// Lands exactly one in-flight icon: decrements the counter, tears down the
// overlay once nothing is left in flight, and pulses the ⬇ button. Called
// either by the real 'fx:done' IPC (renderer confirms its animation finished)
// or by the safety-net timeout below — never both, for the same flight.
function landOneFlight() {
  fxInFlight = Math.max(0, fxInFlight - 1)
  if (fxInFlight === 0 && fxOverlay) {
    deps.getWin().contentView.removeChildView(fxOverlay)
    fxOverlay = null
    console.log('[fx] overlay removed, all flights landed')
  }
  if (deps.getChrome()) deps.getChrome().webContents.send(CH.DOWNLOADS_PULSE) // land → pulse the ⬇ button
}
function flyDownloadFx(source) {
  if (!deps.getWin()) return
  const payload = { from: paneCenter(source), to: dlBtnCenter() }
  ensureFxOverlay()
  fxInFlight++
  console.log('[fx] flight started, in-flight =', fxInFlight)
  const send = () => { if (fxOverlay) fxOverlay.webContents.send(CH.FX_FLY, payload) }
  if (fxOverlay.webContents.isLoadingMainFrame()) fxOverlay.webContents.once('did-finish-load', send)
  else send()

  // Safety net: a transparent WebContentsView still captures mouse events
  // (see comment above paneCenter), so if the renderer's onfinish → fx:done
  // round-trip is ever dropped (failed IPC, overlay never finishing load,
  // etc.) the overlay would otherwise sit on top of the whole window
  // FOREVER, silently blocking every click and drag underneath it. Force-land
  // this flight if that round-trip doesn't arrive in time.
  const timer = setTimeout(() => {
    const i = fxTimeouts.indexOf(timer)
    if (i >= 0) fxTimeouts.splice(i, 1)
    console.warn('[fx] safety-net timeout fired — fx:done never arrived, force-removing overlay')
    landOneFlight()
  }, FX_SAFETY_MS)
  fxTimeouts.push(timer)
}

// ── Native drag-out of a downloaded file (to WhatsApp, Finder, anywhere) ───────
// A 1×1 transparent PNG — startDrag REQUIRES a non-empty icon or it throws, so
// this is the guaranteed fallback when a file has no usable thumbnail.
const FALLBACK_DRAG_ICON = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
)
async function dragIconFor(filePath) {
  try {
    if (isImageFile(filePath)) {
      const img = nativeImage.createFromPath(filePath)
      if (!img.isEmpty()) return img.resize({ width: 64, quality: 'good' })
    }
  } catch { /* fall through */ }
  // Real OS file icon (what Finder shows) — covers PDF and every other type.
  // The old fallback chain ended at a 1×1 TRANSPARENT png whenever assets/
  // wasn't packaged (electron-builder only shipped src/**), so PDF drags
  // started with an invisible ghost — indistinguishable from "drag is broken".
  try {
    const icon = await app.getFileIcon(filePath, { size: 'normal' })
    if (icon && !icon.isEmpty()) return icon
  } catch { /* fall through */ }
  try {
    const appIcon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'icon.png'))
    if (!appIcon.isEmpty()) return appIcon.resize({ width: 48 })
  } catch { /* fall through */ }
  return FALLBACK_DRAG_ICON
}

// ── Second Cirqle pane — "duplicate / compare two Cirqle pages side-by-side" ────
// Shares the DEFAULT session with the main Cirqle view (same login/cookies), so
// wireDownloads is a no-op here (already wired once on that session).

function findDownload(id) { return downloads.find((d) => d.id === id) }
function setDlBtnRect(rect) { dlBtnRect = rect }

// layout() hook: keep the FX overlay full-window and the panel anchored.
function onLayout() {
  const b = deps.getWin().getContentBounds()
  if (fxOverlay) fxOverlay.setBounds({ x: 0, y: 0, width: b.width, height: b.height })
  if (downloadsPanel) positionDownloadsPanel()
}

// A flight landed for real — cancel its safety-net timer, then land it.
function fxDone() {
  const timer = fxTimeouts.shift()
  if (timer) clearTimeout(timer)
  landOneFlight()
}

// Drag-out support: the scrim must not swallow the drag; panel bounds tell
// the drop-detector whether the pointer ended over the shelf.
function setCatcherVisible(v) { if (dlCatcher) dlCatcher.setVisible(v) }
function getPanelBounds() { return downloadsPanel ? downloadsPanel.getBounds() : null }

module.exports = {
  init,
  loadDownloads,
  wireDownloads,
  wireEscToCloseDownloads,
  downloadsMenuTemplate,
  downloadsDir,
  isImageFile,
  saveDataUrlToDownloads,
  quickLookFile,
  removeDownload,
  clearDownloads,
  findDownload,
  toggleDownloadsPanel,
  closeDownloadsPanel,
  positionDownloadsPanel,
  raiseDownloadsPanel,
  isDownloadsPanelOpen: () => !!downloadsPanel,
  flyDownloadFx,
  landOneFlight,
  setDlBtnRect,
  dragIconFor,
  onLayout,
  fxDone,
  setCatcherVisible,
  getPanelBounds,
}

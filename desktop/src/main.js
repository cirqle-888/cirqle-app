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

const { app, BaseWindow, WebContentsView, ipcMain, globalShortcut, clipboard, shell, Menu, nativeImage, screen } = require('electron')
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

let win, chrome, cirqle, cirqle2, splitter, overlay, downloadsPanel, dlCatcher, fxOverlay
const whatsapps = {} // keyed by id

// Download "flying to the shelf" animation state.
let fxInFlight = 0        // number of icons currently animating; overlay removed at 0
let dlBtnRect = null      // ⬇ button rect (window coords), reported by host.html

const DL_PANEL_W = 380
const DL_PANEL_H = 460
const state = Object.assign({
  ratio: 0.5,
  showCirqle: true,
  showWhatsapp: true,   // structurally: "show the RIGHT pane" (WhatsApp or 2nd Cirqle)
  showToolbar: true,
  rightPane: 'whatsapp', // 'whatsapp' | 'cirqle2' — what occupies the right slot
  waAccounts: [{ id: 'default', label: 'WA 1' }],
  activeWa: 'default'
}, loadSettings())

// Recent clipboard items (newest first), surfaced in the Capture menu.
const clipHistory = []
let lastClip = ''

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
  if (chrome) chrome.webContents.send('downloads', { count: downloads.filter((d) => d.done).length })
  if (downloadsPanel) downloadsPanel.webContents.send('downloads:list', downloadsForPanel())
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
          buildMenu()
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
  if (i >= 0) { downloads.splice(i, 1); pushDownloadsUpdate(); saveDownloads(); buildMenu() }
}
function clearDownloads() {
  downloads.length = 0
  pushDownloadsUpdate(); saveDownloads(); buildMenu()
}

// The compact native "Downloads" submenu still lives in the menu bar (unclipped);
// the rich actions live in the floating panel.
function downloadsMenuTemplate() {
  const done = downloads.filter((d) => d.done)
  const items = done.length
    ? done.slice(0, 15).map((d) => ({
        label: truncate(d.name, 48),
        submenu: [
          { label: 'Open', click: () => shell.openPath(d.path) },
          { label: 'Show in Folder', click: () => shell.showItemInFolder(d.path) },
          { label: 'Share to Linked WhatsApp', click: () => shareFileToWhatsApp(d.path) },
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

// ── Share to the linked WhatsApp pane ─────────────────────────────────────────
// The reliable path everywhere: put the image on the OS clipboard, bring the
// active WhatsApp pane forward + focus it, so ⌘V drops it into the open chat.
// autoPaste additionally tries to focus WhatsApp's composer and paste for the
// user (best-effort — WhatsApp Web's DOM can change, so it degrades to manual ⌘V).
function focusWhatsapp() {
  // If the right pane is currently showing a 2nd Cirqle, switch it back to WhatsApp
  // so the share target is actually visible.
  const wasComparing = state.rightPane === 'cirqle2'
  state.rightPane = 'whatsapp'
  if (!state.showWhatsapp) applyPreset(state.showCirqle ? '50' : 'hideCirqle')
  else if (wasComparing) { layout(); saveSettings(); if (chrome) chrome.webContents.send('state', state) }
  const wa = whatsapps[state.activeWa]
  if (wa) { wa.webContents.focus() }
  return wa
}
async function pasteIntoWhatsappComposer(wa) {
  if (!wa) return false
  try {
    // Focus the message composer (the contenteditable with a data-tab), then paste.
    await wa.webContents.executeJavaScript(`(() => {
      const box = document.querySelector('div[contenteditable="true"][data-tab]') ||
                  document.querySelector('footer div[contenteditable="true"]')
      if (box) { box.focus(); return true }
      return false
    })()`, true)
    wa.webContents.paste()
    return true
  } catch { return false }
}
function shareImageToWhatsApp(image, { autoPaste = false } = {}) {
  if (!image || image.isEmpty?.()) return { ok: false, reason: 'empty' }
  clipboard.writeImage(image)
  const wa = focusWhatsapp()
  if (autoPaste) setTimeout(() => pasteIntoWhatsappComposer(wa), 250)
  return { ok: true, pasted: autoPaste }
}
// Best-effort MIME type for the synthetic WhatsApp drop — WhatsApp Web uses it
// to decide between photo preview and document attachment.
const MIME_BY_EXT = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4',
  mov: 'video/quicktime', mp3: 'audio/mpeg', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv', txt: 'text/plain', zip: 'application/zip',
}
function mimeFor(filePath) {
  const ext = (path.extname(filePath) || '').slice(1).toLowerCase()
  return MIME_BY_EXT[ext] || 'application/octet-stream'
}

/**
 * Deliver a file into WhatsApp Web as if it were dropped on the open chat.
 *
 * Why this exists: a drag started with webContents.startDrag() can land in
 * Finder, the Desktop, or any OTHER app, but Chromium never delivers it to a
 * WebContentsView of the SAME app — so "drag from the Downloads shelf onto the
 * WhatsApp pane" silently did nothing. We detect that case after the drag ends
 * and finish the drop ourselves: read the file, rebuild it as a File object
 * inside the WhatsApp page, and dispatch a real DragEvent('drop') on the chat.
 * WhatsApp then shows its normal attachment preview — nothing is sent until
 * the user presses Send.
 */
async function dropFileIntoWhatsApp(wa, filePath) {
  if (!wa) return { ok: false, reason: 'no whatsapp view' }
  try {
    const stat = fs.statSync(filePath)
    if (stat.size > 60 * 1024 * 1024) return { ok: false, reason: 'file too large' } // WhatsApp caps ~64MB
    const b64 = fs.readFileSync(filePath).toString('base64')
    const ok = await wa.webContents.executeJavaScript(`(async () => {
      const res = await fetch('data:${mimeFor(filePath)};base64,${b64}')
      const blob = await res.blob()
      const file = new File([blob], ${JSON.stringify(path.basename(filePath))}, { type: ${JSON.stringify(mimeFor(filePath))} })
      const dt = new DataTransfer()
      dt.items.add(file)
      // #main = the open conversation. Fall back to the app root so a drop
      // still registers if WhatsApp changes its DOM.
      const target = document.querySelector('#main') || document.querySelector('#app') || document.body
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
      }
      return true
    })()`, true)
    return { ok: !!ok }
  } catch (e) { return { ok: false, reason: String(e) } }
}

function shareFileToWhatsApp(filePath, opts) {
  try {
    if (isImageFile(filePath)) {
      const img = nativeImage.createFromPath(filePath)
      if (!img.isEmpty()) return shareImageToWhatsApp(img, opts)
    }
    // Non-image (PDF etc.): synthesize a drop on the open chat — same path the
    // drag-out uses. Reveal in Finder only if that fails (old behavior).
    const wa = focusWhatsapp()
    dropFileIntoWhatsApp(wa, filePath).then((r) => {
      if (!r.ok) shell.showItemInFolder(filePath)
    })
    return { ok: true }
  } catch (e) { return { ok: false, reason: String(e) } }
}
function dataUrlToImage(dataUrl) {
  try { return nativeImage.createFromDataURL(dataUrl) } catch { return null }
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
    pushDownloadsUpdate(); saveDownloads(); buildMenu()
    flyDownloadFx('cirqle') // receipt/canvas saves get the flying animation too
    return savePath
  } catch { return null }
}

// ── Downloads panel (floating Chrome/Safari-style shelf) ──────────────────────
// The 48px toolbar view clips its own content, so the panel is its own
// WebContentsView floated on top, anchored under the ⬇ button.
function positionDownloadsPanel() {
  if (!win) return
  const b = win.getContentBounds()
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
  closeOtherPopups() // only one floating panel at a time
  // 1) Transparent full-window catch layer, UNDER the panel. A transparent
  //    WebContentsView still receives mouse events (same trick the splitter drag
  //    overlay uses), so a click anywhere on it = a click outside the panel →
  //    dismiss. This is far more reliable than blur/focus events across the
  //    separate WebContentsViews of the Cirqle / WhatsApp panes.
  dlCatcher = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload-ui.js') } })
  dlCatcher.setBackgroundColor('#00000000')
  win.contentView.addChildView(dlCatcher)
  dlCatcher.webContents.loadFile(path.join(__dirname, 'dl-catcher.html'))
  // 2) The panel itself, stacked ON TOP of the catcher — clicks inside it hit the
  //    panel (its own WebContentsView), so they never reach the catcher.
  downloadsPanel = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload-ui.js') } })
  downloadsPanel.setBackgroundColor('#00000000')
  win.contentView.addChildView(downloadsPanel)
  downloadsPanel.webContents.loadFile(path.join(__dirname, 'downloads.html'))
  downloadsPanel.webContents.once('did-finish-load', () => {
    downloadsPanel.webContents.send('downloads:list', downloadsForPanel())
    downloadsPanel.webContents.focus() // keyboard (Esc) goes to the panel
  })
  positionDownloadsPanel()
}
function closeDownloadsPanel() {
  if (downloadsPanel) { win.contentView.removeChildView(downloadsPanel); downloadsPanel = null }
  if (dlCatcher) { win.contentView.removeChildView(dlCatcher); dlCatcher = null }
}
function toggleDownloadsPanel() {
  if (downloadsPanel) closeDownloadsPanel()
  else openDownloadsPanel()
}
// Keep the catcher + panel on top after another view is (re)added to the window.
function raiseDownloadsPanel() {
  if (!downloadsPanel || !win) return
  if (dlCatcher) { win.contentView.removeChildView(dlCatcher); win.contentView.addChildView(dlCatcher) }
  win.contentView.removeChildView(downloadsPanel); win.contentView.addChildView(downloadsPanel)
}
// Dismiss any other transient floating layer so only one is ever open.
function closeOtherPopups() {
  if (overlay) { win.contentView.removeChildView(overlay); overlay = null }
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
  const b = win.getContentBounds()
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
  const b = win.getContentBounds()
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
  fxOverlay = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload-ui.js') } })
  fxOverlay.setBackgroundColor('#00000000')
  win.contentView.addChildView(fxOverlay) // topmost while it lives
  fxOverlay.webContents.loadFile(path.join(__dirname, 'download-fx.html'))
  const b = win.getContentBounds()
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
    win.contentView.removeChildView(fxOverlay)
    fxOverlay = null
    console.log('[fx] overlay removed, all flights landed')
  }
  if (chrome) chrome.webContents.send('downloads:pulse') // land → pulse the ⬇ button
}
function flyDownloadFx(source) {
  if (!win) return
  const payload = { from: paneCenter(source), to: dlBtnCenter() }
  ensureFxOverlay()
  fxInFlight++
  console.log('[fx] flight started, in-flight =', fxInFlight)
  const send = () => { if (fxOverlay) fxOverlay.webContents.send('fx:fly', payload) }
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
    const appIcon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'))
    if (!appIcon.isEmpty()) return appIcon.resize({ width: 48 })
  } catch { /* fall through */ }
  return FALLBACK_DRAG_ICON
}

// ── Second Cirqle pane — "duplicate / compare two Cirqle pages side-by-side" ────
// Shares the DEFAULT session with the main Cirqle view (same login/cookies), so
// wireDownloads is a no-op here (already wired once on that session).
function createCirqle2() {
  if (cirqle2) return
  cirqle2 = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload-cirqle.js') } })
  cirqle2.webContents.loadURL(cirqle.webContents.getURL() || CIRQLE_URL)
  wireDownloads(cirqle2.webContents.session, 'cirqle')
  wireContextMenu(cirqle2, true)
  wireEscToCloseDownloads(cirqle2)
  cirqle2.webContents.setWindowOpenHandler(makeWindowOpenHandler(() => cirqle2))
  cirqle2.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) loadError(cirqle2, CIRQLE_URL, 'cirqle')
  })
  win.contentView.addChildView(cirqle2)
  // Keep splitter + toolbar (and any floating panel) above the new pane.
  win.contentView.removeChildView(splitter); win.contentView.addChildView(splitter)
  win.contentView.removeChildView(chrome); win.contentView.addChildView(chrome)
  raiseDownloadsPanel()
}

// ── Context menu (both panes, context-aware — Chrome/Safari style) ─────────────
function wireContextMenu(view, isCirqle) {
  view.webContents.on('context-menu', (_e, params) => {
    closeDownloadsPanel() // opening a menu dismisses the downloads panel
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
  if (fxOverlay) fxOverlay.setBounds({ x: 0, y: 0, width: b.width, height: b.height })
  if (downloadsPanel) positionDownloadsPanel()
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
  // Always start on WhatsApp in the right pane — the 2nd Cirqle is created
  // on demand and not restored across restarts.
  state.rightPane = 'whatsapp'

  chrome = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload-ui.js') } })
  chrome.webContents.loadFile(path.join(__dirname, 'host.html'))
  chrome.webContents.once('did-finish-load', () => chrome.webContents.send('state', state))

  wireEscToCloseDownloads(chrome) // Esc from the toolbar view closes the panel too

  cirqle = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload-cirqle.js') } })
  cirqle.webContents.loadURL(CIRQLE_URL)
  wireDownloads(cirqle.webContents.session, 'cirqle') // capture report / invoice / receipt downloads
  wireContextMenu(cirqle, true)                       // Chrome-style right-click menu
  wireEscToCloseDownloads(cirqle)                     // Esc closes the downloads panel
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

function createWhatsappView(id) {
  if (whatsapps[id]) return
  const wa = new WebContentsView({ webPreferences: { partition: `persist:whatsapp:${id}`, preload: path.join(__dirname, 'preload-ui.js') } })
  wa.webContents.setUserAgent(CHROME_UA)
  wa.webContents.loadURL(WHATSAPP_URL, { userAgent: CHROME_UA })
  wireDownloads(wa.webContents.session, 'whatsapp') // images/files saved from WhatsApp land in the common list too
  wireContextMenu(wa, false)                        // Chrome-style right-click menu (Copy Image, etc.)
  wireEscToCloseDownloads(wa)                        // Esc closes the downloads panel
  wa.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) loadError(wa, WHATSAPP_URL, 'whatsapp')
  })
  wa.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  whatsapps[id] = wa
  if (win) win.contentView.addChildView(wa)
  // Keep the downloads catcher + panel on top if they're open when a WA view is added.
  raiseDownloadsPanel()
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
  if (which === 'whatsapp') {
    // The right-pane reload button reloads whatever occupies the right slot.
    if (state.rightPane === 'cirqle2' && cirqle2) cirqle2.webContents.reload()
    else if (whatsapps[state.activeWa]) whatsapps[state.activeWa].webContents.reload()
  }
})
ipcMain.on('goBack', () => { if (cirqle && cirqle.webContents.canGoBack()) cirqle.webContents.goBack() })
ipcMain.on('goForward', () => { if (cirqle && cirqle.webContents.canGoForward()) cirqle.webContents.goForward() })
ipcMain.on('toggleFullscreen', () => { if (win) win.setFullScreen(!win.isFullScreen()) })
// ── Downloads panel ───────────────────────────────────────────────────────────
ipcMain.on('downloads:toggle', toggleDownloadsPanel)
ipcMain.on('downloads:close', closeDownloadsPanel)
ipcMain.on('downloads:open', (_e, id) => { const d = downloads.find((x) => x.id === id); if (d) shell.openPath(d.path) })
ipcMain.on('downloads:reveal', (_e, id) => { const d = downloads.find((x) => x.id === id); if (d) shell.showItemInFolder(d.path) })
ipcMain.on('downloads:remove', (_e, id) => removeDownload(id))
ipcMain.on('downloads:clear', clearDownloads)
ipcMain.on('downloads:openFolder', () => shell.openPath(downloadsDir()))
ipcMain.on('downloads:copy', (_e, id) => {
  const d = downloads.find((x) => x.id === id)
  if (!d) return
  if (isImageFile(d.path)) { const img = nativeImage.createFromPath(d.path); if (!img.isEmpty()) clipboard.writeImage(img); else clipboard.writeText(d.path) }
  else clipboard.writeText(d.path)
})
ipcMain.on('downloads:shareWA', (_e, id) => { const d = downloads.find((x) => x.id === id); if (d) shareFileToWhatsApp(d.path) })
// Native OS file drag from a shelf item → drop onto WhatsApp, Finder, anywhere.
ipcMain.on('downloads:startDrag', async (e, id) => {
  const d = downloads.find((x) => x.id === id)
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
  if (dlCatcher) dlCatcher.setVisible(false)
  try {
    e.sender.startDrag({ file: d.path, icon: await dragIconFor(d.path) })
    console.log('[drag] startDrag issued for', d.name)
  } catch (err) {
    console.error('[drag] startDrag failed with resolved icon, retrying with fallback icon:', err)
    try {
      e.sender.startDrag({ file: d.path, icon: FALLBACK_DRAG_ICON })
    } catch (err2) {
      console.error('[drag] startDrag failed even with fallback icon — giving up:', err2)
      if (dlCatcher) dlCatcher.setVisible(true)
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
      if (dlCatcher) dlCatcher.setVisible(true)
      if (ticks > 130) return
      try {
        const wa = whatsapps[state.activeWa]
        if (!wa || state.rightPane === 'cirqle2' || !state.showWhatsapp) return
        const x = pt.x - cb0.x, y = pt.y - cb0.y
        const wb = wa.getBounds()
        const pb = downloadsPanel ? downloadsPanel.getBounds() : null
        const inWa = x >= wb.x && x <= wb.x + wb.width && y >= wb.y && y <= wb.y + wb.height
        const inPanel = pb && x >= pb.x && x <= pb.x + pb.width && y >= pb.y && y <= pb.y + pb.height
        console.log('[drag] drop-end hit test:', JSON.stringify({ cursor: { x, y }, waBounds: wb, inWa, inPanel }))
        if (inWa && !inPanel) {
          const r = await dropFileIntoWhatsApp(wa, d.path)
          console.log('[drag] synthetic drop result:', JSON.stringify(r))
          if (r.ok) closeDownloadsPanel() // get the shelf out of the way of WhatsApp's attach preview
        }
      } catch (err) {
        console.error('[drag] post-drag WhatsApp handoff failed:', err)
      }
    }
  }, 150)
})

// ── Download flying-animation callbacks ───────────────────────────────────────
ipcMain.on('fx:report-btn', (_e, rect) => { dlBtnRect = rect })
ipcMain.on('fx:done', () => {
  // This flight landed for real — cancel its safety-net timeout so it doesn't
  // double-decrement fxInFlight later.
  const timer = fxTimeouts.shift()
  if (timer) clearTimeout(timer)
  landOneFlight()
})

// ── Duplicate / compare: toggle a 2nd Cirqle page in the right pane ───────────
ipcMain.on('cirqle:compareToggle', () => {
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
  if (chrome) chrome.webContents.send('state', state)
})

// ── Share (from the Cirqle pane → the linked WhatsApp pane) ────────────────────
// action: 'copy' (copy image + focus WA), 'paste' (auto-paste into open chat),
// 'download' (save into common downloads + reveal in Finder to drag in).
ipcMain.handle('share:receipt', (_e, { dataUrl, filename, action } = {}) => {
  if (action === 'download') {
    const p = saveDataUrlToDownloads(dataUrl, filename)
    if (p) { focusWhatsapp(); shell.showItemInFolder(p) }
    return { ok: !!p, action: 'download', path: p }
  }
  const img = dataUrlToImage(dataUrl)
  if (!img || img.isEmpty()) return { ok: false, reason: 'bad-image' }
  const r = shareImageToWhatsApp(img, { autoPaste: action === 'paste' })
  return { ...r, action }
})
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
  // Clicking a WhatsApp tab always brings WhatsApp back into the right pane,
  // even if it was showing a 2nd Cirqle page.
  state.rightPane = 'whatsapp'
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
  closeDownloadsPanel() // only one floating layer at a time
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

// macOS: closing the window should hide it (keep the app + all views alive in
// the dock) rather than destroy it. Destroying leaves no window for the dock
// click to reopen — the previous behavior forced a full quit + relaunch.
let quitting = false

app.whenReady().then(() => {
  loadDownloads() // restore the downloads history (files that still exist on disk)
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
app.on('will-quit', () => globalShortcut.unregisterAll())

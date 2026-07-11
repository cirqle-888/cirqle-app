'use strict'

/**
 * WhatsApp domain: the multi-account WhatsApp Web panes and everything that
 * shares INTO them — clipboard-image share, composer auto-paste, and the
 * synthetic file drop (startDrag can't deliver into the same app's views).
 *
 * Pure extraction from main.js — behavior unchanged. The `whatsapps` map is
 * exported by reference so existing call sites keep their exact shape;
 * layout/menu/window needs are injected via init() as lazy getters.
 */
const { WebContentsView, clipboard, nativeImage, shell } = require('electron')
const path = require('path')
const fs = require('fs')

const { state } = require('./settings')
const dl = require('./downloads')

const deps = {
  getWin: () => null,
  sendStateToChrome: () => {},
  applyPreset: () => {},
  layout: () => {},
  wireContextMenu: () => {},
  loadError: () => {},
}
function init(d) { Object.assign(deps, d) }

const whatsapps = {} // keyed by id

const WHATSAPP_URL = 'https://web.whatsapp.com/'
// A current desktop Chrome UA — WhatsApp Web rejects Electron's default UA
// ("update your browser"). The single most common reason these wrappers fail.
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'


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
  if (!state.showWhatsapp) deps.applyPreset(state.showCirqle ? '50' : 'hideCirqle')
  else if (wasComparing) { deps.layout(); saveSettings(); deps.sendStateToChrome() }
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
    if (dl.isImageFile(filePath)) {
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

function createWhatsappView(id) {
  if (whatsapps[id]) return
  const wa = new WebContentsView({ webPreferences: { partition: `persist:whatsapp:${id}`, preload: path.join(__dirname, '..', 'preload-ui.js') } })
  wa.webContents.setUserAgent(CHROME_UA)
  wa.webContents.loadURL(WHATSAPP_URL, { userAgent: CHROME_UA })
  dl.wireDownloads(wa.webContents.session, 'whatsapp') // images/files saved from WhatsApp land in the common list too
  deps.wireContextMenu(wa, false)                        // Chrome-style right-click menu (Copy Image, etc.)
  dl.wireEscToCloseDownloads(wa)                        // Esc closes the downloads panel
  wa.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) deps.loadError(wa, WHATSAPP_URL, 'whatsapp')
  })
  wa.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  whatsapps[id] = wa
  const w = deps.getWin(); if (w) w.contentView.addChildView(wa)
  // Keep the downloads catcher + panel on top if they're open when a WA view is added.
  dl.raiseDownloadsPanel()
}


module.exports = {
  init,
  whatsapps,
  WHATSAPP_URL,
  CHROME_UA,
  focusWhatsapp,
  pasteIntoWhatsappComposer,
  shareImageToWhatsApp,
  shareFileToWhatsApp,
  dropFileIntoWhatsApp,
  createWhatsappView,
}

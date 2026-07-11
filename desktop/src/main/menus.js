'use strict'

/**
 * Menus: the native application menu (Capture / Edit / Downloads / View) and
 * the Chrome-style context menu wired onto every pane.
 *
 * Pure extraction from main.js — behavior unchanged. Capture/navigation
 * actions and the clipboard history live with their owners and are injected.
 */
const { Menu, clipboard, shell } = require('electron')

const { state } = require('./settings')
const dl = require('./downloads')
const wa = require('./whatsapp')
const { applyPreset: applyPresetL } = require('./layout')

const FILE_URL_RE = /\.(pdf|xlsx?|csv|docx?|pptx?|png|jpe?g|zip)(\?|#|$)/i

const deps = {
  getWin: () => null,
  reloadCirqle: () => {},
  sendTextToCirqle: () => {},
  sendClipboardToCirqle: () => {},
  navigate: () => {},
  getClipHistory: () => [],
}
function init(d) { Object.assign(deps, d) }

const QUICK_ACTIONS = [
  { label: 'Request / Quick Capture', route: '/dashboard/capture' },
  { label: 'Client', route: '/dashboard/clients' },
  { label: 'Task', route: '/dashboard/tasks' },
  { label: 'Offer', route: '/dashboard/apps/offer-intake' },
  { label: 'Invoice', route: '/dashboard/invoices' },
  { label: 'Quotation', route: '/dashboard/quotations' },
]



const truncate = (s, n = 60) => { const one = String(s).replace(/\s+/g, ' ').trim(); return one.length > n ? one.slice(0, n) + '…' : one }


// ── Context menu (both panes, context-aware — Chrome/Safari style) ─────────────
function wireContextMenu(view, isCirqle) {
  view.webContents.on('context-menu', (_e, params) => {
    dl.closeDownloadsPanel() // opening a menu dismisses the downloads panel
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
          click: () => { wc.copyImageAt(params.x, params.y); setTimeout(() => { const wa = wa.focusWhatsapp(); wa.pasteIntoWhatsappComposer(wa) }, 120) },
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
    Menu.buildFromTemplate(items).popup({ window: deps.getWin() })
  })
}


// Native menu — unclipped, so clipboard history + New-record shortcuts live here
// (a dropdown inside the 48px toolbar view would be clipped to its bounds).
function buildMenu() {
  const recent = deps.getClipHistory().length
    ? deps.getClipHistory().map((h) => ({ label: truncate(h), click: () => deps.sendTextToCirqle(h) }))
    : [{ label: '(clipboard history is empty)', enabled: false }]

  const menu = Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'Capture',
      submenu: [
        { label: 'New Request from Clipboard', accelerator: 'CmdOrCtrl+Shift+N', click: deps.sendClipboardToCirqle },
        { label: 'Recent Clipboard', submenu: recent },
        { type: 'separator' },
        { label: 'New', submenu: QUICK_ACTIONS.map((a) => ({ label: a.label, click: () => deps.navigate(a.route) })) },
      ],
    },
    // REQUIRED on macOS: without the Edit menu's roles, Cmd+C / Cmd+V don't work
    // in the web views — which would break the entire copy-paste workflow.
    { role: 'editMenu' },
    { label: 'Downloads', submenu: dl.downloadsMenuTemplate() },
    {
      label: 'View',
      submenu: [
        { label: 'Reload Cirqle', accelerator: 'CmdOrCtrl+R', click: () => deps.reloadCirqle() },
        { label: 'Reload WhatsApp', click: () => wa.whatsapps[state.activeWa] && wa.whatsapps[state.activeWa].webContents.reload() },
        { type: 'separator' },
        { label: 'Split 50 / 50', click: () => applyPresetL('50') },
        { label: 'Cirqle 75 / WhatsApp 25', click: () => applyPresetL('75') },
        { label: 'Cirqle 25 / WhatsApp 75', click: () => applyPresetL('25') },
        { label: 'Hide WhatsApp', click: () => applyPresetL('hideWA') },
        { label: 'Hide Cirqle', click: () => applyPresetL('hideCirqle') },
        { type: 'separator' },
        { label: 'Toggle Toolbar', accelerator: 'CmdOrCtrl+T', click: () => applyPresetL('toggleToolbar') },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ])
  Menu.setApplicationMenu(menu)
}


module.exports = { init, buildMenu, wireContextMenu, truncate, FILE_URL_RE, QUICK_ACTIONS }

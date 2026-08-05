'use strict'

/**
 * Layout engine: positions the toolbar, panes, and splitters from window size
 * + the ordered `state.panes` / `state.sizes` model (1..4 panes, see
 * settings.js). Presets and pane add/remove/resize all live here.
 *
 * Views themselves live in main.js / whatsapp.js and are resolved lazily via
 * injected getters, so a pane can exist in state before its (expensive) web
 * view has been created — that's what makes WhatsApp lazy-loading work.
 */
const CH = require('../shared/ipc-channels')
const { state, saveSettings } = require('./settings')
const dl = require('./downloads')
const { whatsapps } = require('./whatsapp')

const deps = {
  getWin: () => null,
  getChrome: () => null,
  getCirqle: () => null,
  getCirqle2: () => null,
  getWebs: () => ({}),
  getSplitters: () => [],
  getOverlay: () => null,
  /** Ask main.js to create the view backing a pane id (lazy). */
  ensureView: () => {},
  /** Ask main.js to keep exactly n splitter views alive. */
  ensureSplitters: () => {},
}
function init(d) { Object.assign(deps, d) }

const TOOLBAR_H = 48
const SPLITTER_W = 6
const MIN_RATIO = 0.2   // legacy two-pane drag bounds (kept for callers)
const MAX_RATIO = 0.8
const MIN_PANE = 0.12   // no pane may shrink below 12% of the window
const MAX_PANES = 4

// ── Pane helpers ─────────────────────────────────────────────────────────────
function viewFor(pane) {
  if (pane === 'cirqle') return deps.getCirqle()
  if (pane === 'cirqle2') return deps.getCirqle2()
  if (pane.startsWith('wa:')) return whatsapps[pane.slice(3)] || null
  if (pane.startsWith('web:')) return deps.getWebs()[pane.slice(4)] || null
  return null
}

function normalizeSizes() {
  if (!Array.isArray(state.sizes) || state.sizes.length !== state.panes.length) {
    state.sizes = state.panes.map(() => 1 / state.panes.length)
  }
  const total = state.sizes.reduce((a, b) => a + b, 0) || 1
  state.sizes = state.sizes.map(s => Math.max(0.01, s / total))
}

/**
 * Keep the legacy two-slot flags coherent with the pane list. Several modules
 * (share-to-WhatsApp, notifications, the downloads drag hit-test) still read
 * these; they must never disagree with what's actually on screen.
 */
function syncLegacy() {
  state.showCirqle = state.panes.includes('cirqle')
  const waPane = state.panes.find(p => p.startsWith('wa:'))
  state.showWhatsapp = !!waPane || state.panes.includes('cirqle2')
  state.rightPane = state.panes.includes('cirqle2') ? 'cirqle2' : 'whatsapp'
  if (waPane) state.activeWa = waPane.slice(3)
  if (state.panes.length === 2) state.ratio = state.sizes[0]
  const webPanes = state.panes.filter(p => p.startsWith('web:')).map(p => p.slice(4))
  if (webPanes.length && !webPanes.includes(state.activeWeb)) state.activeWeb = webPanes[0]
  if (!webPanes.length) state.activeWeb = null
}

function broadcast() {
  const c = deps.getChrome()
  if (c) c.webContents.send(CH.STATE, state)
}

// ── Layout: position every view from window size + panes + sizes ────────────
function layout() {
  const win = deps.getWin()
  if (!win) return
  normalizeSizes()
  const b = win.getContentBounds()
  const currentToolbarH = state.showToolbar ? TOOLBAR_H : 0
  const bodyY = currentToolbarH
  const bodyH = b.height - currentToolbarH

  if (state.showToolbar) {
    deps.getChrome().setBounds({ x: 0, y: 0, width: b.width, height: TOOLBAR_H })
    deps.getChrome().setVisible(true)
  } else {
    deps.getChrome().setVisible(false)
  }

  // Hide everything first, then place + show only the panes in the list.
  for (const id in whatsapps) whatsapps[id].setVisible(false)
  const webs = deps.getWebs()
  for (const id in webs) webs[id].setVisible(false)
  if (deps.getCirqle()) deps.getCirqle().setVisible(false)
  if (deps.getCirqle2()) deps.getCirqle2().setVisible(false)

  const n = state.panes.length
  deps.ensureSplitters(Math.max(0, n - 1))
  const splitters = deps.getSplitters()
  splitters.forEach(s => s.setVisible(false))

  const innerW = b.width - SPLITTER_W * (n - 1)
  let x = 0
  state.panes.forEach((pane, i) => {
    const w = i === n - 1 ? b.width - x : Math.round(innerW * state.sizes[i])
    deps.ensureView(pane)
    const v = viewFor(pane)
    if (v) {
      v.setBounds({ x, y: bodyY, width: w, height: bodyH })
      v.setVisible(true)
    }
    x += w
    if (i < n - 1 && splitters[i]) {
      splitters[i].setBounds({ x, y: bodyY, width: SPLITTER_W, height: bodyH })
      splitters[i].setVisible(true)
      x += SPLITTER_W
    }
  })

  if (deps.getOverlay()) deps.getOverlay().setBounds({ x: 0, y: bodyY, width: b.width, height: bodyH })
  dl.onLayout()
}

// ── Pane mutations ───────────────────────────────────────────────────────────
function commit() {
  syncLegacy()
  layout()
  saveSettings()
  broadcast()
}

/** Add a pane (right end by default; front:true for Cirqle's home slot). */
function addPane(pane, { front = false } = {}) {
  if (state.panes.includes(pane)) return false
  if (state.panes.length >= MAX_PANES) return false
  // New pane takes an equal share, squeezed proportionally from the others.
  const share = 1 / (state.panes.length + 1)
  state.sizes = state.sizes.map(s => s * (1 - share))
  if (front) { state.panes.unshift(pane); state.sizes.unshift(share) }
  else { state.panes.push(pane); state.sizes.push(share) }
  commit()
  return true
}

/** Remove a pane; the freed width folds into its left neighbour. */
function removePane(pane) {
  const i = state.panes.indexOf(pane)
  if (i === -1) return false
  if (state.panes.length === 1) return false // never an empty window
  state.panes.splice(i, 1)
  const freed = state.sizes.splice(i, 1)[0]
  state.sizes[Math.max(0, i - 1)] += freed
  commit()
  return true
}

/** Swap one pane id for another in place (same slot + width). */
function replacePane(from, to) {
  const i = state.panes.indexOf(from)
  if (i === -1) return false
  state.panes[i] = to
  commit()
  return true
}

/** Drag the boundary between pane i and i+1 to window fraction `frac`. */
function dragBoundary(i, frac) {
  if (i < 0 || i >= state.panes.length - 1) return
  const before = state.sizes.slice(0, i).reduce((a, b) => a + b, 0)
  const pair = state.sizes[i] + state.sizes[i + 1]
  let left = frac - before
  left = Math.max(MIN_PANE, Math.min(pair - MIN_PANE, left))
  state.sizes[i] = left
  state.sizes[i + 1] = pair - left
  if (state.panes.length === 2) state.ratio = state.sizes[0]
  layout()
}

// ── Presets (toolbar segmented control + menu) ───────────────────────────────
// The named presets are deliberately two-pane arrangements: they collapse any
// wider split back to Cirqle + the active WhatsApp — the "get me home" gesture.
function applyPreset(p) {
  const waPane = `wa:${state.activeWa || (state.waAccounts[0] && state.waAccounts[0].id) || 'default'}`
  if (p === '50') { state.panes = ['cirqle', waPane]; state.sizes = [0.5, 0.5] }
  else if (p === '75') { state.panes = ['cirqle', waPane]; state.sizes = [0.75, 0.25] }
  else if (p === '25') { state.panes = ['cirqle', waPane]; state.sizes = [0.25, 0.75] }
  else if (p === 'hideWA') { state.panes = ['cirqle']; state.sizes = [1] }
  else if (p === 'hideCirqle') { state.panes = [waPane]; state.sizes = [1] }
  else if (p === 'toggleToolbar') { state.showToolbar = !state.showToolbar }
  commit()
}

module.exports = {
  init, layout, applyPreset,
  addPane, removePane, replacePane, dragBoundary,
  syncLegacy, viewFor, broadcast,
  TOOLBAR_H, SPLITTER_W, MIN_RATIO, MAX_RATIO, MAX_PANES,
}

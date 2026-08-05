'use strict'

/**
 * Persisted layout state (a tiny JSON file; avoids an ESM-only dependency).
 *
 * `state` is the single mutable layout object shared across the main process —
 * modules mutate it directly and call saveSettings() (best-effort write).
 * Loaded synchronously at require time, exactly as the pre-split main.js did.
 *
 * ── Pane model ──────────────────────────────────────────────────────────────
 * `panes`  — ordered list of what's on screen, left to right (1..4 entries):
 *              'cirqle'   the main Cirqle pane
 *              'cirqle2'  the duplicated Cirqle pane (compare)
 *              'wa:<id>'  a WhatsApp account pane
 *              'web:<id>' a built-in browser pane
 * `sizes`  — width fraction per pane, same length as `panes`, sums to ~1.
 *
 * The old two-slot flags (showCirqle / showWhatsapp / ratio / rightPane) are
 * DERIVED from `panes` by layout.syncLegacy() and kept only because several
 * modules (share-to-WhatsApp, notifications, drag-drop hit tests) still read
 * them. Never write them directly — mutate `panes` and re-sync.
 */
const { app } = require('electron')
const path = require('path')
const fs = require('fs')

const settingsFile = () => path.join(app.getPath('userData'), 'layout.json')
const loadSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) } catch { return {} } }

const state = Object.assign({
  ratio: 0.5,
  showCirqle: true,
  showWhatsapp: true,   // derived: is any wa:/cirqle2 pane visible (see header)
  showToolbar: true,
  rightPane: 'whatsapp', // derived: 'cirqle2' when comparing, else 'whatsapp'
  waAccounts: [{ id: 'default', label: 'WA 1' }], // + per-account: muted, paused
  activeWa: 'default',
  panes: null,           // migrated below when absent
  sizes: null,
  webTabs: [],           // [{ id, label, url }] — built-in browser tabs
  webSeq: 1,             // next browser tab number (for ids + default labels)
  activeWeb: null,       // which web tab the toolbar URL bar targets
}, loadSettings())

// ── Migration from the two-slot model ────────────────────────────────────────
if (!Array.isArray(state.panes) || state.panes.length === 0) {
  const panes = []
  if (state.showCirqle !== false) panes.push('cirqle')
  if (state.showWhatsapp !== false) panes.push(`wa:${state.activeWa || 'default'}`)
  if (panes.length === 0) panes.push('cirqle')
  state.panes = panes
  state.sizes = panes.length === 2 ? [state.ratio ?? 0.5, 1 - (state.ratio ?? 0.5)] : [1]
}
if (!Array.isArray(state.sizes) || state.sizes.length !== state.panes.length) {
  state.sizes = state.panes.map(() => 1 / state.panes.length)
}
// A stale 'cirqle2' pane from a previous run has no view to restore into.
if (state.panes.includes('cirqle2')) {
  const i = state.panes.indexOf('cirqle2')
  state.panes.splice(i, 1); state.sizes.splice(i, 1)
  const total = state.sizes.reduce((a, b) => a + b, 0) || 1
  state.sizes = state.sizes.map(s => s / total)
}

const saveSettings = () => { try { fs.writeFileSync(settingsFile(), JSON.stringify(state)) } catch { /* best effort */ } }

module.exports = { state, saveSettings }

'use strict'

/**
 * Persisted layout state (a tiny JSON file; avoids an ESM-only dependency).
 *
 * `state` is the single mutable layout object shared across the main process —
 * modules mutate it directly and call saveSettings() (best-effort write).
 * Loaded synchronously at require time, exactly as the pre-split main.js did.
 */
const { app } = require('electron')
const path = require('path')
const fs = require('fs')

const settingsFile = () => path.join(app.getPath('userData'), 'layout.json')
const loadSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) } catch { return {} } }

const state = Object.assign({
  ratio: 0.5,
  showCirqle: true,
  showWhatsapp: true,   // structurally: "show the RIGHT pane" (WhatsApp or 2nd Cirqle)
  showToolbar: true,
  rightPane: 'whatsapp', // 'whatsapp' | 'cirqle2' — what occupies the right slot
  waAccounts: [{ id: 'default', label: 'WA 1' }],
  activeWa: 'default'
}, loadSettings())

const saveSettings = () => { try { fs.writeFileSync(settingsFile(), JSON.stringify(state)) } catch { /* best effort */ } }

module.exports = { state, saveSettings }

'use strict'
const { state, saveSettings } = require('./settings')
const layout = require('./layout')
function validPane(pane) {
  if (['cirqle', 'cirqle2', 'studio', 'studio2'].includes(pane)) return true
  if (typeof pane !== 'string') return false
  if (pane.startsWith('wa:')) return state.waAccounts.some(a => a.id === pane.slice(3))
  if (pane.startsWith('web:')) return state.webTabs.some(t => t.id === pane.slice(4))
  return false
}
function save(name) {
  const clean = typeof name === 'string' ? name.trim().slice(0, 60) : ''
  if (!clean) return { ok: false, reason: 'Enter a name for this layout.' }
  const existing = state.savedWorkspaces.find(w => w.name.toLowerCase() === clean.toLowerCase())
  const workspace = { id: existing?.id || String(Date.now()), name: clean, panes: [...state.panes], sizes: [...state.sizes] }
  if (existing) Object.assign(existing, workspace)
  else {
    if (state.savedWorkspaces.length >= 20) return { ok: false, reason: 'Remove a saved layout before adding another.' }
    state.savedWorkspaces.push(workspace)
  }
  saveSettings(); layout.broadcast()
  return { ok: true, name: clean }
}
function apply(workspace) {
  if (!workspace || !Array.isArray(workspace.panes)) return false
  const pairs = workspace.panes.map((pane, i) => ({ pane, size: workspace.sizes?.[i] }))
    .filter((pair, i, all) => validPane(pair.pane) && all.findIndex(p => p.pane === pair.pane) === i).slice(0, layout.MAX_PANES)
  if (!pairs.length) return false
  state.clientWorkspace = null
  state.panes = pairs.map(p => p.pane)
  state.sizes = pairs.map(p => p.size)
  state.expandedPane = null
  for (const pane of state.panes) if (pane.startsWith('wa:')) state.waAccounts.find(a => a.id === pane.slice(3)).paused = false
  layout.commit()
  return true
}
function presets() {
  const wa = `wa:${state.activeWa || state.waAccounts[0]?.id || 'default'}`
  return [
    { name: 'Cirqle + WhatsApp', panes: ['cirqle', wa], sizes: [.5, .5] },
    { name: 'Flyer work', panes: [wa, 'studio'], sizes: [.4, .6] },
    { name: 'Accounts', panes: ['cirqle', wa], sizes: [.7, .3] },
    { name: 'Cirqle only', panes: ['cirqle'], sizes: [1] },
  ]
}
function remove(id) { state.savedWorkspaces = state.savedWorkspaces.filter(w => w.id !== id); saveSettings(); layout.broadcast() }
function expand(pane) {
  if (!state.panes.includes(pane)) return false
  state.expandedPane = state.expandedPane === pane ? null : pane
  layout.layout(); layout.broadcast()
  return true
}
module.exports = { save, apply, presets, remove, expand, validPane }

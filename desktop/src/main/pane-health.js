'use strict'
const { dialog } = require('electron')
const path = require('path')
const { state } = require('./settings')
const layout = require('./layout')
const views = new Map()
let deps = { getWin: () => null }
function init(d) { Object.assign(deps, d) }
function publish(pane, status) { state.paneStatus[pane] = status; layout.broadcast() }
function wire(view, pane, home) {
  const wc = view.webContents
  const record = { view, pane, home, lastUrl: home, failed: false, showingError: false }
  views.set(wc.id, record)
  wc.on('did-start-loading', () => {
    if (!record.showingError) { record.failed = false; publish(pane, { state: 'loading', label: 'Loading…' }) }
  })
  wc.on('did-navigate', (_e, url) => {
    if (/^https?:/.test(url)) { record.lastUrl = url; state.saveStatus[pane] = null }
  })
  wc.on('did-stop-loading', () => {
    if (!record.failed && !record.showingError) publish(pane, { state: 'ready', label: 'Ready' })
  })
  wc.on('did-fail-load', (_e, code, description, url, mainFrame) => {
    if (!mainFrame || code === -3 || record.showingError) return
    if (/^https?:/.test(url)) record.lastUrl = url
    showError(record, code === -106 ? 'offline' : 'error', code === -106 ? 'Offline' : 'Could not load')
  })
  wc.on('render-process-gone', () => showError(record, 'error', 'Pane stopped · retry'))
  wc.on('unresponsive', () => publish(pane, { state: 'error', label: 'Not responding · retry' }))
  wc.on('responsive', () => { if (!record.failed) publish(pane, { state: 'ready', label: 'Ready' }) })
  wc.on('will-prevent-unload', event => {
    const answer = dialog.showMessageBoxSync(deps.getWin(), { type: 'warning', message: 'Changes may not be saved', detail: 'Stay on this page to let it finish saving.', buttons: ['Stay', 'Leave page'], defaultId: 0, cancelId: 0 })
    if (answer === 1) event.preventDefault()
  })
  wc.once('destroyed', () => { views.delete(wc.id); delete state.paneStatus[pane]; delete state.saveStatus[pane] })
  return record
}
function showError(record, status, label) {
  record.failed = true
  publish(record.pane, { state: status, label })
  if (record.showingError || record.view.webContents.isDestroyed()) return
  record.showingError = true
  record.view.webContents.loadFile(path.join(__dirname, '..', 'error.html'), { query: { url: record.lastUrl, pane: record.pane, reason: label } }).catch(() => {})
}
function retry(pane, sender) {
  const record = sender ? views.get(sender.id) : [...views.values()].find(r => r.pane === pane)
  if (!record) return false
  record.showingError = false; record.failed = false
  state.saveStatus[record.pane] = null
  publish(record.pane, { state: 'loading', label: 'Loading…' })
  record.view.webContents.loadURL(record.lastUrl || record.home).catch(() => {})
  return true
}
function report(sender, value) {
  const record = views.get(sender.id)
  if (!record || !['studio', 'studio2'].includes(record.pane)) return
  if (!['idle', 'saving', 'saved', 'error', 'conflict'].includes(value?.state)) return
  state.saveStatus[record.pane] = { state: value.state, dirty: value.dirty === true, label: String(value.label || '').slice(0, 90) }
  layout.broadcast()
}
async function confirmClose(panes) {
  // Read the existing sheet status as a fallback for older hosted Flyer versions.
  for (const pane of panes) {
    if (!pane.startsWith('studio')) continue
    const record = [...views.values()].find(r => r.pane === pane)
    if (!record || record.failed) continue
    try {
      const status = await Promise.race([
        record.view.webContents.executeJavaScript(`(() => {
          const el = document.querySelector('[data-desktop-save-state]') || [...document.querySelectorAll('[role="status"]')].find(el => /saving|not saved|conflicting|synced|saved/i.test(el.textContent || ''))
          if (!el) return null
          const label = el.textContent.trim()
          const dirty = el.dataset.desktopDirty === 'true' || /saving|not saved|conflicting/i.test(label)
          return { dirty, label }
        })()`), new Promise(resolve => setTimeout(() => resolve(null), 1200)),
      ])
      if (status) state.saveStatus[pane] = { ...state.saveStatus[pane], ...status }
    } catch {}
  }
  const dirty = panes.filter(pane => state.saveStatus[pane]?.dirty)
  if (!dirty.length) return true
  const answer = await dialog.showMessageBox(deps.getWin(), {
    type: 'warning', message: 'Flyer changes are not saved yet',
    detail: 'Keep the pane open until it says Saved. Closing a pane keeps its page in memory, but quitting can lose unsaved changes.',
    buttons: ['Keep open', 'Continue anyway'], defaultId: 0, cancelId: 0,
  })
  return answer.response === 1
}
module.exports = { init, wire, retry, report, confirmClose, views }

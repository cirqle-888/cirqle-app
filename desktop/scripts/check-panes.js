#!/usr/bin/env node
'use strict'
/**
 * Pane-model guard, in the spirit of check-ipc-channels.js: load the real
 * layout + settings modules against a stubbed `electron` and assert the rules
 * the split system depends on. Runs before every pack/dmg.
 *
 * It exists because of a shipped bug. The Offer Studio pane was added to
 * layout()'s placement path but not to its hide sweep, so closing the split
 * left the view painted at its old bounds, floating over the panes that
 * re-laid out underneath it. Both now read one registry (SINGLETON_PANES),
 * and the last check here fails if that ever drifts apart again.
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const assert = require('assert')
const Module = require('module')

const ROOT = path.join(__dirname, '..')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cirqle-panes-'))

// A saved layout that already has both Studio panes: this is the restart case.
fs.writeFileSync(path.join(userData, 'layout.json'), JSON.stringify({
  panes: ['cirqle', 'studio', 'studio2'],
  sizes: [0.34, 0.33, 0.33],
  waAccounts: [{ id: 'default', label: 'WA 1' }],
  activeWa: 'default',
  webTabs: [],
  showToolbar: true,
}))

// ── Stub `electron` so the main-process modules load under plain node ───────
const noop = () => {}
const anything = new Proxy({}, { get: () => noop })
const electron = {
  app: { getPath: () => userData, getName: () => 'x', getVersion: () => '0', on: noop, whenReady: () => Promise.resolve() },
  ipcMain: { on: noop, handle: noop, emit: noop },
  session: { fromPartition: () => anything, defaultSession: anything },
  shell: anything,
  clipboard: anything,
  Menu: { buildFromTemplate: () => anything, setApplicationMenu: noop },
  MenuItem: function () {},
  nativeImage: anything,
  dialog: anything,
  net: anything,
  screen: anything,
  BrowserWindow: function () {},
  BaseWindow: function () {},
  WebContentsView: function () {},
  Notification: function () {},
}
const realResolve = Module._resolveFilename
Module._resolveFilename = function (req, ...rest) {
  return req === 'electron' ? 'electron-stub' : realResolve.call(this, req, ...rest)
}
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: electron }

const { state } = require(path.join(ROOT, 'src/main/settings.js'))
const layoutMod = require(path.join(ROOT, 'src/main/layout.js'))

// ── Fake views that just record what layout() did to them ───────────────────
const WIN_W = 1600, WIN_H = 1000
const WIN = { getContentBounds: () => ({ x: 0, y: 0, width: WIN_W, height: WIN_H }) }
require(path.join(ROOT, 'src/main/downloads.js')).init({ getWin: () => WIN })

const mk = (tag) => ({
  tag, visible: null, bounds: null,
  setVisible(v) { this.visible = v },
  setBounds(b) { this.bounds = b },
})
const CHROME = Object.assign(mk('chrome'), { webContents: { send: noop } })
const views = { cirqle: mk('cirqle'), cirqle2: mk('cirqle2'), studio: mk('studio'), studio2: mk('studio2') }

layoutMod.init({
  getWin: () => WIN,
  getChrome: () => CHROME,
  getCirqle: () => views.cirqle,
  getCirqle2: () => views.cirqle2,
  getStudio: () => views.studio,
  getStudio2: () => views.studio2,
  getWebs: () => ({}),
  getSplitters: () => [],
  getOverlay: () => null,
  ensureView: noop,
  ensureSplitters: noop,
})

const reset = () => { state.panes = ['cirqle']; state.sizes = [1] }

// 1. A saved Studio pane survives a restart; only 'cirqle2' is stripped.
assert.deepStrictEqual(state.panes, ['cirqle', 'studio', 'studio2'],
  'a saved Studio pane must come back with the window')

// 2. Add / duplicate / cap / remove behave for every pane id.
reset()
assert.strictEqual(layoutMod.addPane('studio'), true)
assert.strictEqual(layoutMod.addPane('studio2'), true)
assert.strictEqual(layoutMod.addPane('studio2'), false, 'the same pane must not open twice')
assert.strictEqual(layoutMod.addPane('wa:default'), true)
assert.strictEqual(layoutMod.addPane('web:1'), false, `MAX_PANES must cap the window at ${layoutMod.MAX_PANES}`)
assert.ok(Math.abs(state.sizes.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'pane widths must sum to 1')

// 3. THE REGRESSION: closing a split must take its view off screen.
for (const id of ['cirqle2', 'studio', 'studio2']) {
  reset()
  layoutMod.addPane(id)
  assert.strictEqual(views[id].visible, true, `${id} should be visible while open`)
  assert.ok(views[id].bounds && views[id].bounds.width > 0, `${id} should be placed`)
  layoutMod.removePane(id)
  assert.strictEqual(views[id].visible, false,
    `${id} MUST be hidden when its split closes — otherwise it stays painted over the rest`)
  assert.strictEqual(views.cirqle.visible, true, 'the remaining pane stays up')
  assert.strictEqual(views.cirqle.bounds.width, WIN_W, 'and reclaims the full width')
}

// 4. Two Studio panes: closing one must not paint over, or take down, the other.
reset()
layoutMod.addPane('studio')
layoutMod.addPane('studio2')
layoutMod.removePane('studio')
assert.strictEqual(views.studio.visible, false, 'closing pane 1 must not leave it painted')
assert.strictEqual(views.studio2.visible, true, 'and must not take pane 2 down with it')

console.log(`panes OK — ${Object.keys(views).length} single-instance panes place, hide and cap correctly`)

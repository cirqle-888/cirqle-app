'use strict'

/**
 * Layout engine: positions the toolbar, panes, and splitter from window size
 * + ratio + visibility state, and applies the named presets.
 *
 * Pure extraction from main.js — behavior unchanged. Views still live in
 * main.js (window management module comes later), injected as lazy getters.
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
  getSplitter: () => null,
  getOverlay: () => null,
}
function init(d) { Object.assign(deps, d) }

const TOOLBAR_H = 48
const SPLITTER_W = 6
const MIN_RATIO = 0.2
const MAX_RATIO = 0.8


// ── Layout: position each view from the window size + ratio + visibility ──────
function layout() {
  if (!deps.getWin()) return
  const b = deps.getWin().getContentBounds()
  const currentToolbarH = state.showToolbar ? TOOLBAR_H : 0
  const bodyY = currentToolbarH
  const bodyH = b.height - currentToolbarH
  
  if (state.showToolbar) {
    deps.getChrome().setBounds({ x: 0, y: 0, width: b.width, height: currentToolbarH })
    deps.getChrome().setVisible(true)
  } else {
    deps.getChrome().setVisible(false)
  }

  const both = state.showCirqle && state.showWhatsapp

  // Hide every right-slot candidate first (all WhatsApp views + the 2nd Cirqle),
  // then show only the one the user has selected for the right pane.
  for (const id in whatsapps) whatsapps[id].setVisible(false)
  if (deps.getCirqle2()) deps.getCirqle2().setVisible(false)

  const activeRight = (state.rightPane === 'deps.getCirqle2()' && deps.getCirqle2()) ? deps.getCirqle2() : whatsapps[state.activeWa]

  if (both) {
    const splitX = Math.round(b.width * state.ratio)
    deps.getCirqle().setBounds({ x: 0, y: bodyY, width: splitX - SPLITTER_W / 2, height: bodyH })
    deps.getSplitter().setBounds({ x: splitX - SPLITTER_W / 2, y: bodyY, width: SPLITTER_W, height: bodyH })
    if (activeRight) activeRight.setBounds({ x: splitX + SPLITTER_W / 2, y: bodyY, width: b.width - splitX - SPLITTER_W / 2, height: bodyH })
    deps.getSplitter().setVisible(true)
  } else {
    deps.getSplitter().setVisible(false)
    if (state.showCirqle) {
      deps.getCirqle().setBounds({ x: 0, y: bodyY, width: b.width, height: bodyH })
    } else if (state.showWhatsapp && activeRight) {
      activeRight.setBounds({ x: 0, y: bodyY, width: b.width, height: bodyH })
    }
  }

  deps.getCirqle().setVisible(state.showCirqle)
  if (state.showWhatsapp && activeRight) activeRight.setVisible(true)
  if (deps.getOverlay()) deps.getOverlay().setBounds({ x: 0, y: bodyY, width: b.width, height: bodyH })
  dl.onLayout()
}

function applyPreset(p) {
  if (p === '50') Object.assign(state, { ratio: 0.5, showCirqle: true, showWhatsapp: true })
  else if (p === '75') Object.assign(state, { ratio: 0.75, showCirqle: true, showWhatsapp: true })
  else if (p === '25') Object.assign(state, { ratio: 0.25, showCirqle: true, showWhatsapp: true })
  else if (p === 'hideWA') Object.assign(state, { showWhatsapp: false, showCirqle: true })
  else if (p === 'hideCirqle') Object.assign(state, { showCirqle: false, showWhatsapp: true })
  else if (p === 'toggleToolbar') Object.assign(state, { showToolbar: !state.showToolbar })
  layout(); saveSettings()
  if (deps.getChrome()) deps.getChrome().webContents.send(CH.STATE, state)
}


module.exports = { init, layout, applyPreset, TOOLBAR_H, SPLITTER_W, MIN_RATIO, MAX_RATIO }

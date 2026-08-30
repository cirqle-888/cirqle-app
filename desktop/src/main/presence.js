'use strict'

/**
 * Presence domain: tells the Cirqle web view whether the PERSON is at the
 * machine, which on a desktop app is a different question from whether the
 * window is on screen.
 *
 * The web app's presence feature (src/lib/presence) decides who shows as
 * Available by whether a heartbeat arrived recently. In a browser tab it gates
 * that heartbeat on page visibility, which is right there and badly wrong here:
 * this app spends most of its life docked, behind an editor, or on another
 * Space while its owner sits in front of it. Gating on visibility marked people
 * Away minutes after they clicked into another window.
 *
 * So the shell answers from the OS instead — seconds since the last input, and
 * whether the screen is locked — exactly what Teams and Slack use. The web app
 * asks once a minute over `presence:query`; there is no push channel, because a
 * minute of granularity sits well inside the three-minute window the web app
 * already allows before it calls anyone Away.
 */
const { ipcMain, powerMonitor } = require('electron')

const CH = require('../shared/ipc-channels')

// powerMonitor has no "is it locked right now" getter — only transitions — so
// the state is tracked from its events. Suspend counts as locked: a sleeping
// machine is no more reachable than a locked one.
let locked = false

function register() {
  powerMonitor.on('lock-screen', () => { locked = true })
  powerMonitor.on('suspend', () => { locked = true })
  powerMonitor.on('unlock-screen', () => { locked = false })
  powerMonitor.on('resume', () => { locked = false })

  ipcMain.handle(CH.PRESENCE_QUERY, () => {
    let idleSeconds = 0
    try {
      // Unsupported on some Linux session types; treat a failure as "just
      // active", since the web app's own freshness window is the real backstop
      // and this only ever gates a heartbeat.
      idleSeconds = powerMonitor.getSystemIdleTime()
    } catch { idleSeconds = 0 }
    return { idleSeconds, locked }
  })
}

module.exports = { register }

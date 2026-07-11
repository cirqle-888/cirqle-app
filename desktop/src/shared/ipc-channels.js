'use strict'

/**
 * Single source of truth for every IPC channel name in the desktop app.
 *
 * Consumed directly by the MAIN process (src/main.js and its modules).
 * The two preloads run SANDBOXED (Electron 20+ default — no relative
 * require), so they keep string literals; scripts/check-ipc-channels.js
 * fails the build if any preload literal drifts out of this registry.
 *
 * Values are the wire protocol — do not rename without a migration plan
 * for both the preloads and the web app's __CIRQLE_DESKTOP__ callers.
 */
module.exports = Object.freeze({
  // App
  APP_VERSION: 'app:version',
  RETRY: 'retry',
  RELOAD: 'reload',
  GO_BACK: 'goBack',
  GO_FORWARD: 'goForward',
  TOGGLE_FULLSCREEN: 'toggleFullscreen',
  STATE: 'state',

  // Cirqle pane
  CIRQLE_NOTIFY: 'cirqle:notify',
  CIRQLE_BADGE: 'cirqle:badge',
  CIRQLE_CAPTURE: 'cirqle:capture',
  CIRQLE_LOGO: 'cirqle:logo',
  CIRQLE_OPEN_NOTIFICATIONS: 'cirqle:openNotifications',
  CIRQLE_COMPARE_TOGGLE: 'cirqle:compareToggle',
  NOTIF_BADGE: 'notif-badge',
  CAPTURE_CLIPBOARD: 'capture:clipboard',
  SHARE_RECEIPT: 'share:receipt',

  // Downloads
  DOWNLOADS: 'downloads',
  DOWNLOADS_LIST: 'downloads:list',
  DOWNLOADS_PULSE: 'downloads:pulse',
  DOWNLOADS_TOGGLE: 'downloads:toggle',
  DOWNLOADS_CLOSE: 'downloads:close',
  DOWNLOADS_OPEN: 'downloads:open',
  DOWNLOADS_REVEAL: 'downloads:reveal',
  DOWNLOADS_REMOVE: 'downloads:remove',
  DOWNLOADS_CLEAR: 'downloads:clear',
  DOWNLOADS_OPEN_FOLDER: 'downloads:openFolder',
  DOWNLOADS_COPY: 'downloads:copy',
  DOWNLOADS_SHARE_WA: 'downloads:shareWA',
  DOWNLOADS_QUICKLOOK: 'downloads:quicklook',
  DOWNLOADS_START_DRAG: 'downloads:startDrag',

  // Download-complete fly animation
  FX_FLY: 'fx:fly',
  FX_DONE: 'fx:done',
  FX_REPORT_BTN: 'fx:report-btn',

  // WhatsApp panes
  WA_ADD: 'wa:add',
  WA_SWITCH: 'wa:switch',
  WA_REMOVE: 'wa:remove',
  WA_RENAME: 'wa:rename',

  // Layout / splitter
  LAYOUT_PRESET: 'layout:preset',
  SPLITTER_START: 'splitter:start',
  SPLITTER_DRAG: 'splitter:drag',
  SPLITTER_END: 'splitter:end',
})

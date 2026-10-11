'use strict'
const { ipcMain, Menu, dialog, app } = require('electron')
const CH = require('../shared/ipc-channels')
const { state } = require('./settings')
const layout = require('./layout')
const workspaces = require('./workspaces')
const updates = require('./updates')
function register(deps) {
  ipcMain.handle(CH.WORKSPACE_SAVE, (_e, name) => workspaces.save(name))
  ipcMain.on(CH.WORKSPACE_MENU, () => {
    const saved = state.savedWorkspaces.filter(w => typeof w.name === 'string' && Array.isArray(w.panes))
    const items = [
      { label: 'Workspaces', enabled: false },
      ...workspaces.presets().map(w => ({ label: w.name, click: () => workspaces.apply(w) })),
      { type: 'separator' },
      ...saved.map(w => ({ label: w.name, click: () => workspaces.apply(w) })),
      { label: 'Save current layout…', click: () => deps.getChrome()?.webContents.send(CH.WORKSPACE_PROMPT) },
    ]
    if (saved.length) items.push({ label: 'Remove saved layout', submenu: saved.map(w => ({ label: w.name, click: () => workspaces.remove(w.id) })) })
    Menu.buildFromTemplate(items).popup()
  })
  ipcMain.on(CH.WA_MENU, () => {
    const items = [{ label: 'WhatsApp accounts', enabled: false }]
    for (const account of state.waAccounts) {
      items.push({ label: account.label + (account.paused ? ' · paused' : ''), type: 'checkbox', checked: account.id === state.activeWa, click: () => deps.switchWa(account.id) })
      items.push({ label: `Manage ${account.label}`, submenu: [
        { label: 'Rename…', click: () => deps.getChrome()?.webContents.send(CH.WA_RENAME_PROMPT, account) },
        { label: account.muted ? 'Unmute' : 'Mute notifications', click: () => ipcMain.emit(CH.WA_MUTE, null, { id: account.id, muted: !account.muted }) },
        { label: account.paused ? 'Resume' : 'Pause to save memory', click: () => ipcMain.emit(CH.WA_PAUSE, null, { id: account.id, paused: !account.paused }) },
        { label: 'Remove account', enabled: state.waAccounts.length > 1, click: async () => {
          const result = await dialog.showMessageBox(deps.getWin(), { type: 'question', message: `Remove ${account.label}?`, detail: 'This removes the account from the workspace. Its saved login is kept on this computer.', buttons: ['Keep account', 'Remove'], defaultId: 0, cancelId: 0 })
          if (result.response === 1) ipcMain.emit(CH.WA_REMOVE, null, account.id)
        } },
      ] })
    }
    items.push({ type: 'separator' }, { label: 'Add WhatsApp account', click: () => ipcMain.emit(CH.WA_ADD, null) })
    Menu.buildFromTemplate(items).popup()
  })
  ipcMain.on(CH.MORE_MENU, () => Menu.buildFromTemplate([
    { label: 'Reload Cirqle', click: deps.reloadCirqle },
    { label: 'Reload active WhatsApp', click: () => ipcMain.emit(CH.RELOAD, null, 'whatsapp') },
    { label: 'Expand / restore focused pane', click: () => {
      const pane = state.expandedPane || state.panes.find(p => layout.viewFor(p)?.webContents.isFocused()) || state.panes[0]
      workspaces.expand(pane)
    } },
    { label: 'Equal pane widths', click: () => { state.sizes = state.panes.map(() => 1 / state.panes.length); layout.commit() } },
    { label: 'Toggle full screen', click: () => { const win = deps.getWin(); win?.setFullScreen(!win.isFullScreen()) } },
    { label: 'Hide toolbar (Cmd/Ctrl+T to show)', click: () => layout.applyPreset('toggleToolbar') },
    { type: 'separator' },
    { label: 'Check for updates…', click: () => updates.checkForUpdates({ interactive: true }) },
    ...(process.platform === 'darwin' && app.isPackaged && !app.isInApplicationsFolder() ? [{ label: 'Install in Applications…', click: () => {
      app.moveToApplicationsFolder({ conflictHandler: () => false })
    } }] : []),
    { label: `Cirqle Desktop ${app.getVersion()}`, enabled: false },
  ]).popup())
}
module.exports = { register }

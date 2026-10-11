'use strict'
const { app, dialog, shell } = require('electron')
const fs = require('fs')
const path = require('path')
const CH = require('../shared/ipc-channels')
const FEED_URL = process.env.CIRQLE_UPDATE_FEED || 'https://raw.githubusercontent.com/cirqle-888/cirqle-app/main/desktop/latest.json'
let deps = { getChrome: () => null, allowInstall: async () => true }
let timer = null, checking = null, installing = false, notifiedVersion = null, updater = null
let status = { available: false, label: '', ready: false }
function init(d) { Object.assign(deps, d) }
function publish(value) { status = { ...status, ...value }; deps.getChrome()?.webContents.send(CH.UPDATE_STATUS, status) }
function currentStatus() { return status }
function parseVer(version) { return String(version || '0').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0) }
function isNewer(remote, local) {
  const r = parseVer(remote), l = parseVer(local)
  for (let i = 0; i < Math.max(r.length,l.length); i++) {
    if ((r[i]||0) > (l[i]||0)) return true
    if ((r[i]||0) < (l[i]||0)) return false
  }
  return false
}
function signedUpdatesEnabled() {
  if (!app.isPackaged) return false
  try { return JSON.parse(fs.readFileSync(path.join(app.getAppPath(),'package.json'),'utf8')).signedUpdates === true } catch { return false }
}
function setupSignedUpdater() {
  if (updater) return updater
  if (!signedUpdatesEnabled()) return null
  updater = require('electron-updater').autoUpdater
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.on('update-available', info => publish({ available:true, ready:false, label:`Update ${info.version}`, latest:info.version }))
  updater.on('update-not-available', () => publish({available:false,ready:false,label:''}))
  updater.on('download-progress', info => publish({available:true,label:`Updating ${Math.round(info.percent)}%`,downloading:true}))
  updater.on('update-downloaded', () => publish({available:true,ready:true,downloading:false,label:'Restart to update',message:'Update downloaded. Restart when your work is saved.'}))
  updater.on('error', () => publish({available:status.available,downloading:false,error:true,label:'Retry update',message:'Could not download or verify the update. Your current app is unchanged.'}))
  return updater
}
async function runCheck({interactive = false} = {}) {
  publish({error:false,message:interactive ? 'Checking for updates…' : ''})
  try {
    const signed = setupSignedUpdater()
    if (signed) {
      const result = await signed.checkForUpdates()
      const available = result?.updateInfo?.version && isNewer(result.updateInfo.version,app.getVersion())
      if (!available) {
        if (interactive) publish({message:`Cirqle Desktop ${app.getVersion()} is up to date.`})
        return {ok:true,updateAvailable:false}
      }
      if (interactive || notifiedVersion !== result.updateInfo.version) {
        notifiedVersion = result.updateInfo.version
        const answer = await dialog.showMessageBox({type:'info',message:`Update available: ${result.updateInfo.version}`,detail:'Download it now. You can keep working and restart when your changes are saved.',buttons:['Download update','Later'],defaultId:0,cancelId:1})
        if (answer.response === 0) await signed.downloadUpdate()
      }
      return {ok:true,updateAvailable:true}
    }
    const response = await fetch(FEED_URL,{headers:{'cache-control':'no-cache'},signal:AbortSignal.timeout(15000)})
    if (!response.ok) throw new Error('Update server is unavailable')
    const manifest = await response.json()
    if (!/^\d+\.\d+\.\d+$/.test(manifest?.version || '')) throw new Error('Invalid update information')
    if (!isNewer(manifest.version,app.getVersion())) {
      publish({available:false,ready:false,label:'',message:interactive ? `Cirqle Desktop ${app.getVersion()} is up to date.` : ''})
      return {ok:true,updateAvailable:false}
    }
    const url = new URL(manifest.url || 'https://github.com/cirqle-888/cirqle-app/releases')
    if (url.protocol !== 'https:') throw new Error('Invalid update download address')
    publish({available:true,latest:manifest.version,label:`Update ${manifest.version}`,message:''})
    if (interactive || notifiedVersion !== manifest.version) {
      notifiedVersion = manifest.version
      const answer = await dialog.showMessageBox({type:'info',message:`Update available: ${manifest.version}`,detail:'This build uses manual updates. Download the installer, quit Cirqle after saving your work, and replace the app in Applications.',buttons:['Open download','Later'],defaultId:0,cancelId:1})
      if (answer.response === 0) require('./security').openExternal(shell,url.href)
    }
    return {ok:true,updateAvailable:true}
  } catch {
    publish({error:true,message:interactive ? 'Could not check for updates. Check your connection and try again.' : ''})
    return {ok:false}
  }
}
function checkForUpdates(options = {}) {
  if (checking) return checking
  checking = runCheck(options).finally(() => { checking = null })
  return checking
}
async function installUpdate() {
  if (!status.ready || !updater || installing) return false
  installing = true
  try {
    if (!await deps.allowInstall()) return false
    updater.quitAndInstall(false,true)
    return true
  } finally { installing = false }
}
function startPeriodicChecks() {
  if (timer) return
  setTimeout(() => { checkForUpdates().catch(() => {}) },15000)
  timer = setInterval(() => { checkForUpdates().catch(() => {}) },6*60*60*1000)
}
module.exports = { init, checkForUpdates, startPeriodicChecks, installUpdate, currentStatus, isNewer, signedUpdatesEnabled }

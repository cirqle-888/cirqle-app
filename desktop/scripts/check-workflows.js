'use strict'
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const Module = require('module')
const { EventEmitter } = require('events')
const root = path.join(__dirname,'..'), temp = fs.mkdtempSync(path.join(os.tmpdir(),'cirqle-workflows-'))
let answer = 0, selectedAccount = 'default', writes = 0, pasted = 0, composerFound = false
const noop = () => {}
const autoUpdater = Object.assign(new EventEmitter(), { checkForUpdates: async () => { autoUpdater.emit('update-available', { version: '0.10.1' }); return { updateInfo: { version: '0.10.1' } } }, downloadUpdate: async () => { autoUpdater.emit('download-progress', { percent: 50 }); autoUpdater.emit('update-downloaded') }, quitAndInstall: () => { autoUpdater.installs = (autoUpdater.installs || 0) + 1 } })
const electron = {
 app: { getPath: () => temp, getName: () => 'Cirqle', getVersion: () => '0.10.0', isPackaged:false, getAppPath: () => root },
 ipcMain: { on:noop,handle:noop },
 clipboard: { writeImage: () => writes++, writeText:noop },
 nativeImage: { createFromDataURL: () => ({}) }, shell: { showItemInFolder:noop,openExternal:noop },
 dialog: { showMessageBox:async () => ({response:answer}),showMessageBoxSync:() => answer },
 Menu: { buildFromTemplate: items => ({ popup: opts => { if (selectedAccount) items.find(i => i.label?.startsWith(selectedAccount === 'default' ? 'WA 1' : 'Sales'))?.click(); opts?.callback?.() } }) },
}
const resolve = Module._resolveFilename
Module._resolveFilename = function(req,...rest) { return req === 'electron' ? 'electron-workflow-stub' : req === 'electron-updater' ? 'updater-workflow-stub' : resolve.call(this,req,...rest) }
require.cache['electron-workflow-stub'] = { id:'electron-workflow-stub',filename:'electron-workflow-stub',loaded:true,exports:electron }
require.cache['updater-workflow-stub'] = { id: 'updater-workflow-stub', filename: 'updater-workflow-stub', loaded: true, exports: { autoUpdater } }
const { state } = require('../src/main/settings')
require('../src/main/layout').init({getChrome:() => ({webContents:{send:noop}})})
const health = require('../src/main/pane-health')
const wc = Object.assign(new EventEmitter(), {id:12,isDestroyed:()=>false,loadFile:async()=>{},loadURL:async url=>{wc.loaded=url},executeJavaScript:async()=>({dirty:true,label:'Saving…'})})
const view = {webContents:wc}
health.init({getWin:()=>({})})
health.wire(view,'studio','https://flyer.cirqle.work')
const wa = require('../src/main/whatsapp')
state.waAccounts.push({id:'sales',label:'Sales'})
wa.whatsapps.default = {webContents:{focus:noop,executeJavaScript:async()=>composerFound,paste:()=>pasted++}}
wa.whatsapps.sales = wa.whatsapps.default
wa.init({ensureWaPane:id=>{state.activeWa=id}})
;(async()=>{
 wc.emit('did-start-loading'); assert.strictEqual(state.paneStatus.studio.state,'loading')
 wc.emit('did-fail-load',{},-106,'Offline','https://flyer.cirqle.work/drafts/123',true)
 assert.strictEqual(state.paneStatus.studio.state,'offline')
 wc.emit('did-stop-loading'); assert.strictEqual(state.paneStatus.studio.state,'offline')
 assert.strictEqual(health.retry('studio'),true)
 assert.strictEqual(wc.loaded,'https://flyer.cirqle.work/drafts/123')
 wc.emit('did-stop-loading'); assert.strictEqual(state.paneStatus.studio.state,'ready')
 health.report(wc,{state:'saving',dirty:true,label:'Saving…'})
 assert.strictEqual(await health.confirmClose(['studio']),false)
 answer=1; assert.strictEqual(await health.confirmClose(['studio']),true)
 wc.executeJavaScript=async()=>({dirty:false,label:'Saved'})
 assert.strictEqual(await health.confirmClose(['studio']),true)
 health.report(wc,{state:'made-up',dirty:true}); assert.strictEqual(state.saveStatus.studio.dirty,false)
 wc.emit('destroyed'); assert.strictEqual(health.views.has(12),false)
 const image = {isEmpty:()=>false}
 selectedAccount='sales'
 const copied = await wa.shareImageToWhatsApp(image)
 assert.strictEqual(copied.accountLabel,'Sales'); assert.strictEqual(writes,1)
 assert.strictEqual(state.activeWa,'sales'); assert.ok(copied.message.includes('Sales'))
 selectedAccount=null
 const cancelled = await wa.shareImageToWhatsApp(image)
 assert.strictEqual(cancelled.reason,'cancelled'); assert.strictEqual(writes,1)
 selectedAccount='default'; composerFound=false
 const fallback = await wa.shareImageToWhatsApp(image,{autoPaste:true})
 assert.strictEqual(fallback.pasted,false); assert.strictEqual(pasted,0)
 assert.ok(fallback.message.includes('Image copied'))
 composerFound=true
 const attempted = await wa.shareImageToWhatsApp(image,{autoPaste:true})
 assert.strictEqual(attempted.pasted,true); assert.strictEqual(pasted,1)
 const updates = require('../src/main/updates')
 assert.strictEqual(updates.isNewer('0.10.0','0.9.2'),true)
 assert.strictEqual(updates.isNewer('0.9.2','0.10.0'),false)
 assert.strictEqual(updates.signedUpdatesEnabled(),false)
 global.fetch=async()=>({ok:true,json:async()=>({version:'0.10.0'})})
 assert.strictEqual((await updates.checkForUpdates()).updateAvailable,false)
 global.fetch=async()=>({ok:true,json:async()=>({version:'0.10.1',url:'javascript:bad'})})
 assert.strictEqual((await updates.checkForUpdates()).ok,false)
 global.fetch=async()=>{throw new Error('offline')}
 assert.strictEqual((await updates.checkForUpdates()).ok,false)
 // Signed releases alone can download/install, and unsaved-work cancellation wins.
 fs.writeFileSync(path.join(temp,'package.json'), JSON.stringify({signedUpdates:true}))
 electron.app.isPackaged=true; electron.app.getAppPath=()=>temp; answer=0
 assert.strictEqual(updates.signedUpdatesEnabled(),true)
 assert.strictEqual((await updates.checkForUpdates({interactive:true})).updateAvailable,true)
 assert.strictEqual(updates.currentStatus().ready,true)
 assert.strictEqual(autoUpdater.autoDownload,false)
 assert.strictEqual(autoUpdater.autoInstallOnAppQuit,false)
 updates.init({allowInstall:async()=>false})
 assert.strictEqual(await updates.installUpdate(),false)
 assert.strictEqual(autoUpdater.installs,undefined)
 updates.init({allowInstall:async()=>true})
 assert.strictEqual(await updates.installUpdate(),true)
 assert.strictEqual(autoUpdater.installs,1)
 autoUpdater.emit('error',new Error('verification failed'))
 assert.strictEqual(updates.currentStatus().error,true)
 const clientWorkspace = require('../src/main/client-workspace')
 const client = { id: '11111111-1111-4111-8111-111111111111', name: 'Sea Star', phone: '+91 98765 43210', country: 'India' }
 assert.strictEqual(clientWorkspace.plan({ id: '../escape', name: 'Bad' }), null)
 const plan = clientWorkspace.plan(client)
 assert.deepStrictEqual(plan.panes, ['cirqle','cirqle2','studio','wa:default'])
 assert.strictEqual(new URL(plan.urls.cirqle).searchParams.get('client'),client.id)
 assert.strictEqual(new URL(plan.urls.cirqle2).searchParams.get('client'),client.id)
 assert.strictEqual(new URL(plan.urls.studio).searchParams.get('cirqleClient'),client.id)
 assert.strictEqual(clientWorkspace.plan({ ...client, showInvoices: false }).panes.includes('cirqle2'),false)
 assert.ok(clientWorkspace.plan({ ...client, showTasks: false }).urls.cirqle.includes('/clients/'))
 assert.strictEqual(clientWorkspace.phoneForChat(client), '919876543210')
 assert.strictEqual(clientWorkspace.phoneForChat({...client,phone:'9876543210',country:'unknown'}),null)
 const confirm = health.confirmClose
 health.confirmClose = async () => false
 const oldPanes = [...state.panes]
 assert.strictEqual((await clientWorkspace.open(client)).reason,'cancelled')
 assert.deepStrictEqual(state.panes,oldPanes)
 health.confirmClose = confirm
 assert.strictEqual(clientWorkspace.chat(),false)
 console.log('client workspace exact-id routes, permission hints, chat numbers and dirty-switch cancellation OK')
 fs.rmSync(temp,{recursive:true,force:true})
 console.log('pane recovery, dirty-close protection, share account/cancel/fallback and update failures OK')
})().catch(error=>{console.error(error);process.exitCode=1})

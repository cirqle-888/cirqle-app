'use strict'
const { state } = require('./settings')
const layout = require('./layout')
const workspaces = require('./workspaces')
const health = require('./pane-health')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
let deps = { cirqleUrl: 'https://app.cirqle.work', studioUrl: 'https://flyer.cirqle.work', feedback: () => {}, focusWhatsapp: () => null, copyText: () => {} }
let opening = false
function init(d) { Object.assign(deps,d) }
function normalizeClient(value) {
  if (!value || !UUID.test(value.id || '')) return null
  const name = typeof value.name === 'string' ? value.name.trim().slice(0,120) : ''
  if (!name) return null
  return { id:value.id, name, code:String(value.code || '').slice(0,40), phone:String(value.phone || '').slice(0,50), country:String(value.country || '').slice(0,60), showTasks:value.showTasks !== false, showInvoices:value.showInvoices !== false }
}
function phoneForChat(client) {
  const raw=client.phone.trim(), digits=raw.replace(/[^0-9]/g,'')
  if (/^\+/.test(raw) && /^[1-9]\d{10,14}$/.test(digits)) return digits
  if (/^00/.test(raw) && /^[1-9]\d{10,14}$/.test(digits.slice(2))) return digits.slice(2)
  if (/^(IN|India)$/i.test(client.country.trim()) && /^[6-9]\d{9}$/.test(digits)) return '91'+digits
  return null
}
function plan(value, waId = state.activeWa) {
  const client=normalizeClient(value)
  if (!client) return null
  const tasks = new URL(deps.cirqleUrl + '/dashboard/tasks'); tasks.searchParams.set('client',client.id)
  const invoices = new URL(deps.cirqleUrl + '/dashboard/invoices'); invoices.searchParams.set('client',client.id)
  const flyer = new URL(deps.studioUrl.replace(/\/$/,'')+'/'); flyer.searchParams.set('cirqleClient',client.id)
  const panes=['cirqle'], urls={cirqle:client.showTasks ? tasks.href : deps.cirqleUrl+'/dashboard/clients/'+client.id}
  const roles={cirqle:client.showTasks?'Client tasks':'Client overview'}
  if (client.showInvoices) { panes.push('cirqle2'); urls.cirqle2=invoices.href; roles.cirqle2='Client invoices' }
  panes.push('studio'); urls.studio=flyer.href; roles.studio='Client Flyers'
  if (state.waAccounts.some(a=>a.id===waId)) panes.push(`wa:${waId}`)
  return {client,panes,sizes:panes.map(()=>1/panes.length),urls,roles}
}
async function open(value) {
  const target=plan(value)
  if (!target) return {ok:false,reason:'Choose a valid client.'}
  if (opening) return {ok:false,reason:'A client workspace is already opening.'}
  opening=true
  try {
    if (!await health.confirmClose(['studio','studio2'])) return {ok:false,reason:'cancelled'}
    workspaces.apply(target)
    state.clientWorkspace={...target.client,roles:target.roles}
    layout.broadcast()
    const results=await Promise.allSettled(Object.entries(target.urls).map(async ([pane,url])=>{
      const view=layout.viewFor(pane)
      if (view && view.webContents.getURL() !== url) await view.webContents.loadURL(url)
    }))
    const failed=results.some(r=>r.status==='rejected')
    deps.feedback({ok:!failed,message:failed ? `${target.client.name}: one or more pages could not load. Use the pane's Retry button.` : `${target.client.name} workspace opened. Each business pane is filtered by this client.`})
    return {ok:true,clientId:target.client.id,partial:failed}
  } finally { opening=false }
}
function chat() {
  const client=state.clientWorkspace
  if (!client) return false
  const view=deps.focusWhatsapp()
  if (!view) return false
  const phone=phoneForChat(client)
  if (phone) {
    view.webContents.loadURL('https://web.whatsapp.com/send?phone='+phone).catch(()=>{})
    deps.feedback({ok:true,message:`Opening ${client.name}'s contact chat. Check the recipient before sending.`})
  } else {
    deps.copyText(client.name)
    deps.feedback({ok:true,message:`${client.name} copied. Paste it into WhatsApp search to find the client or group chat.`})
  }
  return true
}
module.exports = { init, normalizeClient, phoneForChat, plan, open, chat }

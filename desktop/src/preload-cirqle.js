'use strict'

/**
 * Preload attached to the Cirqle web view. Exposes a desktop marker and relays
 * captured content from the main process into the page as a `cirqle:capture`
 * window event — which the Quick Capture screen listens for
 * (src/app/(dashboard)/dashboard/capture/capture-client.tsx).
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__CIRQLE_DESKTOP__', {
  version: 6,
  openClientWorkspace: (client) => ipcRenderer.invoke('client-workspace:open', client),
  reportSaveState: (status) => ipcRenderer.send('pane:saveStatus', status),
  retry: (pane) => ipcRenderer.send('retry', pane),
  updateLogo: (url) => ipcRenderer.send('cirqle:logo', url),

  /**
   * Write text to the OS clipboard from the main process. The page's own
   * navigator.clipboard rejects whenever this view isn't the focused document,
   * which is most of the time in a multi-pane shell — src/lib/clipboard.ts
   * tries this first and falls back to the web APIs outside the desktop.
   */
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),

  /**
   * Fire a native OS notification (system tone + high-priority dock bounce),
   * handled in the main process. Called by the web app's DesktopNotifier for
   * new chat messages and bell notifications. Payload:
   * `{ title, body, tag?, url? }` where url is an in-app path the click
   * handler navigates the Cirqle pane to.
   */
  notify: (payload) => ipcRenderer.send('cirqle:notify', payload),

  /**
   * Report the current unread count (chat + notifications) so the desktop
   * shell can show a top-bar bell badge + a dock badge. Called by the web
   * app's FloatingCommsWidget whenever the total changes.
   */
  setBadge: (count) => ipcRenderer.send('cirqle:badge', count),

  /**
   * Share a canvas-rendered image (e.g. a payment receipt PNG data URL) to the
   * linked WhatsApp pane. `action` is one of:
   *   'copy'     — copy image to clipboard + focus WhatsApp (paste with ⌘V)   [default]
   *   'paste'    — additionally auto-paste into the currently-open chat
   *   'download' — save into the common Downloads + reveal in Finder to drag in
   * `caption`, if given, is best-effort typed into WhatsApp's image-caption box
   * after the auto-paste (only applies to the 'paste' action — 'copy'/'download'
   * don't touch the composer, so there's no caption box to type into yet).
   * Resolves to { ok, action, ... }.
   */
  shareReceipt: (dataUrl, filename, action = 'copy', caption) =>
    ipcRenderer.invoke('share:receipt', { dataUrl, filename, action, caption }),

  /**
   * Whether the PERSON is at the machine (v4+). Resolves to
   * `{ idleSeconds, locked }` straight from the OS.
   *
   * The web app's presence feature calls this once a minute instead of reading
   * page visibility, because a desktop window is hidden most of the time while
   * its owner is right in front of it — see src/main/presence.js and
   * src/lib/presence/activity.ts. Older shells lack this, and the web app
   * falls back to the browser rule.
   */
  presence: {
    query: () => ipcRenderer.invoke('presence:query'),
  },
})

ipcRenderer.on('cirqle:capture', (_e, payload) => {
  try {
    window.__pendingCirqleCapture = payload
    window.dispatchEvent(new CustomEvent('cirqle:capture', { detail: payload }))
  } catch { /* page not ready */ }
})

// Toolbar bell click, relayed to whatever page is currently loaded — the
// FloatingCommsWidget (mounted globally in the dashboard layout) listens for
// this and pops its Alerts tab open.
ipcRenderer.on('cirqle:openNotifications', () => {
  try {
    window.dispatchEvent(new CustomEvent('cirqle:openNotifications'))
  } catch { /* page not ready */ }
})

// Support save-state feedback even before the hosted Flyer app is redeployed.
window.addEventListener('DOMContentLoaded', () => {
  let previous = '', scheduled = false
  const report = () => {
    scheduled = false
    const el = document.querySelector('[data-desktop-save-state]') || [...document.querySelectorAll('[role="status"]')].find(el => /saving|not saved|conflicting|synced|saved/i.test(el.textContent || ''))
    const label = el?.textContent.trim() || ''
    const state = el?.dataset.desktopSaveState || (/conflicting/i.test(label) ? 'conflict' : /not saved/i.test(label) ? 'error' : /saving/i.test(label) ? 'saving' : label ? 'saved' : 'idle')
    const payload = { state, dirty: el?.dataset.desktopDirty === 'true' || ['saving', 'error', 'conflict'].includes(state), label }
    const signature = JSON.stringify(payload)
    if (signature !== previous) { previous = signature; ipcRenderer.send('pane:saveStatus', payload) }
  }
  const observer = new MutationObserver(() => {
    if (!scheduled) { scheduled = true; setTimeout(report, 80) }
  })
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-desktop-save-state', 'data-desktop-dirty'] })
  report()
})

// Keep the desktop entry point usable with the existing hosted client page.
window.addEventListener('DOMContentLoaded', () => {
  let scheduled = false
  function syncWorkspaceControls() {
    scheduled = false
    const match = location.pathname.match(/^\/dashboard\/clients\/([0-9a-f-]{36})\/?$/i)
    let button = document.getElementById('desktop-client-workspace-fallback')
    if (!match || document.querySelector('[data-client-workspace-action]')) { button?.remove(); button = null }
    const heading = document.querySelector('h1')
    if (match && heading && /Client\s/i.test(heading.parentElement?.textContent || '') && !button && !document.querySelector('[data-client-workspace-action]')) {
      button = document.createElement('button')
      button.id = 'desktop-client-workspace-fallback'
      button.textContent = 'Open client workspace'
      button.type = 'button'
      button.style.cssText = 'margin-left:8px;padding:6px 10px;background:#7c3aed;color:white;border:0;border-radius:7px;font-size:12px;cursor:pointer;white-space:nowrap'
      button.onclick = async () => {
        button.disabled = true
        try {
          const result = await ipcRenderer.invoke('client-workspace:open',{id:match[1],name:heading.textContent.trim()})
          if (!result?.ok && result?.reason !== 'cancelled') button.textContent = result?.reason || 'Could not open. Try again.'
        } catch { button.textContent = 'Could not open. Try again.' }
        finally { button.disabled = false }
      }
      heading.parentElement.appendChild(button)
    }
    // An old Flyer deployment must not silently show all clients for a scoped URL.
    const clientId = new URLSearchParams(location.search).get('cirqleClient')
    const scopedMain = document.querySelector('main[data-client-scope]')
    const existing = document.getElementById('desktop-flyer-scope-message')
    const supported = !clientId || scopedMain?.getAttribute('data-client-scope') === clientId
    if (supported) { if (existing) { const main=document.querySelector('main'); if(main) {main.style.visibility='';main.inert=false} existing.remove() } return }
    if (existing) return
    const main = document.querySelector('main')
    if (!main) return
    main.style.visibility = 'hidden'
    main.inert = true
    const panel = document.createElement('div')
    panel.id = 'desktop-flyer-scope-message'
    panel.setAttribute('role','status')
    panel.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px;text-align:center;background:#0b1120;color:#e5e7eb;font:14px -apple-system,sans-serif;gap:14px'
    const title = document.createElement('strong'); title.textContent = 'Client Flyers need a Flyer app update'
    const text = document.createElement('p'); text.textContent = 'Update the Flyer app to show only this client’s offers. Your other workspace panes are ready.'
    const retry = document.createElement('button'); retry.textContent = 'Try again'; retry.onclick = () => location.reload()
    panel.append(title,text,retry); document.body.appendChild(panel)
  }
  const observer = new MutationObserver(() => { if (!scheduled) { scheduled = true; setTimeout(syncWorkspaceControls,100) } })
  observer.observe(document.body,{subtree:true,childList:true,characterData:true})
  syncWorkspaceControls()
})

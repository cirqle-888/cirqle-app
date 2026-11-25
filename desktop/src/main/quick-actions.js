'use strict'

/**
 * Quick actions — the handful of things people do in Cirqle all day, one click
 * or one keystroke away from anywhere in the desktop app.
 *
 * ONE list feeds every surface: the toolbar's Quick menu and its buttons, the
 * menu bar, the menu-bar (tray) icon and the Dock icon. Add an action here and
 * it appears in all of them; nothing else keeps its own copy.
 *
 * The order is what staff actually do, not what an owner does. In the activity
 * log (45 days to 25 Nov 2026, everyone who is not an admin): logging work on a
 * task 82 times, creating tasks 51, editing tasks 16, recording a payment 11 —
 * and next to nothing else. So work and tasks lead, money follows, and the
 * owner's pages (reports, settings) sit at the bottom. Pages a person may not
 * open are still refused by Cirqle itself; this menu grants nothing.
 *
 * `beside: true` opens the page in the second Cirqle pane, next to whatever is
 * already on screen, instead of replacing the page in the main pane.
 */
const ACTIONS = [
  // ── every day ──
  { id: 'my-work', group: 'daily', label: 'My Work', route: '/dashboard/my-work', accelerator: 'CmdOrCtrl+1' },
  { id: 'tasks', group: 'daily', label: 'Tasks', route: '/dashboard/tasks', accelerator: 'CmdOrCtrl+2' },
  { id: 'chat', group: 'daily', label: 'Team Chat', route: '/dashboard/chat', accelerator: 'CmdOrCtrl+3' },
  { id: 'requests', group: 'daily', label: 'Requests', route: '/dashboard/requests', accelerator: 'CmdOrCtrl+4' },
  { id: 'activity', group: 'daily', label: 'Work Log', route: '/dashboard/contributions', accelerator: 'CmdOrCtrl+5' },

  // ── do something ──
  { id: 'capture', group: 'do', label: 'New Request from Clipboard', run: 'capture', accelerator: 'CmdOrCtrl+Shift+N' },
  { id: 'search', group: 'do', label: 'Search or Jump Anywhere…', run: 'search' },
  { id: 'prompt-studio', group: 'do', label: 'Prompt Studio Beside', route: '/dashboard/prompt-studio', beside: true, accelerator: 'CmdOrCtrl+Shift+P' },
  { id: 'payment', group: 'do', label: 'Record a Payment (Cashbook)', route: '/dashboard/cashbook' },

  // ── clients and content ──
  { id: 'clients', group: 'clients', label: 'Clients', route: '/dashboard/clients', accelerator: 'CmdOrCtrl+6' },
  { id: 'social', group: 'clients', label: 'Social Calendar', route: '/dashboard/social-calendar', accelerator: 'CmdOrCtrl+7' },
  { id: 'ad-library', group: 'clients', label: 'Ad Library', route: '/dashboard/ad-library' },

  // ── money and office ──
  { id: 'invoices', group: 'office', label: 'Invoices', route: '/dashboard/invoices' },
  { id: 'quotations', group: 'office', label: 'Quotations', route: '/dashboard/quotations' },
  { id: 'reports', group: 'office', label: 'Reports', route: '/dashboard/reports' },
  { id: 'home', group: 'office', label: 'Dashboard Home', route: '/dashboard', accelerator: 'CmdOrCtrl+0' },
  { id: 'settings', group: 'office', label: 'Settings', route: '/dashboard/settings' },
]

const GROUPS = ['daily', 'do', 'clients', 'office']

const deps = {
  showApp: () => {},
  navigate: () => {},
  openBeside: () => {},
  sendClipboardToCirqle: () => {},
  openSearch: () => {},
}
function init(d) { Object.assign(deps, d) }

function find(id) { return ACTIONS.find(a => a.id === id) || null }

/** Run one action by id. Unknown ids do nothing — ids arrive over IPC. */
function run(id) {
  const action = find(id)
  if (!action) return false
  deps.showApp()
  if (action.run === 'capture') deps.sendClipboardToCirqle()
  else if (action.run === 'search') deps.openSearch()
  else if (action.beside) deps.openBeside(action.route)
  else deps.navigate(action.route)
  return true
}

/**
 * The actions as a native menu template, grouped with separators.
 * Shortcuts are shown only where they are real: the menu bar registers them, so
 * every other surface passes `accelerators: false` rather than advertise a
 * second, unregistered copy.
 */
function template({ accelerators = false } = {}) {
  const items = []
  for (const group of GROUPS) {
    if (items.length) items.push({ type: 'separator' })
    for (const action of ACTIONS.filter(a => a.group === group)) {
      items.push({
        label: action.label,
        ...(accelerators && action.accelerator ? { accelerator: action.accelerator } : {}),
        click: () => run(action.id),
      })
    }
  }
  return items
}

module.exports = { ACTIONS, GROUPS, init, find, run, template }

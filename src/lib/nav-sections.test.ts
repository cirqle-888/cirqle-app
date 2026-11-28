import { describe, it, expect } from 'vitest'
import { Inbox, Wallet, Repeat, CreditCard } from 'lucide-react'
import { canOpenHref, navSections, buildNavRows, tabGroupFor, activeRowKey, type NavItem, type NavSection } from './nav-sections'

describe('the sidebar layout', () => {
  const items = navSections.flatMap(s => s.items)

  it('lists every page once', () => {
    const hrefs = items.map(i => i.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it('points every tab at a row in its own section', () => {
    for (const section of navSections) {
      for (const tab of section.items.filter(i => i.tabOf)) {
        const parent = section.items.find(i => i.href === tab.tabOf)
        expect(parent, `${tab.label} → ${tab.tabOf} (must be in ${section.label ?? 'Home'})`).toBeDefined()
        expect(parent!.tabOf, `${parent!.label} is a tab itself`).toBeUndefined()
        expect(parent!.hideInSidebar, `${parent!.label} has no row to hold tabs`).toBeFalsy()
      }
    }
  })

  it('keeps every section short enough to scan', () => {
    for (const section of navSections) {
      const rows = buildNavRows(section.items, () => true)
      expect(rows.length, `${section.label ?? 'Home'} has ${rows.length} rows`).toBeLessThanOrEqual(10)
    }
  })

  it('starts Work with My Work, Requests and Tasks (the landing page for people without the dashboard)', () => {
    const work = navSections.find(s => s.label === 'Work')!
    expect(work.items.filter(i => !i.tabOf && !i.hideInSidebar).slice(0, 3).map(i => i.label)).toEqual(['My Work', 'Requests', 'Tasks'])
  })
})

describe('rows and tabs', () => {
  const cashbook: NavSection = {
    label: 'Finance',
    items: [
      { label: 'Cash Book', tabLabel: 'Entries', href: '/dashboard/cashbook', icon: Wallet, requiredPerm: 'cashbook.view' },
      { label: 'Recurring', href: '/dashboard/cashbook/recurring', tabOf: '/dashboard/cashbook', icon: Repeat, requiredPerm: 'cashbook.view' },
      { label: 'Card Statements', href: '/dashboard/cashbook/cards', tabOf: '/dashboard/cashbook', icon: CreditCard, requiredPerm: 'card_reconciliation.view' },
      { label: 'Hidden', href: '/dashboard/hidden', icon: Inbox, hideInSidebar: true },
    ],
  }
  const holds = (...keys: string[]) => (i: NavItem) => !i.requiredPerm || keys.includes(i.requiredPerm)

  it('folds tabs into their parent\'s row and leaves hidden items out', () => {
    const rows = buildNavRows(cashbook.items, () => true)
    expect(rows.map(r => r.key)).toEqual(['/dashboard/cashbook'])
    expect(rows[0].members.map(m => m.label)).toEqual(['Cash Book', 'Recurring', 'Card Statements'])
  })

  it('still shows the row, led by the tab, when only a tab may be opened', () => {
    const [row] = buildNavRows(cashbook.items, holds('card_reconciliation.view'))
    expect(row.key).toBe('/dashboard/cashbook')
    expect(row.item.label).toBe('Card Statements')
    expect(row.members.map(m => m.href)).toEqual(['/dashboard/cashbook/cards'])
  })

  it('drops the row when nothing in it may be opened', () => {
    expect(buildNavRows(cashbook.items, holds('nothing'))).toEqual([])
  })

  it('finds the whole group from any of its pages, parent first', () => {
    const labels = (p: string) => tabGroupFor(p, [cashbook])?.map(i => i.label)
    expect(labels('/dashboard/cashbook')).toEqual(['Cash Book', 'Recurring', 'Card Statements'])
    expect(labels('/dashboard/cashbook/cards?month=11')).toEqual(['Cash Book', 'Recurring', 'Card Statements'])
    // A sub-page belongs to the group of the tab it sits under.
    expect(labels('/dashboard/cashbook/accounts')).toEqual(['Cash Book', 'Recurring', 'Card Statements'])
    expect(tabGroupFor('/dashboard/hidden', [cashbook])).toBeNull()
    expect(tabGroupFor('/dashboard/elsewhere', [cashbook])).toBeNull()
  })

  it('lights the parent row for a tab page', () => {
    expect(activeRowKey('/dashboard/cashbook/recurring', [cashbook])).toBe('/dashboard/cashbook')
    expect(activeRowKey('/dashboard/cashbook', [cashbook])).toBe('/dashboard/cashbook')
    expect(activeRowKey('/dashboard/elsewhere', [cashbook])).toBeNull()
  })

  it('groups the real app\'s module pages', () => {
    expect(tabGroupFor('/dashboard/statements')?.map(i => i.href)).toEqual([
      '/dashboard/invoices', '/dashboard/invoices/follow-ups', '/dashboard/statements', '/dashboard/reports/reconcile',
    ])
    expect(activeRowKey('/dashboard/recruitment/offers')).toBe('/dashboard/recruitment/positions')
    // Client Ranking lives under /clients but is a client report.
    expect(activeRowKey('/dashboard/clients/ranking')).toBe('/dashboard/client-analytics')
    expect(activeRowKey('/dashboard/clients/abc')).toBe('/dashboard/clients')
  })
})

/**
 * canOpenHref is the rule the dashboard layout uses to bounce a user off a
 * page they may not open — and the rule buttons use to decide whether to
 * offer that page at all. These pin the case that broke: a Task Manager on a
 * client page saw "Edit Client", which links into Settings, and was bounced
 * to the dashboard.
 */
const grants = (...keys: string[]) => (key: string) => keys.includes(key)
const editClient = '/dashboard/settings?tab=clients&editClient=abc&returnTo=/dashboard/clients/abc'

describe('canOpenHref', () => {
  it('refuses Edit Client (Settings) without settings.access', () => {
    expect(canOpenHref(editClient, grants('clients.view', 'clients.create'), false)).toBe(false)
  })

  it('allows Edit Client with settings.access, and always for admins', () => {
    expect(canOpenHref(editClient, grants('settings.access'), false)).toBe(true)
    // Admins pass through `can` itself (hasPermission / the client context
    // both answer true for every key); `isAdmin` only unlocks adminOnly items.
    const adminCan = () => true
    expect(canOpenHref(editClient, adminCan, true)).toBe(true)
  })

  it('ignores the query string and hash', () => {
    expect(canOpenHref('/dashboard/invoices?id=1#x', grants('billing.view_invoices'), false)).toBe(true)
    expect(canOpenHref('/dashboard/invoices?id=1#x', grants(), false)).toBe(false)
  })

  it('judges a child route by its own sidebar entry', () => {
    expect(canOpenHref('/dashboard/partners/p1', grants(), false)).toBe(false)
    expect(canOpenHref('/dashboard/partners/p1', grants('finance.partner.view'), false)).toBe(true)
  })

  it('accepts any one of a report\'s alternative permissions', () => {
    expect(canOpenHref('/dashboard/reports/client-profitability', grants('reports.view_client_financials'), false)).toBe(true)
    expect(canOpenHref('/dashboard/reports/client-profitability', grants('reports.view'), false)).toBe(true)
    expect(canOpenHref('/dashboard/reports/client-profitability', grants('clients.view'), false)).toBe(false)
  })

  it('offers Client Ranking only to those its page lets in (reports.view)', () => {
    // The page checks reports.view alone; the menu used to accept the narrower
    // client-financials key too, and those people were bounced.
    expect(canOpenHref('/dashboard/clients/ranking', grants('reports.view'), false)).toBe(true)
    expect(canOpenHref('/dashboard/clients/ranking', grants('reports.view_client_financials'), false)).toBe(false)
  })

  it('judges a tab page by its own permission, not its parent\'s', () => {
    // Card Statements is a tab of Cash Book but keeps its own key.
    expect(canOpenHref('/dashboard/cashbook/cards', grants('card_reconciliation.view'), false)).toBe(true)
    expect(canOpenHref('/dashboard/cashbook/cards', grants('cashbook.view'), false)).toBe(false)
  })

  it('leaves /dashboard and routes outside the sidebar to their own page checks', () => {
    expect(canOpenHref('/dashboard', grants(), false)).toBe(true)
    expect(canOpenHref('/dashboard/not-in-the-sidebar', grants(), false)).toBe(true)
  })
})

describe('pages outside the sidebar', () => {
  it('light the Social row on every Social tab', () => {
    for (const p of ['/dashboard/social', '/dashboard/social/queue', '/dashboard/social/inbox', '/dashboard/social/accounts/abc']) {
      expect(activeRowKey(p), p).toBe('/dashboard/social-calendar')
    }
    expect(activeRowKey('/dashboard/social-calendar')).toBe('/dashboard/social-calendar')
  })
})

describe('Workspaces', () => {
  it('opens for every employee — they design their own personal workspaces there', () => {
    expect(canOpenHref('/dashboard/settings/workspaces', () => false, false)).toBe(true)
  })
})

describe('pages without a sidebar row', () => {
  it('say where they are instead', () => {
    for (const item of navSections.flatMap(s => s.items).filter(i => i.hideInSidebar)) {
      expect(item.foundAt, item.label).toBeTruthy()
    }
  })
})

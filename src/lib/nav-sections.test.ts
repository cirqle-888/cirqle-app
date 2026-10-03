import { describe, it, expect } from 'vitest'
import { canOpenHref } from './nav-sections'

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
    expect(canOpenHref('/dashboard/clients/ranking', grants('reports.view_client_financials'), false)).toBe(true)
    expect(canOpenHref('/dashboard/clients/ranking', grants('clients.view'), false)).toBe(false)
  })

  it('leaves /dashboard and routes outside the sidebar to their own page checks', () => {
    expect(canOpenHref('/dashboard', grants(), false)).toBe(true)
    expect(canOpenHref('/dashboard/not-in-the-sidebar', grants(), false)).toBe(true)
  })
})

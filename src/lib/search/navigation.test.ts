import { describe, expect, it } from 'vitest'
import { availableCreateShortcuts, canOpenSearchHref, matchesNavSearch, searchResultHref } from './navigation'
import { isNavItemVisible, navSections } from '@/lib/nav-sections'

describe('command palette access and navigation', () => {
  it('does not offer create actions to a read-only viewer or access preview', () => {
    expect(availableCreateShortcuts(key => key === 'billing.view_invoices', false)).toEqual([])
    expect(availableCreateShortcuts(() => true, true, true)).toEqual([])
  })

  it('requires both page access and write permission for a creation shortcut', () => {
    expect(availableCreateShortcuts(key => key === 'billing.edit', false)).toEqual([])
    expect(availableCreateShortcuts(key => ['billing.edit', 'billing.view_invoices'].includes(key), false)
      .map(item => item.id)).toEqual(['qa-invoice'])
    expect(availableCreateShortcuts(() => true, true)).toHaveLength(4)
  })

  it('also removes historical create shortcuts after write access is revoked', () => {
    const readOnly = (key: string) => key === 'billing.view_invoices'
    expect(canOpenSearchHref('/dashboard/invoices?new=true&client=c1', readOnly, false)).toBe(false)
    expect(canOpenSearchHref('/dashboard/invoices?id=i1', readOnly, false)).toBe(true)
    expect(canOpenSearchHref('/dashboard/invoices?new=true', () => true, true, true)).toBe(false)
  })

  it('respects alternative report permissions and keyword search', () => {
    const reports = navSections.flatMap(section => section.items).find(item => item.href === '/dashboard/reports')!
    expect(isNavItemVisible(reports, () => false, false)).toBe(false)
    expect(isNavItemVisible(reports, key => key === 'reports.view_people_earnings', false)).toBe(true)
    const social = navSections.flatMap(section => section.items).find(item => item.label === 'Social')!
    expect(matchesNavSearch(social, '  Instagram calendar  ')).toBe(true)
    expect(matchesNavSearch(social, 'payroll')).toBe(false)
  })

  it('opens records using the destination pages’ supported links', () => {
    expect(searchResultHref('invoice', 'inv-1')).toBe('/dashboard/invoices?id=inv-1')
    expect(searchResultHref('client', 'client-1')).toBe('/dashboard/clients/client-1')
    expect(searchResultHref('project', 'project-1')).toBe('/dashboard/advertising/project-1')
    expect(searchResultHref('cashbook', 'entry-1')).toBe('/dashboard/cashbook?focus=entry-1')
    expect(searchResultHref('task', 'task-1', 'Launch & design')).toBe('/dashboard/tasks?q=Launch%20%26%20design')
  })
})

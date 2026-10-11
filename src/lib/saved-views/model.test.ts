import { describe, it, expect } from 'vitest'
import {
  SAVED_VIEW_ENTITY_TYPE,
  MAX_SAVED_VIEW_NAME,
  normalizeViewName,
  savedViewSlug,
  normalizeViewQuery,
  buildSavedViewHref,
  hasSavableFilters,
  parseSavedView,
  listSavedViews,
  activeSavedView,
  type SavedViewRow,
} from './model'

/**
 * The improvement plan names three views by example — "My overdue work",
 * "Awaiting client", "Unpaid this month" — and two requirements beyond
 * storing them: restore/share, and that a saved link must not preserve
 * revoked access. The last of those is enforced by `canOpenHref`, which has
 * its own tests; what is tested here is that this module models the view
 * identity, the canonical query and the active-view match correctly.
 */

const row = (over: Partial<SavedViewRow> = {}): SavedViewRow => ({
  id: 'row-1',
  entityType: SAVED_VIEW_ENTITY_TYPE,
  entityId: '/dashboard/invoices::unpaid-this-month',
  href: '/dashboard/invoices?status=unpaid&month=2026-10',
  label: 'Unpaid this month',
  ...over,
})

describe('names', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeViewName('  My   overdue   work ')).toBe('My overdue work')
  })

  it('caps the length so a chip stays a chip', () => {
    expect(normalizeViewName('x'.repeat(200))).toHaveLength(MAX_SAVED_VIEW_NAME)
  })

  it('treats a blank name as no name', () => {
    expect(normalizeViewName('   ')).toBe('')
    expect(savedViewSlug('/dashboard/tasks', '   ')).toBe('')
  })
})

describe('view identity', () => {
  it('is the same view when the same name is re-saved on the same screen', () => {
    // So "save" overwrites rather than piling up near-duplicates — the
    // favourites table's unique constraint does the rest.
    expect(savedViewSlug('/dashboard/invoices', 'Unpaid this month'))
      .toBe(savedViewSlug('/dashboard/invoices', 'unpaid  THIS month!'))
  })

  it('is a different view on a different screen', () => {
    expect(savedViewSlug('/dashboard/tasks', 'Mine'))
      .not.toBe(savedViewSlug('/dashboard/invoices', 'Mine'))
  })

  it('ignores a trailing slash on the path', () => {
    expect(savedViewSlug('/dashboard/tasks/', 'Mine')).toBe(savedViewSlug('/dashboard/tasks', 'Mine'))
  })
})

describe('canonical query', () => {
  it('is order-independent', () => {
    // The list clients write their params in whatever order their effects run,
    // so two identical filter sets routinely produce two different strings.
    expect(normalizeViewQuery('status=overdue&client=acme'))
      .toBe(normalizeViewQuery('client=acme&status=overdue'))
  })

  it('drops where-you-are params so paging does not deselect the view', () => {
    expect(normalizeViewQuery('status=overdue&page=4&focus=INV-21&new=true'))
      .toBe(normalizeViewQuery('status=overdue'))
  })

  it('treats the screens’ "no filter" spellings as absent', () => {
    expect(normalizeViewQuery('status=all&date=null&search=')).toBe('')
  })

  it('round-trips values that need escaping', () => {
    const href = buildSavedViewHref('/dashboard/tasks', 'search=acme %26 co')
    expect(new URLSearchParams(href.split('?')[1]).get('search')).toBe('acme & co')
  })

  it('omits the question mark when nothing is filtered', () => {
    expect(buildSavedViewHref('/dashboard/tasks', 'page=2')).toBe('/dashboard/tasks')
  })
})

describe('offering to save', () => {
  it('declines an unfiltered screen', () => {
    // Saving it would produce a view identical to the sidebar link.
    expect(hasSavableFilters('')).toBe(false)
    expect(hasSavableFilters('page=3&status=all')).toBe(false)
  })

  it('accepts a real filter', () => {
    expect(hasSavableFilters('status=overdue')).toBe(true)
  })
})

describe('reading stored rows', () => {
  it('parses a saved view', () => {
    const v = parseSavedView(row())!
    expect(v.name).toBe('Unpaid this month')
    expect(v.path).toBe('/dashboard/invoices')
    expect(v.href).toBe('/dashboard/invoices?month=2026-10&status=unpaid')
  })

  it('ignores favourites that are not saved views', () => {
    expect(parseSavedView(row({ entityType: 'nav_page', entityId: null }))).toBeNull()
  })

  it('ignores a malformed or unnamed row rather than rendering a nameless chip', () => {
    expect(parseSavedView(row({ entityId: 'no-separator' }))).toBeNull()
    expect(parseSavedView(row({ label: '  ' }))).toBeNull()
  })

  it('lists only this screen’s views, alphabetically', () => {
    const rows = [
      row({ id: 'a', entityId: '/dashboard/invoices::zzz', label: 'Zzz' }),
      row({ id: 'b', entityId: '/dashboard/invoices::awaiting-client', label: 'Awaiting client' }),
      row({ id: 'c', entityId: '/dashboard/tasks::mine', label: 'Mine' }),
      { id: 'd', entityType: 'nav_page', entityId: null, href: '/dashboard/invoices', label: 'Invoices' },
    ]
    expect(listSavedViews(rows, '/dashboard/invoices').map(v => v.name))
      .toEqual(['Awaiting client', 'Zzz'])
  })
})

describe('active view', () => {
  const views = listSavedViews([
    row({ id: 'a', entityId: '/dashboard/invoices::overdue', label: 'Overdue', href: '/dashboard/invoices?status=overdue' }),
    row({ id: 'b', entityId: '/dashboard/invoices::drafts', label: 'Drafts', href: '/dashboard/invoices?status=draft' }),
  ], '/dashboard/invoices')

  it('matches regardless of param order or page', () => {
    expect(activeSavedView(views, 'page=3&status=overdue')?.name).toBe('Overdue')
  })

  it('is nothing when the filters have been changed away', () => {
    expect(activeSavedView(views, 'status=paid')).toBeNull()
  })

  it('is nothing on an unfiltered screen', () => {
    expect(activeSavedView(views, '')).toBeNull()
  })
})

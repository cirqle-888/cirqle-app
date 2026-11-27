import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { UNIT_TEAM_HOME, UNIT_TEAM_PAGES, unitTeamMayOpen } from './access'
import { canOpenHref, isNavItemVisible, navSections } from '@/lib/nav-sections'

/**
 * The leak guard for business units. A unit's team (Social Media, Cirqle
 * Flyers, Memoura…) must never see another unit's data, so they get an
 * allow-list of pages. These tests keep that list honest:
 *
 *   · every allowed page exists and visibly narrows its data to the unit
 *     (the marker named in access.ts is really in the file);
 *   · the pages that show company-wide money or people stay closed;
 *   · the sign-in check really enforces the list, fail-closed.
 */

const ROOT = process.cwd()
const DASHBOARD = join(ROOT, 'src/app/(dashboard)/dashboard')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

describe('unit team allow-list', () => {
  it.each(UNIT_TEAM_PAGES.map(p => [p.href, p]))('%s exists and narrows its data to the unit', (_href, page) => {
    const dir = join(DASHBOARD, page.href.replace('/dashboard/', ''))
    expect(existsSync(dir) && statSync(dir).isDirectory()).toBe(true)
    expect(page.proof.length).toBeGreaterThan(0)
    for (const { file, marker } of page.proof) {
      expect(existsSync(join(ROOT, file)), file).toBe(true)
      expect(read(file).includes(marker), `${file} must contain ${marker} (${page.scopedBy})`).toBe(true)
    }
  })

  it('lands unit members on an allowed page', () => {
    expect(unitTeamMayOpen(UNIT_TEAM_HOME)).toBe(true)
  })

  it.each([
    '/dashboard',
    '/dashboard/invoices', '/dashboard/invoices/follow-ups', '/dashboard/statements', '/dashboard/quotations',
    '/dashboard/cashbook', '/dashboard/cashbook/accounts', '/dashboard/payroll', '/dashboard/employees',
    '/dashboard/finance/profit-sharing', '/dashboard/finance/months', '/dashboard/reports', '/dashboard/reports/department-pnl',
    '/dashboard/partners', '/dashboard/settings', '/dashboard/leads', '/dashboard/advertising', '/dashboard/activity',
    '/dashboard/packages', '/dashboard/orders', '/dashboard/shop', '/dashboard/cirqle-accounts', '/dashboard/analytics',
  ])('keeps %s closed to a unit team', path => {
    expect(unitTeamMayOpen(path)).toBe(false)
  })

  it('matches whole path segments only', () => {
    expect(unitTeamMayOpen('/dashboard/tasks')).toBe(true)
    expect(unitTeamMayOpen('/dashboard/tasks?focus=1')).toBe(true)
    expect(unitTeamMayOpen('/dashboard/clients/abc')).toBe(true)
    expect(unitTeamMayOpen('/dashboard/tasks-archive')).toBe(false)
    expect(unitTeamMayOpen('/dashboard/chatter')).toBe(false)
  })

  it('leaves API routes and public pages to their own checks', () => {
    expect(unitTeamMayOpen('/api/search')).toBe(true)
    expect(unitTeamMayOpen('/login')).toBe(true)
  })

  it('closes every dashboard section that is not on the list', () => {
    const sections = readdirSync(DASHBOARD).filter(n => statSync(join(DASHBOARD, n)).isDirectory() && !n.startsWith('_') && !n.startsWith('('))
    const allowed = new Set(UNIT_TEAM_PAGES.map(p => p.href.split('/')[2]))
    for (const s of sections) expect(unitTeamMayOpen(`/dashboard/${s}`), s).toBe(allowed.has(s))
  })
})

describe('navigation for a unit team', () => {
  const can = () => true // even with every permission, a unit member sees only the unit pages
  it('offers only allowed pages', () => {
    const shown = navSections.flatMap(s => s.items).filter(i => isNavItemVisible(i, can, false, true)).map(i => i.href)
    expect(shown.length).toBeGreaterThan(0)
    for (const h of shown) expect(unitTeamMayOpen(h), h).toBe(true)
  })
  it('shows Departments & Brands to a unit member but not to other staff', () => {
    const item = navSections.flatMap(s => s.items).find(i => i.href === '/dashboard/units')!
    expect(isNavItemVisible(item, can, false, true)).toBe(true)
    expect(isNavItemVisible(item, can, false, false)).toBe(false)
    expect(isNavItemVisible(item, can, true, false)).toBe(true)
  })
  it('refuses a direct link to a closed page', () => {
    expect(canOpenHref('/dashboard/invoices?id=1', can, false, true)).toBe(false)
    expect(canOpenHref('/dashboard/invoices?id=1', can, false, false)).toBe(true)
    expect(canOpenHref('/dashboard/invoices?id=1', can, true, true)).toBe(true)
  })
})

describe('enforcement', () => {
  const mw = read('src/lib/supabase/middleware.ts')
  it('the sign-in check applies the list to unit members', () => {
    expect(mw).toContain("supabase.rpc('my_unit_route_lock')")
    expect(mw).toContain('profile.unitRoutesOnly && !unitTeamMayOpen(pathname)')
  })
  it('fails closed when the membership check errors', () => {
    const block = mw.slice(mw.indexOf("supabase.rpc('my_unit_route_lock')"), mw.indexOf('profile = {', mw.indexOf("supabase.rpc('my_unit_route_lock')")))
    expect(block).toContain("url.pathname = '/login'")
  })
  it('the database function answers only for the caller', () => {
    const sql = read('supabase/migrations/20261127100000_business_units.sql')
    expect(sql).toMatch(/my_unit_route_lock[\s\S]*SECURITY DEFINER/)
    expect(sql).toMatch(/e\.auth_id = auth\.uid\(\)/)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.my_unit_route_lock\(\) TO authenticated/)
    expect(sql).toMatch(/REVOKE ALL ON public\.business_units[\s\S]*FROM anon, authenticated/)
  })
  it('the layout guard knows about units too', () => {
    const layout = read('src/app/(dashboard)/layout.tsx')
    expect(layout).toContain('isUnitConfined(')
    expect(layout).toMatch(/canOpenHref\(requestPath, .*true\)/)
    // The real path must reach the layout on every request, not only when the
    // session cookie is refreshed — otherwise every page looks like
    // '/dashboard' to the unit check and a member bounces forever.
    expect(mw).toContain("request.headers.set('x-request-path', request.nextUrl.pathname)")
    expect(layout).toContain("headersList.get('x-request-path')")
  })
})

describe('no redirect loops', () => {
  it('a unit member lands on a page every member can open, whatever their designation', () => {
    const nobodyCan = () => false
    expect(unitTeamMayOpen(UNIT_TEAM_HOME)).toBe(true)
    expect(canOpenHref(UNIT_TEAM_HOME, nobodyCan, false, true)).toBe(true)
  })
  it('Focus mode never lists untagged company entries (they include salaries)', () => {
    const page = read('src/app/(dashboard)/dashboard/units/[slug]/page.tsx')
    expect(page).toContain('const viewOnly = readOnly || focus')
    expect(page).toContain('untagged={viewOnly ? [] : period.result.untagged}')
  })
})

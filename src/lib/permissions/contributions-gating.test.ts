import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { isNavItemVisible, navSections } from '@/lib/nav-sections'

/**
 * Contributions was the one nav item with no permission on it at all — no
 * `requiredPerm`, no middleware rule, no guard on the page. Anyone signed in
 * could open it, while `contributions.view_own` sat in the Access & Roles
 * screen being counted toward a designation's "Contributions 0/6" and gating
 * nothing.
 *
 * The data was never the problem: rows are stripped to the viewer's own and
 * earnings are withheld at the query, both of which still hold. The problem
 * was a toggle that promised a gate it did not have.
 *
 * The gate accepts ANY rung of the ladder, which is the part most likely to be
 * "simplified" later into a single view_own check — and that would bounce Task
 * Manager and Auditor, who hold view_all WITHOUT view_own. Pinned below.
 */
const RUNGS = ['contributions.view_own', 'contributions.view_unit', 'contributions.view_all']

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const PAGE = read('src/app/(dashboard)/dashboard/contributions/page.tsx')
const MW   = read('src/lib/supabase/middleware.ts')

const navItem = navSections
  .flatMap(s => s.items)
  .find(i => i.href === '/dashboard/contributions')

describe('the Contributions nav item is gated', () => {
  it('exists and asks for a permission', () => {
    expect(navItem, 'Contributions nav item not found').toBeTruthy()
    const keys = [navItem!.requiredPerm, ...(navItem!.requiredAnyPerm ?? [])].filter(Boolean)
    expect(keys.length, 'Contributions must not be ungated').toBeGreaterThan(0)
  })

  it('is hidden from someone holding no contributions permission', () => {
    expect(isNavItemVisible(navItem!, () => false, false)).toBe(false)
  })

  it.each(RUNGS)('is shown to someone holding only %s', (rung) => {
    expect(isNavItemVisible(navItem!, k => k === rung, false)).toBe(true)
  })
})

describe('the route is gated to match the nav item', () => {
  it('has a middleware rule', () => {
    expect(MW).toMatch(/dashboard\\\/contributions/)
  })

  it('accepts every rung, not just view_own', () => {
    const line = MW.split('\n').find(l => l.includes('dashboard\\/contributions'))
    expect(line, 'no middleware line for contributions').toBeTruthy()
    for (const rung of RUNGS) {
      expect(line, `${rung} must open the route`).toContain(rung)
    }
  })

  it('the route table still supports a plain single-key rule', () => {
    // The any-of change must not have broken the 20-odd single-key routes.
    expect(MW).toMatch(/\[RegExp, string \| string\[\]\]/)
    expect(MW).toContain("'billing.view_invoices'")
  })
})

describe('the page guards itself, not just the link', () => {
  it('redirects a viewer holding none of the rungs', () => {
    // A hidden nav item still leaves a working URL; this is the real gate.
    expect(PAGE).toMatch(/if\s*\(!canSeeAnyContributions\)\s*redirect\(/)
  })

  it('treats view_own as the lowest rung, not the required one', () => {
    const guard = PAGE.slice(PAGE.indexOf('canSeeAnyContributions'), PAGE.indexOf('redirect('))
    expect(guard).toContain('CONTRIBUTIONS_VIEW_OWN')
    expect(guard).toContain('CONTRIBUTIONS_VIEW_UNIT')
    expect(guard).toContain('viewAll')
  })

  it('still strips rows to the viewer when view_all is absent', () => {
    // The protection that was always there and must survive the new gate.
    expect(PAGE).toContain('rows.filter(r => r.employee_id === myEmployeeId)')
  })

  it('still withholds earnings at the query, not just the UI', () => {
    expect(PAGE).toContain('vis.contributionEarnings')
  })
})

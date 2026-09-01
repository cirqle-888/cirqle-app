import { describe, it, expect } from 'vitest'
import { guardDecision, type GuardSubject } from './check'

const staff = (over: Partial<GuardSubject> = {}): GuardSubject => ({
  isArchived: false, isViewAs: false, isAdmin: false,
  designationId: 'd1', hasPermission: true, ...over,
})

const WRITE = { allowViewAs: false }
const READ = { allowViewAs: true }

describe('the ordinary path', () => {
  it('lets a permitted employee through, for reads and writes alike', () => {
    expect(guardDecision(staff(), WRITE).ok).toBe(true)
    expect(guardDecision(staff(), READ).ok).toBe(true)
  })

  it('refuses without the permission', () => {
    expect(guardDecision(staff({ hasPermission: false }), WRITE)).toMatchObject({ ok: false })
    expect(guardDecision(staff({ hasPermission: false }), READ)).toMatchObject({ ok: false })
  })

  it('refuses when signed out or archived, whatever else is true', () => {
    expect(guardDecision(null, READ)).toMatchObject({ ok: false })
    expect(guardDecision(staff({ isArchived: true, isAdmin: true }), READ)).toMatchObject({ ok: false })
  })
})

describe('view-as preview', () => {
  const previewing = (over: Partial<GuardSubject> = {}) => staff({ isViewAs: true, ...over })

  it('WRITES are refused — the guarantee the whole feature rests on', () => {
    const res = guardDecision(previewing(), WRITE)
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/read-only/i)
  })

  it('previewing an ADMIN does not hand the writes back', () => {
    // The check must sit before the isAdmin short-circuit, or an admin
    // previewing an admin silently regains every mutation.
    expect(guardDecision(previewing({ isAdmin: true }), WRITE)).toMatchObject({ ok: false })
  })

  it('a dev bypass does not reopen writes during a preview either', () => {
    expect(guardDecision(previewing(), { allowViewAs: false, devBypass: true }))
      .toMatchObject({ ok: false })
  })

  it('READS are allowed — this is the bug that made the preview lie', () => {
    // Reads used to go through the write guard. The invoice panel spun on
    // "Loading line items…" forever and its PDF rendered a total with no
    // lines, so an admin checking a Task Manager concluded that role could not
    // see invoices — when it holds billing.view_invoices and can.
    expect(guardDecision(previewing(), READ).ok).toBe(true)
  })

  it('a read still enforces the permission — preview is not a skeleton key', () => {
    // The preview must show LESS when the previewed employee sees less. If
    // allowViewAs also skipped the permission check, every preview would show
    // an admin's view and be just as untrue in the other direction.
    expect(guardDecision(previewing({ hasPermission: false }), READ)).toMatchObject({ ok: false })
  })

  it('an archived employee is still refused reads', () => {
    expect(guardDecision(previewing({ isArchived: true }), READ)).toMatchObject({ ok: false })
  })
})

describe('admins and designations', () => {
  it('an admin passes without holding the key explicitly', () => {
    expect(guardDecision(staff({ isAdmin: true, hasPermission: false }), WRITE).ok).toBe(true)
  })

  it('no designation and not an admin is refused', () => {
    expect(guardDecision(staff({ designationId: null }), READ)).toMatchObject({ ok: false })
  })

  it('reports whether the pass came from being an admin', () => {
    expect(guardDecision(staff({ isAdmin: true }), READ)).toMatchObject({ ok: true, isAdmin: true })
    expect(guardDecision(staff(), READ)).toMatchObject({ ok: true, isAdmin: false })
  })
})

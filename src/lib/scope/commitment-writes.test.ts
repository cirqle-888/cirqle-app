/**
 * REGRESSION GUARD for commitment write paths.
 *
 * Two invariants protect historical money, and both are easy to break with a
 * one-character edit:
 *
 *   1. NEVER write `commission_percentage: 0` to mean "unset". Every reader
 *      guards with `?? 50` or `!= null`; neither catches 0, so a 0 is a REAL
 *      rate that collapses the pair's commission pool and rewrites earnings
 *      already booked against it.
 *   2. NEVER hard-DELETE a client_service_pricing row. It carries the agreed
 *      price that historical commission recompute still reads.
 *
 * These assert on source text because the failure is a silent value change in
 * production, long after any behavioural test would have passed.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

/** Every file that writes client_service_pricing. */
const WRITE_PATHS = [
  'src/components/ui/client-edit-modal.tsx',
  'src/app/(dashboard)/dashboard/settings/settings-client.tsx',
  'src/app/(dashboard)/dashboard/settings/actions.ts',
  'src/app/(dashboard)/dashboard/pricing-matrix/pricing-matrix-client.tsx',
  'src/app/(dashboard)/dashboard/tasks/tasks-client.tsx',
  'src/app/(dashboard)/dashboard/import/import-client.tsx',
  'src/app/(dashboard)/dashboard/reports/what-if/apply-actions.ts',
]

describe('no write path coerces commission_percentage to 0', () => {
  it.each(WRITE_PATHS)('%s', file => {
    const src = read(file)
    // The exact shapes that caused the incident: a literal 0, or `|| 0` / `?? 0`
    // applied to a commission value.
    expect(src).not.toMatch(/commission_percentage:\s*0\b/)
    expect(src).not.toMatch(/commission_percentage:\s*[^,\n]*\|\|\s*0\b/)
    expect(src).not.toMatch(/commission_percentage:\s*[^,\n]*\?\?\s*0\b/)
  })
})

describe('no write path hard-deletes a commitment row', () => {
  it.each(WRITE_PATHS)('%s', file => {
    const src = read(file)
    // Catches `.from('client_service_pricing').delete()` in either order of
    // chaining, allowing whitespace/newlines between the calls.
    expect(src).not.toMatch(/from\(['"]client_service_pricing['"]\)[\s\S]{0,80}?\.delete\(/)
  })

  it('the import Clean-up tab special-cases pricing_matrix before its generic delete', () => {
    const src = read('src/app/(dashboard)/dashboard/import/import-client.tsx')
    const guard = src.indexOf("cleanupMode === 'pricing_matrix'")
    const genericDelete = src.indexOf("batchDelete(TABLE_FOR_MODE[cleanupMode]")
    expect(guard).toBeGreaterThan(-1)
    expect(genericDelete).toBeGreaterThan(-1)
    // The deactivation branch must come first AND return, or the generic
    // hard delete below would still run for commitments.
    expect(guard).toBeLessThan(genericDelete)
  })
})

describe('the backfill script preserves historical commission', () => {
  const src = read('scripts/seed-client-commitments.mjs')

  it('writes commission_percentage explicitly as null on new rows', () => {
    // Explicit null, never omitted: the column DEFAULTs to 0, which is the one
    // value that destroys history.
    expect(src).toMatch(/commission_percentage:\s*null/)
  })

  it('never inserts a literal 0 commission', () => {
    expect(src).not.toMatch(/commission_percentage:\s*0\b/)
  })

  it('deactivates rather than deletes', () => {
    expect(src).toMatch(/is_active:\s*false/)
    expect(src).not.toMatch(/\.delete\(\)/)
  })

  it('chunks id-list updates so a large batch cannot exceed the request limit', () => {
    expect(src).toMatch(/CHUNK\s*=\s*\d+/)
    expect(src).toMatch(/for \(let i = 0; i < ids\.length; i \+= CHUNK\)/)
  })

  it('writes audit rows per batch rather than deferring them to the end', () => {
    // The audit table is append-only, so a trail lost to a later failure can
    // never be reconstructed.
    const applyStart = src.indexOf('// ── Apply')
    const audits = [...src.slice(applyStart).matchAll(/await writeAudit\(/g)]
    expect(audits.length).toBeGreaterThanOrEqual(3)   // one per write batch
  })

  it('carries the intake-preservation guardrail', () => {
    expect(src).toMatch(/intake[- ]preservation guardrail/i)
    expect(src).toMatch(/intakeKind/)
  })
})

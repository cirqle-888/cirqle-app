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

  /**
   * The row literal passed to `.from('client_service_pricing').insert(` — the
   * only place a NEW commitment row is born, and therefore the only place the
   * DB DEFAULT 0 can apply. Extracted by brace-matching from the call site so
   * assertions cannot be satisfied by an unrelated occurrence elsewhere.
   */
  const insertObject = (() => {
    const call = src.indexOf(".from('client_service_pricing').insert(")
    expect(call).toBeGreaterThan(-1)
    const open = src.indexOf('{', src.indexOf('=> (', call))
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1)
    }
    throw new Error('unbalanced braces in the insert row literal')
  })()

  it('writes commission_percentage explicitly as null on new rows', () => {
    // Explicit null, never omitted: the column DEFAULTs to 0, which is the one
    // value that destroys history.
    //
    // MUST be scoped to the insert. A file-wide /commission_percentage:\s*null/
    // is satisfied by the audit payload two lines below, so deleting the null
    // from the insert — restoring the exact defect this guards — left the test
    // green. Mutation-tested: removing line 307 now fails.
    expect(insertObject).toMatch(/commission_percentage:\s*null/)
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

  it('audits inside the chunk loop, not after it', () => {
    // The audit table is append-only, so a trail lost to a crash between the
    // last UPDATE and a deferred audit call can never be reconstructed — rows
    // would be silently changed with no record. The write must be audited
    // before the next chunk is attempted.
    const fn = src.indexOf('async function chunkedUpdate(')
    const body = src.slice(fn, src.indexOf('\n}', fn))
    const loop = body.indexOf('for (let i = 0')
    const audit = body.indexOf('await writeAudit(')
    const ret = body.indexOf('return {')
    expect(loop).toBeGreaterThan(-1)
    expect(audit).toBeGreaterThan(loop)   // inside the loop…
    expect(audit).toBeLessThan(ret)       // …not after it
  })

  it('audits every apply path', () => {
    // create writes directly; reactivate/deactivate go through chunkedUpdate
    // and must each hand it an auditFor callback — omitting one would apply
    // hundreds of rows with no trail.
    const apply = src.slice(src.indexOf('// ── Apply'))
    expect([...apply.matchAll(/await writeAudit\(/g)]).toHaveLength(1)
    expect([...apply.matchAll(/slice => slice\.map/g)]).toHaveLength(2)
  })

  it('carries the intake-preservation guardrail', () => {
    expect(src).toMatch(/intake[- ]preservation guardrail/i)
    expect(src).toMatch(/intakeKind/)
  })
})

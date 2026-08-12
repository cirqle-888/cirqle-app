import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Contract test for the earnings write path.
 *
 * recalcTaskCommissions upserted three columns that do not exist on
 * contribution_scores (previous_earnings_inr, previous_score_percentage,
 * previous_performance_rating_used). PostgREST rejected every write with
 * PGRST204 — and because the result was discarded, the function returned
 * { success: true, updatedCount: n } for rows it had never written.
 *
 * The damage was not the failure but the lie: every repair path built on this
 * one — the contributions self-heal, agreement work-value re-stamps, payroll
 * recalculation — reported success while earnings stayed at ₹0. Three tasks
 * sat unpaid through repeated "successful" repairs.
 *
 * A unit test cannot catch a column-name mismatch (the client is mocked and
 * accepts anything), so this asserts on the source: the payload may only name
 * columns the table actually has, and the write result must be inspected.
 */
const SRC = readFileSync(join(process.cwd(), 'src/lib/sync/integrity.ts'), 'utf8')

/** Columns that exist on public.contribution_scores. */
const REAL_COLUMNS = new Set([
  'id', 'task_id', 'employee_id', 'score_percentage', 'earnings_inr', 'calculated_at',
  'is_manual_override', 'earning_source', 'agreement_id', 'previous_earnings',
  'previous_performance_rating', 'recalculated_at', 'recalculated_by',
])

/** Columns that never existed and silently broke every write. */
const PHANTOM_COLUMNS = [
  'previous_earnings_inr',
  'previous_score_percentage',
  'previous_performance_rating_used',
]

describe('contribution_scores write path', () => {
  it('never references a column the table does not have', () => {
    for (const phantom of PHANTOM_COLUMNS) {
      expect(SRC, `${phantom} does not exist on contribution_scores — upserts naming it fail PGRST204`)
        .not.toContain(`${phantom}:`)
    }
  })

  it('only writes known columns in the recalc upsert', () => {
    const block = SRC.slice(SRC.indexOf('const upsertBatch'), SRC.indexOf("from('contribution_scores').upsert"))
    for (const [, key] of block.matchAll(/^\s{10,}([a-z_]+):/gm)) {
      expect(REAL_COLUMNS, `upsert names unknown column "${key}"`).toContain(key)
    }
  })

  it('inspects the upsert result instead of discarding it', () => {
    const i = SRC.indexOf("from('contribution_scores').upsert")
    const around = SRC.slice(i - 220, i + 220)
    expect(around, 'the upsert error must be captured').toMatch(/error\s*:\s*\w+\s*\}\s*=\s*await/)
    expect(around, 'a failed write must not be reported as success').toMatch(/if \(\w*[Ee]rr\w*\)/)
  })

  it('does not report success for a write it did not perform', () => {
    const tail = SRC.slice(SRC.indexOf("from('contribution_scores').upsert"))
    const successIdx = tail.indexOf('success: true')
    const guardIdx = tail.search(/return \{ error:/)
    expect(guardIdx, 'the error return must precede the success return').toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(successIdx)
  })
})

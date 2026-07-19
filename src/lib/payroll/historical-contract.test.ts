/**
 * REGRESSION GUARD for the historical-reader contract.
 *
 * The rule: `client_service_pricing.is_active` governs what a client may be
 * SOLD today — it must NEVER govern what was EARNED. Every reader that
 * resolves a commission_percentage for an EXISTING task must read the pricing
 * table unfiltered, or deactivating a commitment silently reprices all of that
 * pair's history to the 50% fallback.
 *
 * These tests read the source files, because the defect this guards against is
 * someone "tidying up" an inconsistency by adding `.eq('is_active', true)` to
 * a historical query. A behavioural test would not catch that until money was
 * already wrong in production.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { buildAnalysisRows } from '@/lib/reports/contribution-analysis'

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')

/** Files whose client_service_pricing reads resolve HISTORICAL money. */
const HISTORICAL_READERS = [
  'src/lib/payroll/compute.ts',
  'src/lib/sync/integrity.ts',
  'src/lib/sync/agreement-earnings.ts',
  'src/app/api/recalc-commissions/route.ts',
]

/**
 * Extract each `.from('client_service_pricing')` query with ONLY its own
 * chained calls — stopping at the first line that does not continue the chain,
 * so an adjacent query's legitimate `is_active` filter is never mistaken for
 * this one's. (Sibling queries on `tools` / `parameters` genuinely do filter
 * is_active; they are operational, not historical.)
 */
function pricingQueries(src: string): string[] {
  const marker = "from('client_service_pricing')"
  const out: string[] = []
  for (let i = src.indexOf(marker); i !== -1; i = src.indexOf(marker, i + 1)) {
    const lines = src.slice(i).split('\n')
    const chain = [lines[0]]
    for (const line of lines.slice(1)) {
      if (!/^\s*\./.test(line)) break        // chain ended
      chain.push(line)
    }
    out.push(chain.join('\n'))
  }
  return out
}

describe('historical readers must NOT filter client_service_pricing by is_active', () => {
  it.each(HISTORICAL_READERS)('%s', file => {
    const queries = pricingQueries(read(file))
    expect(queries.length).toBeGreaterThan(0)   // the reader still exists
    for (const chain of queries) expect(chain).not.toMatch(/is_active/)
  })

  it('each historical reader carries the contract comment explaining why', () => {
    for (const file of HISTORICAL_READERS) {
      expect(read(file)).toMatch(/HISTORICAL READER CONTRACT/)
    }
  })
})

describe('operational readers SHOULD filter by is_active', () => {
  // The mirror assertion: capability/picker surfaces must respect deactivation,
  // otherwise a removed service keeps appearing to staff and clients.
  it.each([
    'src/lib/services/intake-server.ts',
    'src/lib/scope/service-scope.ts',
  ])('%s narrows to active commitments', file => {
    const src = read(file)
    expect(src).toMatch(/is_active/)
  })
})

/**
 * Extract a named function's body, from its declaration to the first
 * column-0 `}`. Used to assert per-writer ordering without an adjacent
 * function's guard standing in for a missing one.
 */
function functionBody(src: string, name: string): string {
  const decl = src.search(new RegExp(`(export )?async function ${name}\\b`))
  expect(decl).toBeGreaterThan(-1)
  const end = src.indexOf('\n}', decl)
  return src.slice(decl, end === -1 ? undefined : end)
}

describe('every writer of earnings_inr guards finalized payroll BEFORE writing', () => {
  // There are four independent writers, each reachable directly — so each
  // carries its own guard rather than trusting callers. A missing or
  // short-circuited guard silently reprices months already paid out.
  it.each([
    ['src/lib/sync/integrity.ts', 'recalcTaskCommissions'],
    ['src/lib/sync/integrity.ts', 'refreshStoredEarningsFromBilling'],
    ['src/lib/sync/agreement-earnings.ts', 'syncTaskAgreementEarnings'],
    ['src/lib/payroll/compute.ts', 'refreshMonthStoredEarnings'],
  ])('%s → %s', (file, fn) => {
    const body = functionBody(read(file), fn)

    const guard = body.indexOf('isMonthFinalized')
    expect(guard).toBeGreaterThan(-1)          // the guard exists at all…

    // …in THIS function, not merely somewhere in the file, and it must sit
    // above every write. `recalcTaskCommissions` originally guarded only its
    // fallback branch while the primary path wrote unguarded.
    const write = body.search(/\.(update|upsert|insert)\(/)
    expect(write).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(write)

    // The guard must return, not just evaluate.
    expect(body.slice(guard, guard + 400)).toMatch(/return\b/)

    // And it must not be short-circuited into a no-op — `false && await
    // isMonthFinalized(...)` keeps every other assertion above green.
    const condition = body.slice(body.lastIndexOf('if (', guard), guard)
    expect(condition).not.toMatch(/\bfalse\b/)
  })
})

describe('buildAnalysisRows: a deactivated commitment still resolves its earned rate', () => {
  const task = {
    id: 't1', client_id: 'c1', service_id: 's1',
    billing_amount_inr: 10_000, task_date: '2024-06-01',
    title: 'x', status: 'done', quantity: 1,
  } as any
  const scores = [{ task_id: 't1', employee_id: 'e1', score_percentage: 100, earnings_inr: 0 }] as any
  const names = new Map([['c1', 'C']]), svc = new Map([['s1', 'S']])

  const run = (pricing: any[]) =>
    buildAnalysisRows([task], scores, pricing as any, names, svc)

  it('uses the row rate (75%), not the 50% fallback, for a deactivated pair', () => {
    // The row carries is_active=false in the DB; the reader is is_active-blind,
    // so buildAnalysisRows only ever sees the rate — which IS the contract.
    expect(run([{ client_id: 'c1', service_id: 's1', commission_percentage: 75 }])[0].commission_pct).toBe(75)
  })

  it('falls back to 50% ONLY when no row exists — the value the backfill must preserve', () => {
    expect(run([])[0].commission_pct).toBe(50)
  })

  it('a commission of 0 is honoured as a real value, NOT treated as missing', () => {
    // This is why the backfill must never let the DB default (0) land on a new
    // row: `?? fallback` does not catch 0, so the pool collapses to zero.
    const row = run([{ client_id: 'c1', service_id: 's1', commission_percentage: 0 }])[0]
    expect(row.commission_pct).toBe(0)
    expect(row.total_earnings).toBe(0)
  })

  it('inserting 50 is byte-identical to having no row at all (the backfill invariant)', () => {
    const withRow = run([{ client_id: 'c1', service_id: 's1', commission_percentage: 50 }])[0]
    const noRow = run([])[0]
    expect(withRow.commission_pct).toBe(noRow.commission_pct)
    expect(withRow.total_earnings).toBe(noRow.total_earnings)
  })
})

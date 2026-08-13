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
  // Every writer reachable directly carries its own guard rather than trusting
  // callers. A missing, inverted or short-circuited guard silently reprices
  // months already paid out.
  //
  // An independent audit mutation-tested an earlier version of this test and
  // got THREE survivors: `&& false` placed AFTER the call (the old check only
  // sliced text before it), an inverted `!(await …)` (maximally destructive —
  // recomputes finalized months and skips everything else), and replacing the
  // `return` with a `console.warn` (the old check accepted any `return` within
  // 400 chars). All three are now caught by asserting the guard's exact shape.
  // `style` is how the guard stops the write:
  //   'return' — single-task writers bail out immediately.
  //   'filter' — the recalc route takes a date RANGE, so it cannot return on
  //              the first finalized month; it excludes those tasks instead.
  it.each([
    ['src/lib/sync/integrity.ts', 'recalcTaskCommissions', 'return'],
    ['src/lib/sync/integrity.ts', 'refreshStoredEarningsFromBilling', 'return'],
    ['src/lib/payroll/compute.ts', 'refreshMonthStoredEarnings', 'return'],
    ['src/app/api/recalc-commissions/route.ts', 'POST', 'filter'],
  ])('%s → %s', (file, fn, style) => {
    const body = functionBody(read(file), fn)

    const guard = body.search(/is(MonthFinalized|TaskMonthProtected)\(/)
    expect(guard).toBeGreaterThan(-1)          // the guard exists at all…

    // …in THIS function, not merely somewhere in the file, and above every
    // write. recalcTaskCommissions originally guarded only its fallback branch
    // while the primary path wrote unguarded.
    const write = body.search(/\.(update|upsert|insert)\(/)
    expect(write).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(write)

    // Assert the WHOLE guard statement, from `if (` through its closing paren,
    // so a mutation on either side of the call is visible.
    const open = body.lastIndexOf('if (', guard)
    expect(open).toBeGreaterThan(-1)
    let depth = 0, close = -1
    for (let i = body.indexOf('(', open); i < body.length; i++) {
      if (body[i] === '(') depth++
      else if (body[i] === ')' && --depth === 0) { close = i; break }
    }
    expect(close).toBeGreaterThan(guard)
    const condition = body.slice(open, close + 1)

    // Not neutralized (`&& false`, `|| true`) on EITHER side of the call…
    expect(condition).not.toMatch(/\b(false|true)\b/)
    // …and not inverted: the guard fires WHEN finalized, never when not.
    expect(condition).not.toMatch(/!\s*\(?\s*await/)
    expect(condition).not.toMatch(/!is(MonthFinalized|TaskMonthProtected)/)

    // And it must actually stop the write.
    const after = body.slice(close + 1)
    if (style === 'return') {
      // The very next statement returns — no falling through to the write.
      expect(after).toMatch(/^\s*(\{\s*)?return\b/)
    } else {
      // The guard's verdict is recorded, then used to EXCLUDE tasks before
      // the write. Both halves matter: recording without filtering would
      // compute a set nobody consults.
      expect(after).toMatch(/^\s*finalized\.add\(/)
      // Anchor on the exclusion itself, not on any `.filter(` — the month-key
      // extraction above the guard also uses one.
      const excludeAt = body.indexOf('!finalized.has(')
      expect(excludeAt).toBeGreaterThan(guard)
      expect(excludeAt).toBeLessThan(write)
    }
  })
})

describe('money readers paginate client_service_pricing', () => {
  // PostgREST silently caps a response at 1000 rows. This table is 809 rows
  // and only ever GROWS (deactivation never deletes), so an unpaginated read
  // is ~190 rows from dropping pairs — and every task on a dropped pair would
  // reprice via `?? 50`. The failure is completely silent: no error, just
  // wrong money.
  it.each([
    'src/lib/payroll/compute.ts',
    'src/lib/sync/integrity.ts',
    'src/app/api/recalc-commissions/route.ts',
  ])('%s', file => {
    const src = read(file)
    let checked = 0
    // Capture from the START of the statement's line: the `fetchAll(` wrapper
    // sits BEFORE `from(...)`, so a chain extracted at the `from` marker never
    // contains it.
    const chains = src.split('\n').reduce<string[]>((acc, line, i, lines) => {
      if (!line.includes("from('client_service_pricing')")) return acc
      let stmt = line
      for (let k = i + 1; k < lines.length && /^\s*[.)]/.test(lines[k]); k++) stmt += '\n' + lines[k]
      acc.push(stmt)
      return acc
    }, [])
    for (const chain of chains) {
      // Only WHOLE-TABLE reads need pagination. A single-pair lookup
      // (`.eq(client).eq(service).maybeSingle()`) returns at most one row and
      // is unaffected by the 1000-row cap.
      if (/\.eq\(|maybeSingle|\.single\(/.test(chain)) continue
      checked++
      expect(chain, 'unpaginated whole-table money read').toMatch(/fetchAll\(|\.range\(/)
      expect(chain, 'pagination needs a stable order').toMatch(/\.order\(/)
    }
    expect(checked, 'no whole-table pricing read found — did the reader move?').toBeGreaterThan(0)
  })
})

describe('the finalized-month check fails CLOSED', () => {
  const src = read('src/lib/payroll/compute.ts')

  it('isMonthFinalized treats a query error as finalized', () => {
    // Mutation that survived: `if (error) return true` -> `return false`.
    // Failing OPEN means a transient DB error silently re-enables rewriting a
    // paid month — the single worst outcome, and invisible.
    const body = src.slice(src.indexOf('export async function isMonthFinalized'))
    const fn = body.slice(0, body.indexOf('\n}'))
    expect(fn).toMatch(/if \(error\) return true/)
    expect(fn, 'fails OPEN on error').not.toMatch(/if \(error\) return false/)
  })

  it('isTaskMonthProtected treats an unreadable task_date as protected', () => {
    const body = src.slice(src.indexOf('export async function isTaskMonthProtected'))
    const fn = body.slice(0, body.indexOf('\n}'))
    // A null / malformed / out-of-range date must return true, not fall through.
    expect(fn).toMatch(/Number\.isInteger\(y\)/)
    expect(fn).toMatch(/Number\.isInteger\(m\)/)
    expect(fn).toMatch(/m < 1 \|\| m > 12/)
    expect(fn).toMatch(/return true/)
    // The bad-date branch must return BEFORE the DB lookup, not after.
    expect(fn.indexOf('return true')).toBeLessThan(fn.indexOf('isMonthFinalized('))
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

  it('a NULL commission is byte-identical to having no row — what the backfill inserts', () => {
    // The backfill creates 5 rows with commission_percentage: null, and some of
    // those pairs have live tasks. Every prior case here covered 75 / 0 / 50 /
    // no-row but never NULL — the exact value being written. If any resolver
    // distinguished null from absent (e.g. via `.has()` or `!== undefined`),
    // those 5 pairs would reprice the moment the row appeared.
    const withNull = run([{ client_id: 'c1', service_id: 's1', commission_percentage: null }])[0]
    const noRow = run([])[0]
    expect(withNull.commission_pct).toBe(noRow.commission_pct)
    expect(withNull.total_earnings).toBe(noRow.total_earnings)
    expect(withNull.commission_pct).toBe(50)   // falls through to the fallback
  })

  it('inserting 50 is byte-identical to having no row at all (the backfill invariant)', () => {
    const withRow = run([{ client_id: 'c1', service_id: 's1', commission_percentage: 50 }])[0]
    const noRow = run([])[0]
    expect(withRow.commission_pct).toBe(noRow.commission_pct)
    expect(withRow.total_earnings).toBe(noRow.total_earnings)
  })
})

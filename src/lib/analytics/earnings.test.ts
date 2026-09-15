import { describe, it, expect } from 'vitest'
import {
  aggregateEarnings, dedupeScores, mergeEarnings, sliceEarnings,
  type ScoreRow,
} from './earnings'

/**
 * The two ways an earnings aggregate silently lies, and the honesty flag.
 *
 * Double-counting a recalculated task, and dating a row by when the sum ran
 * rather than when the work happened. Both produce a bigger, plausible number
 * that nobody audits. The third group checks the aggregate ADMITS a window it
 * cannot answer exactly instead of quietly rounding a month up.
 */

const score = (
  employee: string, taskId: string, date: string | null,
  earnings: number, pct = 100, qty = 1,
): ScoreRow => ({
  employee_id: employee,
  score_percentage: pct,
  earnings_inr: earnings,
  task: { id: taskId, quantity: qty, task_date: date },
})

const FAR = '0000-00-00'   // keep every day
const of = (agg: ReturnType<typeof aggregateEarnings>, id: string, bucket: string) =>
  agg.months.find(m => m.employeeId === id && m.bucket === bucket)

describe('a recalculated task is counted once', () => {
  it('keeps the NEWEST row per employee and task', () => {
    // The query returns newest first. Both rows are the same task scored twice.
    const rows = [score('e1', 't1', '2024-03-04', 500), score('e1', 't1', '2024-03-04', 400)]
    expect(dedupeScores(rows)).toHaveLength(1)
    expect(dedupeScores(rows)[0].earnings_inr).toBe(500)
  })

  it('does not collapse two EMPLOYEES on one task', () => {
    // A shared task writes one row per contributor at the same instant.
    // Deduplicating by task alone would delete everybody but the first.
    const rows = [score('e1', 't1', '2024-03-04', 300), score('e2', 't1', '2024-03-04', 200)]
    expect(dedupeScores(rows)).toHaveLength(2)
  })

  it('the aggregate itself deduplicates, so a caller cannot forget', () => {
    const agg = aggregateEarnings(
      [score('e1', 't1', '2024-03-04', 500), score('e1', 't1', '2024-03-04', 400)], FAR)
    expect(of(agg, 'e1', '2024-03')?.earningsInr).toBe(500)
    expect(of(agg, 'e1', '2024-03')?.taskCount).toBe(1)
  })

  it('drops a row whose task is missing entirely', () => {
    const orphan: ScoreRow = { employee_id: 'e1', score_percentage: 100, earnings_inr: 999, task: null }
    expect(aggregateEarnings([orphan], FAR).months).toEqual([])
  })
})

describe('work is dated by the task, never by the calculation', () => {
  it('buckets by task_date', () => {
    const agg = aggregateEarnings([score('e1', 't1', '2024-03-04', 500)], FAR)
    expect(agg.months.map(m => m.bucket)).toEqual(['2024-03'])
  })

  it('EXCLUDES a row with no task_date rather than guessing one', () => {
    // The row-by-row path drops these to prevent recalculation history from
    // leaking into a month it did not belong to. So does this.
    const agg = aggregateEarnings(
      [score('e1', 't1', null, 500), score('e1', 't2', '2024-03-04', 100)], FAR)
    expect(agg.months).toHaveLength(1)
    expect(of(agg, 'e1', '2024-03')?.earningsInr).toBe(100)
  })
})

describe('creatives credited, not tasks touched', () => {
  it('counts a share of a multi-creative task, not the whole task', () => {
    // 30% of a 10-creative task is 3 creatives credited.
    const agg = aggregateEarnings([score('e1', 't1', '2024-03-04', 100, 30, 10)], FAR)
    expect(of(agg, 'e1', '2024-03')?.creatives).toBe(3)
    expect(of(agg, 'e1', '2024-03')?.taskCount).toBe(1)
  })

  it('treats a missing quantity as one creative, like the live counter', () => {
    const row = score('e1', 't1', '2024-03-04', 100, 100)
    row.task!.quantity = null
    expect(of(aggregateEarnings([row], FAR), 'e1', '2024-03')?.creatives).toBe(1)
  })
})

describe('the aggregate carries no names', () => {
  it('holds employee ids and nothing that could be one', () => {
    const agg = aggregateEarnings([score('e1', 't1', '2024-03-04', 500)], FAR)
    expect(Object.keys(agg.months[0]).sort())
      .toEqual(['bucket', 'creatives', 'earningsInr', 'employeeId', 'taskCount'])
  })
})

describe('history joined to the live month', () => {
  const history = aggregateEarnings([score('e1', 't1', '2024-03-04', 500)], '2024-03-01')

  it('adds both halves once', () => {
    const merged = mergeEarnings(history, [score('e1', 't9', '2026-09-02', 250)])
    expect(merged.months.map(m => m.bucket)).toEqual(['2024-03', '2026-09'])
  })

  it('live wins where both describe the same month', () => {
    // The current month must never be served from cache, even if a stale
    // entry happens to contain it.
    const stale = aggregateEarnings([score('e1', 't1', '2026-09-01', 999)], '2026-09-01')
    const merged = mergeEarnings(stale, [score('e1', 't1', '2026-09-01', 250)])
    expect(merged.months).toHaveLength(1)
    expect(merged.months[0].earningsInr).toBe(250)
  })
})

describe('slicing to a window', () => {
  // Two whole months plus a recent month with day detail.
  const rows = [
    score('e1', 'a', '2024-03-04', 100), score('e1', 'b', '2024-04-04', 200),
    score('e1', 'c', '2026-09-02', 300), score('e1', 'd', '2026-09-20', 400),
    score('e2', 'e', '2026-09-02', 50),
  ]
  const agg = aggregateEarnings(rows, '2026-08-01')

  it('totals everything when there is no filter', () => {
    const s = sliceEarnings(agg, null)
    expect(s.byEmployee.get('e1')!.earningsInr).toBe(1000)
    expect(s.exact).toBe(true)
  })

  it('totals a whole month exactly from the month rows', () => {
    const s = sliceEarnings(agg, { from: '2024-03-01', to: '2024-03-31' })
    expect(s.byEmployee.get('e1')!.earningsInr).toBe(100)
    expect(s.exact).toBe(true)
  })

  it('totals a PARTIAL recent month exactly from the day rows', () => {
    // The case every preset filter hits: last 7 days, last 30, yesterday.
    const s = sliceEarnings(agg, { from: '2026-09-01', to: '2026-09-10' })
    expect(s.byEmployee.get('e1')!.earningsInr).toBe(300)
    expect(s.byEmployee.get('e2')!.earningsInr).toBe(50)
    expect(s.exact).toBe(true)
  })

  it('spans months, mixing whole ones with a cut one', () => {
    const s = sliceEarnings(agg, { from: '2024-03-01', to: '2026-09-10' })
    expect(s.byEmployee.get('e1')!.earningsInr).toBe(600)
    expect(s.exact).toBe(true)
  })

  it('ADMITS when a custom range cuts a month it has no days for', () => {
    // The one inexact case. It returns March's whole total and flags it,
    // rather than returning a smaller number it cannot justify.
    const s = sliceEarnings(agg, { from: '2024-03-10', to: '2024-03-20' })
    expect(s.exact).toBe(false)
    expect(s.byEmployee.get('e1')!.earningsInr).toBe(100)
  })

  it('is empty for a window with no work in it', () => {
    const s = sliceEarnings(agg, { from: '2025-01-01', to: '2025-01-31' })
    expect(s.byEmployee.size).toBe(0)
  })

  it('never counts a month twice when day rows also cover it', () => {
    // The trap in a two-pass slice: September is both a month row and four
    // day rows, and a whole-September window must not add both.
    const s = sliceEarnings(agg, { from: '2026-09-01', to: '2026-09-30' })
    expect(s.byEmployee.get('e1')!.earningsInr).toBe(700)
  })
})

describe('the aggregate agrees with a row-by-row sum', () => {
  it('matches what the dashboard computes today, per employee', () => {
    const rows: ScoreRow[] = []
    for (let i = 0; i < 400; i++) {
      rows.push(score(`e${i % 5}`, `t${i}`, `2024-0${(i % 9) + 1}-1${i % 9}`, (i * 37) % 900, (i % 4 + 1) * 25, (i % 3) + 1))
    }
    // …plus recalculations of the first ten, newest first, which must not count.
    const withDupes = [...rows.slice(0, 10).map(r => ({ ...r, earnings_inr: 1_000_000 })), ...rows]

    const direct = new Map<string, { e: number; c: number; q: number }>()
    for (const r of dedupeScores(withDupes)) {
      const d = direct.get(r.employee_id) ?? { e: 0, c: 0, q: 0 }
      d.e += r.earnings_inr || 0
      d.c += 1
      d.q += Number(r.task!.quantity ?? 1) * ((r.score_percentage ?? 0) / 100)
      direct.set(r.employee_id, d)
    }

    const s = sliceEarnings(aggregateEarnings(withDupes, FAR), null)
    for (const [id, d] of direct) {
      expect(s.byEmployee.get(id)!.earningsInr, id).toBeCloseTo(d.e, 2)
      expect(s.byEmployee.get(id)!.taskCount, id).toBe(d.c)
      expect(s.byEmployee.get(id)!.creatives, id).toBeCloseTo(d.q, 2)
    }
  })
})

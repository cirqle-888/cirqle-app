import { describe, it, expect } from 'vitest'
import { countByEmployee, periodWindow, type CountableEntry } from './entry-count'
import { monthPeriod } from './periods'

const entry = (o: Partial<CountableEntry> = {}): CountableEntry => ({
  created_by: 'e1',
  created_at: '2026-10-15T10:00:00+05:30',
  type: 'outflow',
  transfer_ref: null,
  deleted_at: null,
  ...o,
})

const oct = periodWindow(monthPeriod(2026, 10))
const count = (rows: CountableEntry[], ids = ['e1', 'e2']) =>
  countByEmployee(rows, ids, oct.fromIso, oct.toIso)

describe('countByEmployee — what counts', () => {
  it('counts a hand-typed row for the person who typed it', () => {
    const out = count([entry(), entry(), entry({ created_by: 'e2' })])
    expect(out.unitsByEmployee).toEqual({ e1: 2, e2: 1 })
  })

  it('gives a participant who typed nothing an explicit 0, not undefined', () => {
    expect(count([entry()]).unitsByEmployee.e2).toBe(0)
  })

  // Without this, anyone could create rows and delete them to inflate a count.
  it('ignores soft-deleted rows', () => {
    expect(count([entry(), entry({ deleted_at: '2026-10-20T00:00:00Z' })])
      .unitsByEmployee.e1).toBe(1)
  })

  // Machine-written rows (cron, imports, auto-entries) carry no created_by —
  // that is the whole mechanism keeping them out of anyone's pay.
  it('ignores unattributed rows', () => {
    expect(count([entry(), entry({ created_by: null })]).unitsByEmployee.e1).toBe(1)
  })

  it('ignores rows recorded by someone with no rule this period', () => {
    const out = countByEmployee([entry(), entry({ created_by: 'stranger' })], ['e1'], oct.fromIso, oct.toIso)
    expect(out.unitsByEmployee).toEqual({ e1: 1 })
  })

  // One transfer writes two rows and is neither income nor expense.
  it('ignores transfer legs', () => {
    expect(count([entry(), entry({ transfer_ref: 't1' }), entry({ transfer_ref: 't1' })])
      .unitsByEmployee.e1).toBe(1)
  })
})

describe('countByEmployee — IST period boundaries', () => {
  // Absolute instants, so these hold under UTC, Asia/Kolkata and America/*.
  it('counts 03:30 IST on 1 Oct (22:00Z on 30 Sep) in OCTOBER', () => {
    expect(count([entry({ created_at: '2026-09-30T22:00:00Z' })]).unitsByEmployee.e1).toBe(1)
  })

  it('counts 23:30 IST on 31 Oct (18:00Z) in OCTOBER', () => {
    expect(count([entry({ created_at: '2026-10-31T18:00:00Z' })]).unitsByEmployee.e1).toBe(1)
  })

  // The bug a naive `.lte(period.end)` would cause: the last 5.5 hours of the
  // month, typed after midnight UTC, silently unpaid.
  it('counts 01:30 IST on 1 Nov (20:00Z on 31 Oct) in NOVEMBER, not October', () => {
    expect(count([entry({ created_at: '2026-10-31T20:00:00Z' })]).unitsByEmployee.e1).toBe(0)
  })

  it('excludes 23:30 IST on 30 Sep (18:00Z), which belongs to September', () => {
    expect(count([entry({ created_at: '2026-09-30T18:00:00Z' })]).unitsByEmployee.e1).toBe(0)
  })
})

describe('countByEmployee — breakdown detail', () => {
  it('splits inflow/outflow and rolls up by IST day, summing to the total', () => {
    const out = count([
      entry({ type: 'inflow',  created_at: '2026-10-02T09:00:00+05:30' }),
      entry({ type: 'outflow', created_at: '2026-10-02T11:00:00+05:30' }),
      entry({ type: 'outflow', created_at: '2026-10-05T11:00:00+05:30' }),
    ])
    const d = out.detailByEmployee.e1
    expect(d.inflowCount).toBe(1)
    expect(d.outflowCount).toBe(2)
    expect(d.byDay).toEqual({ '2026-10-02': 2, '2026-10-05': 1 })
    expect(Object.values(d.byDay).reduce((a, b) => a + b, 0)).toBe(out.unitsByEmployee.e1)
  })

  it('files a late-evening IST row under the IST day, not the UTC one', () => {
    // 23:30 IST on 31 Oct is still 31 Oct on the business calendar.
    const out = count([entry({ created_at: '2026-10-31T18:00:00Z' })])
    expect(out.detailByEmployee.e1.byDay).toEqual({ '2026-10-31': 1 })
  })
})

describe('periodWindow', () => {
  it('is half-open, in IST, and ends the day AFTER the period', () => {
    expect(oct.fromIso).toBe('2026-10-01T00:00:00+05:30')
    expect(oct.toIso).toBe('2026-11-01T00:00:00+05:30')
  })
})

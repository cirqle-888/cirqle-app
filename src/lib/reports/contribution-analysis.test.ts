/**
 * Unit tests for the grouping / subtotal layer of contribution-analysis.ts.
 *
 * Run with:  npx vitest run src/lib/reports/contribution-analysis.test.ts
 *
 * Focus: the MATRIX_COL alignment invariant — subtotal values must land under
 * the exact columns matrixHeader() emits — plus group partitioning + ordering.
 */
import { describe, it, expect } from 'vitest'
import {
  groupRows, subtotalLine, toMatrixGrouped, matrixHeader, MATRIX_COL, MATRIX_FIXED_COLS,
  type AnalysisRow, type EmployeeColumn,
} from './contribution-analysis'

const EMPLOYEES: EmployeeColumn[] = [
  { id: 'e1', name: 'Alice', cqid: 'CQID001' },
  { id: 'e2', name: 'Bob', cqid: 'CQID002' },
]

function mkRow(o: Partial<AnalysisRow> & Pick<AnalysisRow, 'task_id'>): AnalysisRow {
  return {
    task_id: o.task_id,
    task_number: o.task_number ?? 1,
    task_date: o.task_date ?? '2026-01-01',
    client_id: o.client_id ?? 'A',
    client_name: o.client_name ?? 'Acme',
    service_id: o.service_id ?? 'S1',
    service_name: o.service_name ?? 'Logo',
    status: o.status ?? 'done',
    currency: o.currency ?? 'INR',
    billing: o.billing ?? 0,
    billing_inr: o.billing_inr ?? 0,
    commission_pct: o.commission_pct ?? 50,
    commission_pool: o.commission_pool ?? 0,
    total_earnings: o.total_earnings ?? 0,
    company_received: o.company_received ?? (o.billing_inr ?? 0),
    profit: o.profit ?? 0,
    profit_pct: o.profit_pct ?? 0,
    actual_received: o.actual_received ?? null,
    fx_gain_loss: o.fx_gain_loss ?? null,
    actual_profit: o.actual_profit ?? null,
    actual_profit_pct: o.actual_profit_pct ?? null,
    contributors: o.contributors ?? 0,
    emp: o.emp ?? {},
  }
}

// Acme: one expected-only task + one fully-paid task. Beta: one expected-only task.
const r1 = mkRow({
  task_id: 't1', client_id: 'A', client_name: 'Acme', service_id: 'S1', status: 'done',
  task_date: '2026-01-15', billing_inr: 1000, commission_pool: 500, total_earnings: 400,
  profit: 600, profit_pct: 60, contributors: 1, emp: { e1: { pct: 100, earn: 400 } },
})
const r2 = mkRow({
  task_id: 't2', client_id: 'A', client_name: 'Acme', service_id: 'S2', status: 'paid',
  task_date: '2026-02-10', billing_inr: 2000, commission_pool: 1000, total_earnings: 800,
  profit: 1200, profit_pct: 60, contributors: 2,
  actual_received: 2100, fx_gain_loss: 100, actual_profit: 1300, actual_profit_pct: 61.9,
  emp: { e1: { pct: 50, earn: 400 }, e2: { pct: 50, earn: 400 } },
})
const r3 = mkRow({
  task_id: 't3', client_id: 'B', client_name: 'Beta', service_id: 'S1', status: 'done',
  task_date: '2026-01-20', billing_inr: 500, commission_pool: 250, total_earnings: 200,
  profit: 300, profit_pct: 60, contributors: 1, emp: { e2: { pct: 100, earn: 200 } },
})
const ROWS = [r1, r2, r3]

describe('groupRows', () => {
  it('returns [] for "none"', () => {
    expect(groupRows(ROWS, 'none')).toEqual([])
  })

  it('partitions by client in first-appearance order with correct subtotals', () => {
    const g = groupRows(ROWS, 'client')
    expect(g.map(x => x.key)).toEqual(['A', 'B'])
    expect(g.map(x => x.label)).toEqual(['Acme', 'Beta'])

    const acme = g[0]
    expect(acme.rows.map(r => r.task_id)).toEqual(['t1', 't2'])
    expect(acme.summary.totalTasks).toBe(2)
    expect(acme.summary.totalBilling).toBe(3000)
    expect(acme.summary.totalPool).toBe(1500)
    expect(acme.summary.totalEarnings).toBe(1200)
    expect(acme.summary.totalProfit).toBe(1800)
    expect(acme.summary.avgProfitPct).toBe(60)
    // Only the paid task contributes to actuals.
    expect(acme.summary.actualTasks).toBe(1)
    expect(acme.summary.totalActualReceived).toBe(2100)
    expect(acme.summary.totalFxGainLoss).toBe(100)
    // Per-employee earnings accumulate across the group's tasks.
    expect(acme.empEarn).toEqual({ e1: 800, e2: 400 })

    expect(g[1].summary.totalBilling).toBe(500)
    expect(g[1].empEarn).toEqual({ e2: 200 })
  })

  it('buckets months chronologically by first appearance with friendly labels', () => {
    const g = groupRows(ROWS, 'month')
    expect(g.map(x => x.key)).toEqual(['2026-01', '2026-02'])
    expect(g.map(x => x.label)).toEqual(['Jan 2026', 'Feb 2026'])
    expect(g[0].rows.map(r => r.task_id)).toEqual(['t1', 't3'])
  })
})

describe('subtotalLine — MATRIX_COL alignment', () => {
  const acme = groupRows(ROWS, 'client')[0]
  const line = subtotalLine(acme, EMPLOYEES)

  it('matches header width (alignment invariant)', () => {
    expect(line.length).toBe(matrixHeader(EMPLOYEES).length)
    expect(line.length).toBe(MATRIX_FIXED_COLS + EMPLOYEES.length * 3)
  })

  it('places each metric under its header column', () => {
    expect(String(line[MATRIX_COL.label])).toBe('Subtotal — Acme (2)')
    expect(line[MATRIX_COL.billing_inr]).toBe(3000)
    expect(line[MATRIX_COL.company_received]).toBe(3000)
    expect(line[MATRIX_COL.commission_pool]).toBe(1500)
    expect(line[MATRIX_COL.total_earnings]).toBe(1200)
    expect(line[MATRIX_COL.exp_profit]).toBe(1800)
    expect(line[MATRIX_COL.exp_profit_pct]).toBe(60)
    expect(line[MATRIX_COL.actual_received]).toBe(2100)
    expect(line[MATRIX_COL.fx_gain_loss]).toBe(100)
    expect(line[MATRIX_COL.actual_profit]).toBe(1300)
    expect(line[MATRIX_COL.actual_profit_pct]).toBe(61.9)
  })

  it('puts per-employee earnings under the employee earnings sub-column', () => {
    // employee i's three sub-cols start at FIXED + i*3; earnings is offset +1.
    expect(line[MATRIX_FIXED_COLS + 0 * 3 + 1]).toBe(800) // Alice
    expect(line[MATRIX_FIXED_COLS + 1 * 3 + 1]).toBe(400) // Bob
    // contributor pct / share columns stay blank in a subtotal.
    expect(line[MATRIX_FIXED_COLS + 0 * 3 + 0]).toBe('')
    expect(line[MATRIX_FIXED_COLS + 0 * 3 + 2]).toBe('')
  })

  it('leaves actual columns blank when no task in the group is paid', () => {
    const beta = groupRows(ROWS, 'client')[1]
    const bl = subtotalLine(beta, EMPLOYEES)
    expect(bl[MATRIX_COL.actual_received]).toBe('')
    expect(bl[MATRIX_COL.fx_gain_loss]).toBe('')
  })
})

describe('toMatrixGrouped', () => {
  it('emits header + (banner, rows, subtotal) per group with stable column shape', () => {
    const groups = groupRows(ROWS, 'client')
    const m = toMatrixGrouped(groups, EMPLOYEES)
    const width = matrixHeader(EMPLOYEES).length

    // header + Acme(banner+2 rows+subtotal) + Beta(banner+1 row+subtotal) = 1+4+3
    expect(m).toHaveLength(8)
    expect(m.every(row => row.length === width)).toBe(true)

    expect(m[1][0]).toBe('▸ Acme')
    expect(m[5][0]).toBe('▸ Beta')
    expect(String(m[7][0])).toBe('Subtotal — Beta (1)')
    expect(m[7][MATRIX_COL.billing_inr]).toBe(500)
  })
})

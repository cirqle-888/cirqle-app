import { describe, it, expect } from 'vitest'
import { attributeClientHandling, attributePlanned, handlerOn, plannerOf, type TaskRow, type HandlerRow } from './work-measures'
import { computeAwards, earningFor, measuredFor } from './compute'
import type { OwnershipProgram, OwnershipRule, PeriodAggregates } from './types'

const task = (id: string, client: string, date: string, bill: number, status = 'done'): TaskRow =>
  ({ id, task_number: Number(id.replace(/\D/g, '')) || null, title: `Task ${id}`, task_date: date, billing_amount_inr: bill, client_id: client, status })

describe('client handling', () => {
  const handlers: HandlerRow[] = [
    { client_id: 'seastar', employee_id: 'A', effective_from: '2026-01-01', effective_to: '2026-10-14' },
    { client_id: 'seastar', employee_id: 'B', effective_from: '2026-10-15', effective_to: null },
    { client_id: 'hiba', employee_id: 'A', effective_from: '2026-10-01', effective_to: null },
  ]
  const names = new Map([['seastar', 'Sea Star'], ['hiba', 'Hiba']])

  it('credits each task to the handler on its date — a handover never moves earlier work', () => {
    expect(handlerOn(handlers, 'seastar', '2026-10-14')).toBe('A')
    expect(handlerOn(handlers, 'seastar', '2026-10-15')).toBe('B')
    expect(handlerOn(handlers, 'other', '2026-10-15')).toBeNull()
  })

  it('counts clients worked and sums their billing per handler, with the clients listed', () => {
    const m = attributeClientHandling([
      task('t1', 'seastar', '2026-10-03', 350), task('t2', 'seastar', '2026-10-20', 400),
      task('t3', 'hiba', '2026-10-05', 1000), task('t4', 'nobody', '2026-10-05', 999),
    ], handlers, names, ['A', 'B'])
    expect(m.A).toMatchObject({ units: 2, amountInr: 1350 })
    expect(m.A.items.map(i => i.label)).toEqual(['Hiba', 'Sea Star'])   // biggest first
    expect(m.B).toMatchObject({ units: 1, amountInr: 400 })
  })

  it('does not count a client whose only task was cancelled', () => {
    const m = attributeClientHandling([task('t1', 'hiba', '2026-10-05', 0, 'cancelled')], handlers, names, ['A'])
    expect(m.A.units).toBe(0)
  })
})

describe('content planning', () => {
  const requests = [{ id: 'r1', promoted_task_id: 't1', created_by: 'REQ' }, { id: 'r2', promoted_task_id: 't2', created_by: 'REQ' }]
  const items = [{ task_id: null, request_id: 'r1', created_by: 'PLANNER' }]

  it('the calendar item’s author is the planner, ahead of whoever sent it to Requests', () => {
    expect(plannerOf('t1', items, requests)).toBe('PLANNER')
    expect(plannerOf('t2', items, requests)).toBe('REQ')
    expect(plannerOf('t3', items, requests)).toBeNull()
  })

  it('counts planned tasks and their billing, skipping cancelled ones', () => {
    const m = attributePlanned([task('t1', 'c', '2026-10-02', 350), task('t2', 'c', '2026-10-03', 400), task('t2x', 'c', '2026-10-04', 900, 'cancelled')],
      items, requests, ['PLANNER', 'REQ'])
    expect(m.PLANNER).toMatchObject({ units: 1, amountInr: 350 })
    expect(m.REQ).toMatchObject({ units: 1, amountInr: 400 })
  })
})

describe('paying a per-person basis', () => {
  const agg: PeriodAggregates = { billingInr: 0, collectedInr: 0, profitInr: 0, unitsByEmployee: { A: 3 }, amountByEmployee: { A: 12000 }, itemsByEmployee: { A: [{ label: 'Sea Star', date: '2026-10-03', amountInr: 12000 }] } }
  const rule = (o: Partial<OwnershipRule>): OwnershipRule => ({ id: 'r', programId: 'p', employeeId: 'A', designationId: null, percent: null, fixedAmountInr: null, label: null, effectiveFrom: '2026-01-01', effectiveTo: null, isActive: true, ...o })

  it('₹ rule pays rate × count; % rule pays a share of the person’s own money', () => {
    expect(earningFor('clients_handled', measuredFor('clients_handled', agg, 'A', rule({ fixedAmountInr: 200 })), rule({ fixedAmountInr: 200 }))).toBe(600)
    expect(earningFor('clients_handled', measuredFor('clients_handled', agg, 'A', rule({ percent: 2 })), rule({ percent: 2 }))).toBe(240)
    expect(earningFor('planned', measuredFor('planned', agg, 'A', rule({ percent: 5 })), rule({ percent: 5 }))).toBe(600)
  })

  it('awards carry the items, so the preview can show what was counted', () => {
    const program = { id: 'p', name: 'Client handling', programType: 'work_rate', basis: 'clients_handled', periodType: 'monthly', scopeKind: 'company', scopeId: null, periodStart: null, periodEnd: null, effectiveFrom: '2026-01-01', effectiveTo: null, isActive: true } as OwnershipProgram
    const [a] = computeAwards(program, [{ employeeId: 'A', rule: rule({ percent: 2 }) }], agg,
      { start: '2026-10-01', end: '2026-10-31', bookedMonth: 10, bookedYear: 2026, label: 'October 2026' })
    expect(a.earnedInr).toBe(240)
    expect(a.basisAmountInr).toBe(12000)
    expect(a.breakdown.items).toEqual(agg.itemsByEmployee!.A)
  })
})

describe('several people handling the same client', () => {
  const names = new Map([['seastar', 'Sea Star'], ['hiba', 'Hiba']])
  const tasks = [task('t1', 'seastar', '2026-10-03', 1000), task('t2', 'hiba', '2026-10-05', 500)]

  it('each person who lists a client on their rule earns on it', () => {
    const m = attributeClientHandling(tasks, [], names, ['A', 'B'], { A: ['seastar', 'hiba'], B: ['seastar'] })
    expect(m.A).toMatchObject({ units: 2, amountInr: 1500 })
    expect(m.B).toMatchObject({ units: 1, amountInr: 1000 })
  })

  it('a person with no list uses the handler table; a listed person ignores it', () => {
    const handlers: HandlerRow[] = [{ client_id: 'hiba', employee_id: 'C', effective_from: '2026-01-01', effective_to: null },
      { client_id: 'seastar', employee_id: 'A', effective_from: '2026-01-01', effective_to: null }]
    const m = attributeClientHandling(tasks, handlers, names, ['A', 'C'], { A: ['hiba'] })
    expect(m.A).toMatchObject({ units: 1, amountInr: 500 })   // only its list, not Sea Star from the table
    expect(m.C).toMatchObject({ units: 1, amountInr: 500 })   // from the table
  })
})

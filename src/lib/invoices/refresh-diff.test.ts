import { describe, it, expect } from 'vitest'
import { diffInvoiceAgainstTasks, stripDiffPrices, type RefreshLine, type RefreshTask } from './refresh-diff'

const line = (o: Partial<RefreshLine> = {}): RefreshLine => ({
  id: 'L1', task_id: 'T1', package_id: null, description: 'Diwali poster',
  quantity: 1, unit_price: 500, total: 500, currency: 'INR', ...o,
})
const task = (o: Partial<RefreshTask> = {}): RefreshTask => ({
  id: 'T1', title: 'Diwali poster', quantity: 1, billing_amount: 500, billing_amount_inr: 500,
  currency: 'INR', status: 'invoiced', deleted_at: null, is_billable: true, package_id: null, ...o,
})
const run = (lines: RefreshLine[], tasks: RefreshTask[]) =>
  diffInvoiceAgainstTasks(lines, new Map(tasks.map(t => [t.id, t])))

describe('diffInvoiceAgainstTasks', () => {
  it('reports nothing when the line matches its task', () => {
    expect(run([line()], [task()])).toEqual({ update: [], remove: [] })
  })

  it('picks up a re-priced task and rewrites rate and total', () => {
    const { update } = run([line()], [task({ billing_amount: 750 })])
    expect(update).toHaveLength(1)
    expect(update[0].changes).toEqual([{ field: 'price', from: 500, to: 750 }])
    expect(update[0].next).toEqual({ description: 'Diwali poster', quantity: 1, total: 750, unit_price: 750 })
  })

  it('derives the rate from the task total when quantity changes', () => {
    const { update } = run([line()], [task({ quantity: 2, billing_amount: 1000 })])
    expect(update[0].changes.map(c => c.field)).toEqual(['quantity', 'price'])
    expect(update[0].next).toMatchObject({ quantity: 2, total: 1000, unit_price: 500 })
  })

  it('picks up a renamed task', () => {
    const { update } = run([line()], [task({ title: 'Diwali Bumper Sale poster' })])
    expect(update[0].changes).toEqual([{ field: 'description', from: 'Diwali poster', to: 'Diwali Bumper Sale poster' }])
  })

  it('falls back to the INR amount for legacy tasks with no billing_amount', () => {
    const { update } = run([line()], [task({ billing_amount: null, billing_amount_inr: 600 })])
    expect(update[0].next.total).toBe(600)
  })

  it('leaves price and quantity alone when the task is in another currency', () => {
    const { update } = run([line({ currency: 'AED' })], [task({ currency: 'INR', billing_amount: 900, quantity: 3 })])
    expect(update).toEqual([])
  })

  it.each([
    ['deleted', { deleted_at: '2026-11-01T00:00:00Z' }],
    ['cancelled', { status: 'cancelled' }],
    ['waived', { is_billable: false }],
  ] as const)('removes the line of a %s task', (why, o) => {
    const { remove, update } = run([line()], [task(o as Partial<RefreshTask>)])
    expect(update).toEqual([])
    expect(remove).toEqual([{ itemId: 'L1', taskId: 'T1', description: 'Diwali poster', why, total: 500 }])
  })

  it('removes the line of a task that no longer exists', () => {
    expect(run([line()], []).remove[0].why).toBe('missing')
  })

  it('never touches manual lines, package fee lines or package tasks', () => {
    const out = run(
      [line({ id: 'manual', task_id: null }), line({ id: 'fee', package_id: 'P1' }), line({ id: 'extra', task_id: 'T2' })],
      [task({ billing_amount: 999 }), task({ id: 'T2', package_id: 'P1', billing_amount: 999 })],
    )
    expect(out).toEqual({ update: [], remove: [] })
  })

  it('ignores sub-paisa rounding differences', () => {
    expect(run([line({ total: 500.004 })], [task()]).update).toEqual([])
  })
})

describe('stripDiffPrices', () => {
  it('drops every money figure but keeps what changed', () => {
    const diff = run(
      [line(), line({ id: 'L2', task_id: 'T2' })],
      [task({ billing_amount: 750 }), task({ id: 'T2', status: 'cancelled' })],
    )
    const stripped = stripDiffPrices(diff)
    expect(stripped.update[0].changes).toEqual([{ field: 'price' }])
    expect(stripped.update[0].next).toEqual({ description: 'Diwali poster', quantity: 1 })
    expect(stripped.remove[0]).not.toHaveProperty('total')
    expect(JSON.stringify(stripped)).not.toMatch(/750|500/)
  })
})

import { describe, it, expect } from 'vitest'
import { allocateOwnership, splitByWeight, type AllocAward, type AllocTask } from './ownership-allocation'

const task = (id: string, client: string, date: string, billingInr: number, o: Partial<AllocTask> = {}): AllocTask =>
  ({ id, taskNumber: Number(id.replace(/\D/g, '')) || null, date, clientId: client, serviceId: 'svc', categoryId: 'cat', billingInr, ...o })
const award = (o: Partial<AllocAward>): AllocAward => ({
  programName: 'P', basis: 'billing', scopeKind: 'company', scopeId: null,
  periodStart: '2026-09-01', periodEnd: '2026-09-30', percent: 2, earnedInr: 0, ...o,
})
const ctx = { clientIdByName: new Map([['sea star', 'seastar']]), unitScopes: new Map() }
const total = (m: Map<string, number>) => Math.round([...m.values()].reduce((t, v) => t + v, 0) * 100) / 100

describe('splitByWeight', () => {
  it('always sums to the total, to the paisa', () => {
    const parts = splitByWeight(100, [1, 1, 1])
    expect(parts).toEqual([33.34, 33.33, 33.33])
    expect(parts.reduce((t, v) => t + v, 0)).toBeCloseTo(100, 10)
  })
  it('splits equally when nothing has weight', () => {
    expect(splitByWeight(10, [0, 0])).toEqual([5, 5])
  })
})

describe('allocateOwnership', () => {
  const tasks = [
    task('t1', 'seastar', '2026-09-03', 3000), task('t2', 'seastar', '2026-09-20', 1000),
    task('t3', 'hiba', '2026-09-10', 6000), task('t4', 'hiba', '2026-10-02', 9999),
  ]

  it('a billing share goes to the period’s tasks by billing — and only that period', () => {
    const { byTask, unallocated } = allocateOwnership([award({ earnedInr: 200 })], tasks, ctx)
    expect(byTask.get('t1')).toBe(60)
    expect(byTask.get('t2')).toBe(20)
    expect(byTask.get('t3')).toBe(120)
    expect(byTask.has('t4')).toBe(false)
    expect(unallocated).toEqual([])
  })

  it('a client-scoped program stays on that client', () => {
    const { byTask } = allocateOwnership([award({ earnedInr: 40, scopeKind: 'client', scopeId: 'seastar' })], tasks, ctx)
    expect(byTask.get('t1')).toBe(30)
    expect(byTask.get('t2')).toBe(10)
    expect(byTask.has('t3')).toBe(false)
  })

  it('client handling lands on the handled client, found by id or by name', () => {
    const { byTask } = allocateOwnership([
      award({ basis: 'clients_handled', earnedInr: 80, items: [{ label: 'Sea Star', amountInr: 4000 }] }),
      award({ basis: 'clients_handled', earnedInr: 60, items: [{ label: 'Hiba', refId: 'hiba', amountInr: 6000 }] }),
    ], tasks, ctx)
    expect(byTask.get('t1')).toBe(60)
    expect(byTask.get('t2')).toBe(20)
    expect(byTask.get('t3')).toBe(60)
  })

  it('planning lands on the planned task', () => {
    const { byTask } = allocateOwnership([award({ basis: 'planned', percent: null, earnedInr: 50, items: [{ label: '#2 Poster' }, { label: 'x', refId: 't3' }] })], tasks, ctx)
    expect(byTask.get('t2')).toBe(25)
    expect(byTask.get('t3')).toBe(25)
  })

  it('per-entry and fixed rewards are reported as overhead, never spread over tasks', () => {
    const { byTask, unallocated } = allocateOwnership([
      award({ basis: 'entries', earnedInr: 30 }), award({ basis: 'fixed', earnedInr: 1000 }),
    ], tasks, ctx)
    expect(byTask.size).toBe(0)
    expect(unallocated.map(u => [u.basis, u.amountInr])).toEqual([['entries', 30], ['fixed', 1000]])
  })

  it('allocated + unallocated always equals what was paid', () => {
    const awards = [
      award({ earnedInr: 871.5 }), award({ basis: 'collected', earnedInr: 645 }),
      award({ basis: 'clients_handled', earnedInr: 189, items: [{ label: 'Nobody Ltd', amountInr: 6300 }] }),
      award({ basis: 'entries', earnedInr: 5 }),
    ]
    const { byTask, unallocated } = allocateOwnership(awards, tasks, ctx)
    const out = total(byTask) + unallocated.reduce((t, u) => t + u.amountInr, 0)
    expect(Math.round(out * 100) / 100).toBe(871.5 + 645 + 189 + 5)
    expect(unallocated.find(u => u.basis === 'clients_handled')?.reason).toMatch(/not found/)
  })
})

import { describe, it, expect } from 'vitest'
import { computeItemProgress, type SourceTask } from './progress'
import type { ClientAgreementRow, ClientAgreementItemRow, ClientAgreementDeliverableRow } from './types'

// ── Fixtures ─────────────────────────────────────────────────────────────────
// A retainer item committing 15 posts for July, whose OWN service is "social",
// with a deliverable typed post/carousel/story. Posters are created under a
// DIFFERENT service ("poster") — the coverage engine is what ties them to the
// item, which is why progress reads retainer_item_id and not service_id.

const MONTH = '2026-07'
const ITEM_ID = 'item-1'
const SVC_MAIN = 'svc-social'   // the item's own service_id
const SVC_POSTER = 'svc-poster' // a covered service with a different id

const agreement = {
  id: 'ag-1', client_id: 'c-1', start_date: '2026-07-01', end_date: null, status: 'active',
} as unknown as ClientAgreementRow

const termRow = {
  id: ITEM_ID, agreement_id: 'ag-1', service_id: SVC_MAIN, commitment_type: 'retainer',
  committed_quantity: 15, cycle: 'monthly', effective_from: '2026-07-01', effective_to: null,
  carry_forward_rule: 'expire', currency: 'AED', display_order: 0,
} as unknown as ClientAgreementItemRow

const deliverables = [{
  id: 'del-1', item_id: ITEM_ID, label: '15 Designed Posts',
  content_types: ['post', 'carousel', 'story'], committed_quantity: 15, display_order: 0,
} as unknown as ClientAgreementDeliverableRow]

function run(tasks: SourceTask[]) {
  return computeItemProgress({
    month: MONTH, agreement, termRow, deliverables, adjustments: [],
    tasks, carryInRemaining: 0,
  })
}

function task(over: Partial<SourceTask>): SourceTask {
  return { id: 't1', service_id: SVC_POSTER, task_date: '2026-07-15', status: 'done', quantity: 1, deleted_at: null, ...over }
}

describe('computeItemProgress — the single rule', () => {
  it('commits 15 for a full month and starts at zero delivered', () => {
    expect(run([]).committed).toBe(15)
    expect(run([]).delivered).toBe(0)
    expect(run([]).remaining).toBe(15)
  })

  it('counts a covered task via retainer_item_id even when the service differs', () => {
    const r = run([task({ retainer_item_id: ITEM_ID, service_id: SVC_POSTER })])
    expect(r.delivered).toBe(1)
  })

  it('does NOT count a covered task until it is completed', () => {
    expect(run([task({ retainer_item_id: ITEM_ID, status: 'pending' })]).delivered).toBe(0)
    expect(run([task({ retainer_item_id: ITEM_ID, status: 'in_progress' })]).delivered).toBe(0)
    for (const s of ['done', 'delivered', 'invoiced', 'paid']) {
      expect(run([task({ retainer_item_id: ITEM_ID, status: s })]).delivered).toBe(1)
    }
  })

  it('counts a covered task that is NOT billed as extra toward the allowance', () => {
    expect(run([task({ retainer_item_id: ITEM_ID })]).delivered).toBe(1)
  })

  it('does not spend the allowance on work the client is billed for separately', () => {
    // Charging for a task AND consuming one of the 15 included units would bill
    // the client twice for it. Real case: task #1883 (Elara), extra work at AED 20.
    const r = run([
      task({ id: 'covered', retainer_item_id: ITEM_ID }),
      task({ id: 'extra', retainer_item_id: ITEM_ID, bill_as_extra: true }),
    ])
    expect(r.delivered).toBe(1)     // only the covered one consumes
    expect(r.extraBilled).toBe(1)   // the billed one is reported separately
    expect(r.remaining).toBe(14)    // 15 − 1, not 15 − 2
  })

  it('never double-counts when both the link AND the service match', () => {
    expect(run([task({ retainer_item_id: ITEM_ID, service_id: SVC_MAIN })]).delivered).toBe(1)
  })

  it('ignores a task linked to a DIFFERENT agreement item', () => {
    expect(run([task({ retainer_item_id: 'some-other-item' })]).delivered).toBe(0)
  })

  it('does not count soft-deleted covered tasks', () => {
    expect(run([task({ retainer_item_id: ITEM_ID, deleted_at: '2026-07-16' })]).delivered).toBe(0)
  })

  // ── What the single rule deliberately changed ──────────────────────────────

  it('does NOT count an unstamped task, even on the item’s own service', () => {
    // The old service-matching "safety net" counted this. It is gone: an unstamped
    // task is one the coverage engine did not absorb, so it is not retainer work.
    // Anything missed here is a coverage-stamping problem to fix at the source.
    expect(run([task({ retainer_item_id: null, service_id: SVC_MAIN })]).delivered).toBe(0)
    expect(run([task({ retainer_item_id: null, service_id: SVC_POSTER })]).delivered).toBe(0)
  })

  it('counts QUANTITY, not task rows', () => {
    // One task with quantity 4 consumes 4 of a 15-unit commitment. The old
    // calendar path counted items as 1 each, mixing units inside one total.
    const r = run([task({ retainer_item_id: ITEM_ID, quantity: 4 })])
    expect(r.delivered).toBe(4)
    expect(r.remaining).toBe(11)
  })

  it('aggregates multiple covered tasks by quantity', () => {
    const r = run([
      task({ id: 'a', retainer_item_id: ITEM_ID }),
      task({ id: 'b', retainer_item_id: ITEM_ID }),
      task({ id: 'c', retainer_item_id: ITEM_ID, quantity: 3 }),
    ])
    expect(r.delivered).toBe(5)
    expect(r.remaining).toBe(10)
  })

  it('reports over-delivery as extra and never negative remaining', () => {
    const r = run([task({ retainer_item_id: ITEM_ID, quantity: 18 })])
    expect(r.delivered).toBe(18)
    expect(r.remaining).toBe(0)
    expect(r.extra).toBe(3)
  })
})

describe('computeItemProgress — commitment', () => {
  it('merges a mid-month start into the next month as one full cycle', () => {
    const midMonth = { ...agreement, start_date: '2026-07-20' } as ClientAgreementRow
    const args = {
      agreement: midMonth, termRow, deliverables, adjustments: [],
      tasks: [], carryInRemaining: 0,
    }
    // The stub (20–31 Jul) does not owe its own cycle, and August does not
    // restart from scratch: both months resolve to ONE period owing 15.
    for (const month of ['2026-07', '2026-08']) {
      const r = computeItemProgress({ ...args, month })
      expect(r.committed).toBe(15)
      expect(r.period.start).toBe('2026-07-20')
      expect(r.period.end).toBe('2026-08-31')
    }
    // September is a plain calendar month again.
    const sep = computeItemProgress({ ...args, month: '2026-09' })
    expect(sep.committed).toBe(15)
    expect(sep.period.start).toBe('2026-09-01')
  })

  it('counts stub-month delivery against the merged period', () => {
    const midMonth = { ...agreement, start_date: '2026-07-20' } as ClientAgreementRow
    const july = task({ retainer_item_id: ITEM_ID, task_date: '2026-07-29', status: 'done' })
    const r = computeItemProgress({
      month: '2026-08', agreement: midMonth, termRow, deliverables, adjustments: [],
      tasks: [july], carryInRemaining: 0,
    })
    // Delivered on 29 Jul, read in August — the whole point of merging.
    expect(r.delivered).toBe(1)
    expect(r.remaining).toBe(14)
  })

  it('ignores tasks dated outside the period', () => {
    const r = computeItemProgress({
      month: MONTH, agreement, termRow, deliverables, adjustments: [],
      tasks: [task({ retainer_item_id: ITEM_ID, task_date: '2026-06-30' })],
      carryInRemaining: 0,
    })
    expect(r.delivered).toBe(0)
  })

  it('commits a one_time item once, not every month', () => {
    const oneTime = {
      ...termRow, commitment_type: 'one_time', committed_quantity: 2, cycle: null,
      effective_from: '2026-07-20', effective_to: null,
    } as unknown as ClientAgreementItemRow
    const dels = [
      { ...deliverables[0], committed_quantity: 1, label: 'Custom Logo Design' },
      { ...deliverables[0], id: 'del-2', committed_quantity: 1, label: 'Simple Brand Chart' },
    ] as unknown as ClientAgreementDeliverableRow[]
    const args = {
      agreement: { ...agreement, start_date: '2026-07-20' } as ClientAgreementRow,
      termRow: oneTime, deliverables: dels, adjustments: [], tasks: [], carryInRemaining: 0,
    }
    expect(computeItemProgress({ ...args, month: '2026-07' }).committed).toBe(2)
    // effective_to is NULL, so the old rule re-committed these 2 forever.
    expect(computeItemProgress({ ...args, month: '2026-08' }).committed).toBe(0)
    expect(computeItemProgress({ ...args, month: '2026-12' }).committed).toBe(0)
  })

  it('still prorates a commitment that ENDS mid-period', () => {
    const ending = { ...agreement, end_date: '2026-07-15' } as ClientAgreementRow
    const r = computeItemProgress({
      month: MONTH, agreement: ending, termRow, deliverables, adjustments: [],
      tasks: [], carryInRemaining: 0,
    })
    expect(r.committed).toBe(7) // 15 of 31 days → 15 * 15/31 ≈ 7
  })

  it('adds carry-forward from the previous month', () => {
    const r = computeItemProgress({
      month: MONTH, agreement, termRow, deliverables, adjustments: [],
      tasks: [], carryInRemaining: 3,
    })
    expect(r.committed).toBe(18)
  })
})

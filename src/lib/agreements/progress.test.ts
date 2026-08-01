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

  it('counts an extra-work task toward progress (progress ignores billing)', () => {
    // bill_as_extra is not a progress input; retainer_item_id being set is enough.
    expect(run([task({ retainer_item_id: ITEM_ID })]).delivered).toBe(1)
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
  it('prorates a mid-month start (agreement from 20 Jul)', () => {
    const midMonth = { ...agreement, start_date: '2026-07-20' } as ClientAgreementRow
    const r = computeItemProgress({
      month: MONTH, agreement: midMonth, termRow, deliverables, adjustments: [],
      tasks: [], carryInRemaining: 0,
    })
    // 12 of 31 active days → 15 * 12/31 ≈ 6. Surface this in the UI: an
    // unexplained 6 against a promised 15 reads as a bug.
    expect(r.committed).toBe(6)
  })

  it('adds carry-forward from the previous month', () => {
    const r = computeItemProgress({
      month: MONTH, agreement, termRow, deliverables, adjustments: [],
      tasks: [], carryInRemaining: 3,
    })
    expect(r.committed).toBe(18)
  })
})

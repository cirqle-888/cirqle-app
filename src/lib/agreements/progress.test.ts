import { describe, it, expect } from 'vitest'
import { computeItemProgress, type SourceTask, type SourceCalendarItem } from './progress'
import type { ClientAgreementRow, ClientAgreementItemRow, ClientAgreementDeliverableRow } from './types'

// ── Fixtures ─────────────────────────────────────────────────────────────────
// A retainer item committing 15 posts for July, whose OWN service is "social",
// with a deliverable typed post/carousel/story. Posters are created under a
// DIFFERENT service ("poster") — the exact situation the coverage/progress
// consistency fix addresses.

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

function run(tasks: SourceTask[], calendarItems: SourceCalendarItem[] = []) {
  return computeItemProgress({
    month: MONTH, agreement, termRow, deliverables, adjustments: [],
    calendarItems, tasks, carryInRemaining: 0,
  })
}

function task(over: Partial<SourceTask>): SourceTask {
  return { id: 't1', service_id: SVC_POSTER, task_date: '2026-07-15', status: 'done', quantity: 1, deleted_at: null, ...over }
}

describe('computeItemProgress — retainer_item_id linkage (billing/progress consistency)', () => {
  it('commits 15 for a full month', () => {
    expect(run([]).committed).toBe(15)
    expect(run([]).delivered).toBe(0)
  })

  // Scenario 2 — the fix: a manual/direct task on a DIFFERENT service, linked to
  // the item by the coverage engine, must count toward Delivered.
  it('counts a covered direct task via retainer_item_id even when the service differs', () => {
    const r = run([task({ retainer_item_id: ITEM_ID, service_id: SVC_POSTER })])
    expect(r.delivered).toBe(1)
  })

  it('does NOT count a covered task until it is completed', () => {
    expect(run([task({ retainer_item_id: ITEM_ID, status: 'pending' })]).delivered).toBe(0)
    expect(run([task({ retainer_item_id: ITEM_ID, status: 'in_progress' })]).delivered).toBe(0)
    // Any completed status counts.
    for (const s of ['done', 'delivered', 'invoiced', 'paid']) {
      expect(run([task({ retainer_item_id: ITEM_ID, status: s })]).delivered).toBe(1)
    }
  })

  // Scenario 4 — progress is independent of billing: the engine never sees
  // bill_as_extra, so an extra-work task (still stamped with retainer_item_id)
  // still counts toward progress.
  it('counts an extra-work task toward progress (progress ignores billing)', () => {
    // bill_as_extra is not a progress input; retainer_item_id being set is enough.
    expect(run([task({ retainer_item_id: ITEM_ID })]).delivered).toBe(1)
  })

  it('never double-counts when both the link AND the service match', () => {
    const r = run([task({ retainer_item_id: ITEM_ID, service_id: SVC_MAIN })])
    expect(r.delivered).toBe(1)
  })

  it('ignores a task linked to a DIFFERENT agreement item', () => {
    expect(run([task({ retainer_item_id: 'some-other-item' })]).delivered).toBe(0)
  })

  it('preserves the legacy service-based safety net (no link, matching service)', () => {
    expect(run([task({ retainer_item_id: null, service_id: SVC_MAIN })]).delivered).toBe(1)
  })

  it('documents the OLD gap: a poster task with neither the link nor a matching service does not count', () => {
    // This is precisely the bug the fix closes: without retainer_item_id and on a
    // different service, the direct task is invisible to progress.
    expect(run([task({ retainer_item_id: null, service_id: SVC_POSTER })]).delivered).toBe(0)
  })

  it('aggregates multiple covered tasks', () => {
    const r = run([
      task({ id: 'a', retainer_item_id: ITEM_ID }),
      task({ id: 'b', retainer_item_id: ITEM_ID }),
      task({ id: 'c', retainer_item_id: ITEM_ID, quantity: 3 }),
    ])
    expect(r.delivered).toBe(5)
    expect(r.remaining).toBe(10)
  })

  it('does not count soft-deleted covered tasks', () => {
    expect(run([task({ retainer_item_id: ITEM_ID, deleted_at: '2026-07-16' })]).delivered).toBe(0)
  })
})

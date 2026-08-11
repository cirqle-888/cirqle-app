import { describe, it, expect } from 'vitest'
import { pickVersionForTask, planUnlink, sameLineage, versionAppliesOn, type ItemVersionRow } from './manual-link'
import { isCoveredWorkTask, taskPoolBasisInr, missingWorkValue } from '@/lib/calculations/work-value'

/**
 * Regression tests for the manual-link earnings bug (task #1902).
 *
 * "Link existing task" wrote only the client_agreement_tasks join table, so
 * the agreement screen showed the task as covered while the money engine —
 * which reads tasks.retainer_item_id — pooled from billing_amount_inr (0 for
 * covered work) and paid the team nothing.
 */

const item = (o: Partial<ItemVersionRow>): ItemVersionRow => ({
  id: 'v1', agreement_id: 'agr-1', service_id: 'svc-brand', commitment_type: 'one_time',
  effective_from: '2026-07-20', effective_to: null, ...o,
})

// ── Case A — manual link makes the money engine see coverage ────────────────

describe('Case A: manual link → engine coverage', () => {
  it('an unlinked covered-work task pools from billing (the bug: ₹0)', () => {
    const t = { retainer_item_id: null, bill_as_extra: false, billing_amount_inr: 0, work_value_inr: null }
    expect(isCoveredWorkTask(t)).toBe(false)
    expect(taskPoolBasisInr(t)).toBe(0)          // exactly what #1902 showed
  })

  it('after stamping retainer_item_id the engine pools from the work value', () => {
    // AED 75 × 1 × fx — the trigger stamps work_value_inr; the engine must
    // switch its basis from billing (0) to that stamp.
    const t = { retainer_item_id: 'v1', bill_as_extra: false, billing_amount_inr: 0, work_value_inr: 1725 }
    expect(isCoveredWorkTask(t)).toBe(true)
    expect(taskPoolBasisInr(t)).toBe(1725)
    expect(missingWorkValue(t)).toBe(false)
  })

  it('a stamped task whose item has no work value is flagged, not silently ₹0-and-fine', () => {
    const t = { retainer_item_id: 'v1', bill_as_extra: false, billing_amount_inr: 0, work_value_inr: null }
    expect(missingWorkValue(t)).toBe(true)
  })
})

// ── Case B — unlink clears only what the link created ───────────────────────

describe('Case B: unlink', () => {
  const unlinked = item({ id: 'v1' })

  it('clears coverage (redetect) when the last manual backing is removed', () => {
    expect(planUnlink({
      currentRetainerItemId: 'v1',
      unlinked,
      allAgreementItems: [unlinked],
      remainingLinkedItems: [],
      taskDate: '2026-07-23',
    })).toEqual({ kind: 'redetect' })
  })

  it('keeps a null retainer_item_id untouched', () => {
    expect(planUnlink({
      currentRetainerItemId: null,
      unlinked,
      allAgreementItems: [unlinked],
      remainingLinkedItems: [],
      taskDate: '2026-07-23',
    })).toEqual({ kind: 'keep' })
  })

  it('moves coverage to a surviving manual link instead of clearing it', () => {
    const other = item({ id: 'x9', service_id: 'svc-social' })   // different lineage
    expect(planUnlink({
      currentRetainerItemId: 'v1',
      unlinked,
      allAgreementItems: [unlinked, other],
      remainingLinkedItems: [other],
      taskDate: '2026-07-23',
    })).toEqual({ kind: 'restamp', itemId: 'x9' })
  })
})

// ── Case C — versioned items (Change terms) ─────────────────────────────────

describe('Case C: version resolution', () => {
  const v1 = item({ id: 'v1', effective_from: '2026-07-20', effective_to: '2026-08-14' })
  const v2 = item({ id: 'v2', effective_from: '2026-08-15', effective_to: null })

  it('stamps the version in force at the task date, not the clicked one', () => {
    // User clicks the CURRENT card (v2) but the task predates it — the version
    // rule (shared with the DB trigger) picks v1.
    expect(pickVersionForTask(v2, [v1, v2], '2026-07-23')).toBe('v1')
  })

  it('stamps the clicked (visible) item when no version covers the date', () => {
    // Work done before every version existed — e.g. a concept task before
    // signing. The card the user can see is the least surprising answer.
    expect(pickVersionForTask(v2, [v1, v2], '2026-07-01')).toBe('v2')
  })

  it('latest effective_from wins when windows overlap', () => {
    const a = item({ id: 'a', effective_from: '2026-07-01', effective_to: null })
    const b = item({ id: 'b', effective_from: '2026-07-15', effective_to: null })
    expect(pickVersionForTask(a, [a, b], '2026-07-23')).toBe('b')
  })

  it('never crosses lineages: a different service is a different item', () => {
    const social = item({ id: 'soc', service_id: 'svc-social', effective_from: '2026-07-01' })
    expect(pickVersionForTask(v2, [v1, v2, social], '2026-07-23')).toBe('v1')
    expect(sameLineage(v2, social)).toBe(false)
  })

  it('versionAppliesOn matches the DB trigger window rule', () => {
    expect(versionAppliesOn(v1, '2026-07-20')).toBe(true)   // inclusive start
    expect(versionAppliesOn(v1, '2026-08-14')).toBe(true)   // inclusive end
    expect(versionAppliesOn(v1, '2026-08-15')).toBe(false)
    expect(versionAppliesOn(v2, '2026-08-15')).toBe(true)
  })
})

// ── Case D — automatic coverage is never touched ────────────────────────────

describe('Case D: auto coverage stands', () => {
  it('unlink keeps retainer_item_id pointing at a different lineage (auto retainer)', () => {
    const unlinked = item({ id: 'v1' })
    const autoItem = item({ id: 'ret-7', service_id: 'svc-poster', commitment_type: 'retainer' })
    expect(planUnlink({
      currentRetainerItemId: 'ret-7',
      unlinked,
      allAgreementItems: [unlinked, autoItem],
      remainingLinkedItems: [],
      taskDate: '2026-07-23',
    })).toEqual({ kind: 'keep' })
  })

  // The link action's guard is `retainer_item_id == null` before stamping —
  // an auto-covered task (#1885/#1883) keeps its trigger-set id. Behavioural
  // check lives in the action; the invariant the engine depends on is that
  // basis stays work_value for those tasks:
  it('auto-covered tasks keep pooling from their work value', () => {
    const t = { retainer_item_id: 'ret-7', bill_as_extra: false, billing_amount_inr: 0, work_value_inr: 518.09 }
    expect(taskPoolBasisInr(t)).toBe(518.09)
  })
})

// ── Case E — bill_as_extra semantics unchanged ──────────────────────────────

describe('Case E: extra work', () => {
  it('a linked task flagged extra still pools from billing, not work value', () => {
    const t = { retainer_item_id: 'v1', bill_as_extra: true, billing_amount_inr: 1150, work_value_inr: 1725 }
    expect(isCoveredWorkTask(t)).toBe(false)
    expect(taskPoolBasisInr(t)).toBe(1150)
  })
})

// ── Case F — duplicate legacy join rows ─────────────────────────────────────

describe('Case F: repeated Change terms', () => {
  // #1902's real shape: five join rows, all versions of one lineage.
  const versions = [
    item({ id: 'v1', effective_from: '2026-07-20', effective_to: '2026-07-31' }),
    item({ id: 'v2', effective_from: '2026-08-01', effective_to: '2026-08-09' }),
    item({ id: 'v3', effective_from: '2026-08-10', effective_to: '2026-08-11' }),
    item({ id: 'v4', effective_from: '2026-08-12', effective_to: '2026-08-14' }),
    item({ id: 'v5', effective_from: '2026-08-15', effective_to: null }),
  ]

  it('picks the single date-correct version out of the duplicates', () => {
    expect(pickVersionForTask(versions[4], versions, '2026-07-23')).toBe('v1')
    expect(pickVersionForTask(versions[4], versions, '2026-08-10')).toBe('v3')
    expect(pickVersionForTask(versions[4], versions, '2026-09-01')).toBe('v5')
  })

  it('unlinking one duplicate row does not restamp from a sibling of the same lineage', () => {
    // All five rows die together — surviving duplicates of the SAME lineage
    // must not keep the coverage alive after the user removes the link.
    expect(planUnlink({
      currentRetainerItemId: 'v1',
      unlinked: versions[2],
      allAgreementItems: versions,
      remainingLinkedItems: [versions[0], versions[3]],   // stale duplicates remain
      taskDate: '2026-07-23',
    })).toEqual({ kind: 'redetect' })
  })
})

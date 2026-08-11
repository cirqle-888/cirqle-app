/**
 * Manual task↔agreement-item links — the version-resolution rules.
 *
 * "Link existing task" historically wrote only the `client_agreement_tasks`
 * join table, which the agreement screen reads — while every money engine
 * reads `tasks.retainer_item_id`. A manually linked task therefore LOOKED
 * covered but pooled from billing_amount_inr (0 for covered work) and paid
 * the team nothing. These helpers decide which item id belongs on the task,
 * so the link action can stamp it.
 *
 * Version rule — the ONE already used by the DB coverage trigger
 * (20260728130000) and coverage.ts: an item version applies on date D when
 * `effective_from <= D <= (effective_to ?? ∞)`, latest effective_from wins.
 * "Change terms" creates versions; they are correlated only by sharing an
 * agreement + service + commitment type (there is no family column), so that
 * triple is what `sameLineage` means here.
 *
 * Pure functions, no IO — the server action feeds them rows so every rule is
 * unit-testable without a database.
 */

export interface ItemVersionRow {
  id: string
  agreement_id: string
  service_id: string | null
  commitment_type: string | null
  effective_from: string
  effective_to: string | null
}

/** Same version lineage = same agreement + service + commitment type. */
export function sameLineage(a: ItemVersionRow, b: ItemVersionRow): boolean {
  return a.agreement_id === b.agreement_id
    && (a.service_id ?? null) === (b.service_id ?? null)
    && (a.commitment_type ?? null) === (b.commitment_type ?? null)
}

/** The trigger's validity rule: does this version apply on `date`? */
export function versionAppliesOn(item: ItemVersionRow, date: string): boolean {
  return item.effective_from <= date && (!item.effective_to || item.effective_to >= date)
}

/**
 * Which version of the clicked item should be stamped on the task.
 *
 * Prefer the lineage version in force at the task's date — the same answer the
 * auto-coverage trigger would give — falling back to the clicked item itself
 * when no version covers that date (e.g. the work predates every version, as
 * with a concept task done before the agreement was signed). The clicked item
 * is what the user can SEE, with the work value they just read, so it is the
 * least surprising fallback.
 */
export function pickVersionForTask(
  clicked: ItemVersionRow,
  allAgreementItems: ItemVersionRow[],
  taskDate: string | null,
): string {
  if (!taskDate) return clicked.id
  const lineage = allAgreementItems.filter(i => sameLineage(i, clicked))
  const applicable = lineage
    .filter(i => versionAppliesOn(i, taskDate))
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from))
  return applicable[0]?.id ?? clicked.id
}

/** What the unlink action should do to `tasks.retainer_item_id`. */
export type UnlinkPlan =
  /** retainer_item_id untouched — it is null, or belongs to other coverage. */
  | { kind: 'keep' }
  /** Point the task at the best remaining manually-linked item. */
  | { kind: 'restamp'; itemId: string }
  /** No manual backing left — re-run the DB's auto-detection. */
  | { kind: 'redetect' }

/**
 * Decide how unlinking (task, unlinkedItem) affects the task's coverage.
 *
 * The prime directive is Case D: NEVER touch coverage that this unlink did not
 * create. If retainer_item_id is outside the unlinked item's lineage — auto
 * coverage from a retainer, or a manual link to a different item — it stands.
 * Only when the task was pointing into the unlinked lineage do we either move
 * it to a surviving manual link or hand it back to auto-detection.
 */
export function planUnlink(params: {
  currentRetainerItemId: string | null
  unlinked: ItemVersionRow
  /** Every item version of the unlinked item's agreement. */
  allAgreementItems: ItemVersionRow[]
  /** Items still manually linked to this task AFTER the join row is removed. */
  remainingLinkedItems: ItemVersionRow[]
  taskDate: string | null
}): UnlinkPlan {
  const { currentRetainerItemId, unlinked, allAgreementItems, remainingLinkedItems, taskDate } = params
  if (!currentRetainerItemId) return { kind: 'keep' }

  const current = allAgreementItems.find(i => i.id === currentRetainerItemId)
  const inUnlinkedLineage = current ? sameLineage(current, unlinked) : false
  if (!inUnlinkedLineage) return { kind: 'keep' }

  // A surviving join row can keep the task covered — but only a row whose item
  // is NOT the lineage being unlinked (stale duplicate rows from repeated
  // Change-terms all belong to the same lineage and die together).
  const survivors = remainingLinkedItems.filter(i => !sameLineage(i, unlinked))
  if (survivors.length > 0) {
    const dated = taskDate
      ? survivors.filter(i => versionAppliesOn(i, taskDate))
          .sort((a, b) => b.effective_from.localeCompare(a.effective_from))
      : []
    const pick = dated[0] ?? survivors
      .slice()
      .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0]
    return { kind: 'restamp', itemId: pick.id }
  }

  return { kind: 'redetect' }
}

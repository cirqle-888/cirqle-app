/**
 * Work-value resolution — the pool basis for contribution earnings.
 *
 * A retainer-covered task bills the client 0 (the monthly retainer is the
 * invoice), so the employee pool cannot come from billing_amount_inr. Instead
 * the agreement item carries a `work_unit_value`, and the DB stamps
 * `tasks.work_value_inr = work_unit_value × quantity × fx` on every covered
 * task (migration 20260807110000). This module is the ONE place that decides
 * which number feeds the pool, so every engine (live panel, recalc, report,
 * payroll sync) agrees.
 *
 * Rules:
 *   • covered & not extra  → pool basis = work_value_inr (0 when the agreement
 *     has no work value set — deliberately NO fallback to the pricing matrix,
 *     which would re-couple pay to client billing).
 *   • everything else      → pool basis = billing_amount_inr (extras bill the
 *     client via extra_unit_price, and that amount also pays the team).
 *   • commission % — an agreement item's work_commission_pct overrides the
 *     pricing-matrix commission_percentage for any task linked to it (covered
 *     OR extra); NULL falls through to the matrix, then the default 50.
 *
 * Pure and framework-free so client components, server actions, and tests all
 * share it.
 */

export interface WorkValueTaskLike {
  billing_amount_inr?: number | null
  work_value_inr?: number | null
  retainer_item_id?: string | null
  bill_as_extra?: boolean | null
}

/** Covered by a retainer and not flagged extra → paid from the work value. */
export function isCoveredWorkTask(t: WorkValueTaskLike): boolean {
  return !!t.retainer_item_id && !t.bill_as_extra
}

/** The INR amount the employee pool is computed from. */
export function taskPoolBasisInr(t: WorkValueTaskLike): number {
  return isCoveredWorkTask(t) ? (t.work_value_inr ?? 0) : (t.billing_amount_inr ?? 0)
}

/** True when a covered task cannot pay out because no work value is set. */
export function missingWorkValue(t: WorkValueTaskLike): boolean {
  return isCoveredWorkTask(t) && (t.work_value_inr == null || t.work_value_inr === 0)
}

/**
 * Commission % precedence for a task:
 * agreement item's work_commission_pct (when linked) → pricing matrix → 50.
 */
export function resolveCommissionPct(
  t: WorkValueTaskLike,
  agreementPct: number | null | undefined,
  matrixPct: number | null | undefined,
  fallback = 50,
): number {
  if (t.retainer_item_id && agreementPct != null) return agreementPct
  return matrixPct ?? fallback
}

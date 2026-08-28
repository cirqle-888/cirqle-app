/**
 * Waived work — free to the client, still worth its full internal value.
 *
 * The agency gives work away for several honest reasons: a cover image thrown
 * in with a retainer, a goodwill freebie, a rework of our own mistake, an
 * internal job. Pricing it at ₹0 was the old way of expressing that, and it was
 * wrong twice over: the designer's commission is a share of the task's amount
 * (`remainingPool × score%`), so a ₹0 task pays the person who did the work
 * nothing — and the business loses any record of what it gave away.
 *
 * So a waived task keeps its Pricing-Matrix amount. `is_billable = false` is
 * the ONLY thing that changes, and it means exactly one thing:
 *
 *     the client is not charged for this task.
 *
 * Everything internal — commission, productivity, task value, package
 * progress — keeps reading `billing_amount_inr` as before. Only two families of
 * reader ask this module a question:
 *
 *   • invoicing — never put a waived task on a client's invoice
 *   • REVENUE   — money we actually earned. Waived work earns nothing.
 *
 * NULL is billable. The flag arrived long after the rows did, and treating an
 * unset flag as waived would silently empty every invoice.
 */

export const NO_CHARGE_REASONS = [
  { value: 'package',  label: 'Included in package' },
  { value: 'goodwill', label: 'Goodwill' },
  { value: 'rework',   label: 'Rework' },
  { value: 'internal', label: 'Internal' },
] as const

export type NoChargeReason = (typeof NO_CHARGE_REASONS)[number]['value']

/** The default a manager gets when they waive a task without saying why. */
export const DEFAULT_NO_CHARGE_REASON: NoChargeReason = 'goodwill'

export function isNoChargeReason(v: unknown): v is NoChargeReason {
  return typeof v === 'string' && NO_CHARGE_REASONS.some(r => r.value === v)
}

/** Client-facing wording for a reason code; the raw code if it is unknown. */
export function noChargeReasonLabel(v: string | null | undefined): string {
  return NO_CHARGE_REASONS.find(r => r.value === v)?.label ?? (v || '')
}

/**
 * Normalise a reason for storage: kept only while the task is actually waived,
 * so a task switched back to Billable never carries a stale explanation.
 */
export function normalizeNoChargeReason(
  isBillable: boolean | null | undefined,
  reason: string | null | undefined,
): NoChargeReason | null {
  if (isBillable !== false) return null
  return isNoChargeReason(reason) ? reason : DEFAULT_NO_CHARGE_REASON
}

/** Can this task be charged to the client? Unset (NULL) means yes. */
export function isBillableTask(t: { is_billable?: boolean | null } | null | undefined): boolean {
  return !!t && t.is_billable !== false
}

/** The opposite, for readability at call sites that care about free work. */
export function isWaivedTask(t: { is_billable?: boolean | null } | null | undefined): boolean {
  return !!t && t.is_billable === false
}

/**
 * Drop waived tasks from a PostgREST query.
 *
 * `not.is.false` — NOT `eq.true` — because the column is nullable on every row
 * written before it existed, and `is_billable=eq.true` would exclude all of
 * them. Structurally typed so it works with any query builder shape without
 * importing Supabase's generics.
 */
export function excludeWaived<T extends { not(column: string, operator: string, value: unknown): T }>(
  query: T,
): T {
  return query.not('is_billable', 'is', false)
}

// ── Pre-migration safety net ────────────────────────────────────────────────
// `no_charge_reason` arrives with migration 20260829140000. Until it is applied,
// naming it in a write is a hard error — and a task that will not save is far
// worse than one that saves without its reason. Same shape as
// finance/classify's scope retry, which exists for exactly this reason.

type PgWriteResult = { error: { code?: string | null; message?: string | null } | null }

export function isNoChargeColumnMissing(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false
  if (error.code !== 'PGRST204' && error.code !== '42703') return false
  return /no_charge_reason/.test(error.message ?? '')
}

/** Copy of a row without the waiver reason, for the pre-migration retry. */
export function withoutNoChargeReason<T extends object>(row: T): Omit<T, 'no_charge_reason'> {
  const { no_charge_reason: _r, ...rest } = row as T & { no_charge_reason?: unknown }
  return rest
}

/** Run a write that names `no_charge_reason`; retry once without it if absent. */
export async function retryWithoutNoChargeReason<R extends PgWriteResult>(
  attempt: (strip: boolean) => PromiseLike<R>,
): Promise<R> {
  const first = await attempt(false)
  if (isNoChargeColumnMissing(first.error)) return attempt(true)
  return first
}

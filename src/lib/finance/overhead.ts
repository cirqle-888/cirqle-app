/**
 * Overhead allocation and in-month expense recovery.
 *
 * Two questions, one expense number, never double-counted:
 *
 *   RECOVERY  — "has this month's work covered the rent yet?" An operational
 *               meter that walks completed work in date order and stops the
 *               moment the month's posted expenses are covered.
 *   ALLOCATION — "what did this client really cost us?" A reporting view that
 *               spreads the same expenses across clients by revenue share.
 *
 * Both read the SAME policy composition the profit engine uses, which is what
 * stops the "four disagreeing margin numbers" problem the architecture notes
 * warn about.
 *
 * RECOVERY COMES FROM THE COMPANY SHARE, NOT THE CONTRIBUTION POOL. Nothing
 * here reduces any employee's contribution earnings; it is attribution over
 * money the company already keeps. Support staff still feel expenses, because
 * profit-based ownership rewards are computed after them.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchJournalLines } from './journal'
import { expensesFromLines, loadOverheadPolicy, type OverheadPolicy } from './profit'

// Canonical money rounding — a local Math.round(n * 100) / 100 disagrees at
// the .xx5 midpoints (1.005 -> 1.00 instead of 1.01). See currency.ts round2.
import { round2 as r2 } from '@/lib/calculations/currency'

// ── Proportional allocation ──────────────────────────────────────────────────

export interface AllocationEntity {
  id: string
  billingInr: number
}

/**
 * Spread `totalInr` across entities in proportion to their billing.
 *
 * Uses largest-remainder so the shares sum EXACTLY to the total — naive
 * rounding leaves a few paise unallocated, and a profitability report whose
 * overhead column does not tie back to the P&L invites exactly the mistrust
 * this whole layer exists to prevent.
 */
export function allocateOverhead(
  totalInr: number,
  entities: AllocationEntity[],
): Map<string, number> {
  const out = new Map<string, number>()
  const base = entities.reduce((s, e) => s + Math.max(0, e.billingInr), 0)
  if (entities.length === 0) return out
  if (base <= 0 || totalInr === 0) {
    for (const e of entities) out.set(e.id, 0)
    return out
  }

  // Work in paise so the remainder distribution is exact.
  const totalPaise = Math.round(totalInr * 100)
  const exact = entities.map(e => ({
    id: e.id,
    raw: (Math.max(0, e.billingInr) / base) * totalPaise,
  }))
  const floored = exact.map(e => ({ id: e.id, paise: Math.floor(e.raw), rem: e.raw - Math.floor(e.raw) }))
  let assigned = floored.reduce((s, e) => s + e.paise, 0)

  // Hand the leftover paise to the largest remainders first.
  const order = [...floored].sort((a, b) => b.rem - a.rem)
  let i = 0
  while (assigned < totalPaise && order.length > 0) {
    order[i % order.length].paise += 1
    assigned += 1
    i++
  }
  for (const e of floored) out.set(e.id, e.paise / 100)
  return out
}

// ── In-month recovery meter ──────────────────────────────────────────────────

export interface RecoveryTask {
  id: string
  date: string          // YYYY-MM-DD
  billingInr: number
}

export interface RecoveryMeter {
  expenseTotalInr: number
  recoveredInr: number
  remainingInr: number
  /** Date the month's expenses were fully covered, if they were. */
  breakEvenDate: string | null
  /** Per-task attribution, in date order. */
  attributions: { taskId: string; date: string; leviedInr: number }[]
  ratePercent: number
}

/**
 * Walk completed work in date order, levying `ratePercent` of each task's
 * billing against the month's posted expenses.
 *
 * NEVER RECOVERS MORE THAN THE ACTUAL EXPENSES: each levy is
 * `min(rate × billing, still unrecovered)`, so the meter stops dead at 100%.
 * That cap is the whole point — an uncapped rate would quietly turn a fixed
 * cost into a variable tax on every task for the rest of the month.
 *
 * Pure, so the cap is provable without a database.
 */
export function computeRecoveryMeter(
  tasks: RecoveryTask[],
  expenseTotalInr: number,
  ratePercent: number,
): RecoveryMeter {
  const rate = Math.max(0, ratePercent) / 100
  const total = Math.max(0, r2(expenseTotalInr))
  const ordered = [...tasks].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))

  const attributions: RecoveryMeter['attributions'] = []
  let recovered = 0
  let breakEvenDate: string | null = null

  for (const t of ordered) {
    const remaining = r2(total - recovered)
    if (remaining <= 0) break                       // fully covered — stop levying
    const levy = r2(Math.min(Math.max(0, t.billingInr) * rate, remaining))
    if (levy <= 0) continue
    recovered = r2(recovered + levy)
    attributions.push({ taskId: t.id, date: t.date, leviedInr: levy })
    if (breakEvenDate === null && recovered >= total) breakEvenDate = t.date
  }

  return {
    expenseTotalInr: total,
    recoveredInr: recovered,
    remainingInr: r2(Math.max(0, total - recovered)),
    breakEvenDate,
    attributions,
    ratePercent,
  }
}

// ── IO ───────────────────────────────────────────────────────────────────────

/** Company operating expenses for a date range, per the shared policy. */
export async function computeCompanyOverhead(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
  range: { from?: string; to?: string } = {},
  policyOverride?: OverheadPolicy,
): Promise<{ totalInr: number; policy: OverheadPolicy }> {
  const policy = policyOverride ?? await loadOverheadPolicy(admin, range.to)
  try {
    const lines = await fetchJournalLines(admin, { ...range, scope: 'company' })
    return { totalInr: expensesFromLines(lines, policy), policy }
  } catch {
    return { totalInr: 0, policy }
  }
}

/** The month's recovery meter, from live tasks + posted expenses. */
export async function loadRecoveryMeter(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
  month: number,
  year: number,
): Promise<RecoveryMeter> {
  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear = month === 12 ? year + 1 : year
  const start = `${year}-${String(month).padStart(2, '0')}-01`
  const nextStart = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`
  const endInclusive = new Date(`${nextStart}T00:00:00Z`)
  endInclusive.setUTCDate(endInclusive.getUTCDate() - 1)
  const to = endInclusive.toISOString().slice(0, 10)

  const { totalInr, policy } = await computeCompanyOverhead(admin, { from: start, to })

  let tasks: RecoveryTask[] = []
  try {
    const { data } = await admin
      .from('tasks')
      .select('id, task_date, billing_amount_inr')
      .gte('task_date', start).lt('task_date', nextStart)
      .is('deleted_at', null)
      // Free work recovers no overhead — it has no client money behind it.
      .not('is_billable', 'is', false)
      .order('task_date')
    tasks = (data || []).map((t: Record<string, unknown>) => ({
      id: t.id as string,
      date: t.task_date as string,
      billingInr: Number(t.billing_amount_inr || 0),
    }))
  } catch { /* no tasks readable — meter shows nothing recovered */ }

  return computeRecoveryMeter(tasks, totalInr, policy.recoveryRatePercent)
}

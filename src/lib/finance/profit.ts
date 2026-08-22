/**
 * THE profit engine — one calculation, every consumer.
 *
 * Ownership rewards, dashboards, client profitability, KPIs and every future
 * financial module read profit from here. `docs/architecture/financial-core.md`
 * warns that two reports using different bases is how you end up with four
 * disagreeing margin numbers; a single engine over a single versioned policy
 * makes that impossible by construction.
 *
 *   profit(M) = billing(M)
 *             − contribution earnings(M)      ← what production staff earned
 *             − base salaries(M)              ← fixed pay (optional per employee)
 *             − company expenses(M)           ← cashbook, per policy
 *
 * THE CONTRIBUTION ENGINE IS NOT TOUCHED. This module only READS the earnings
 * the contribution engine already stored. Company expenses never flow back
 * into the pool, a task, or anyone's contribution earnings — they reduce
 * company profit only, which is what ownership rewards are computed from.
 *
 * DOUBLE-COUNT RULE: `opex.salaries` cash movements are excluded from the
 * expense term by default (see the policy's exclude_account_codes). Those
 * payments ARE the salaries and commissions already subtracted above; counting
 * the cash as well would deduct labour twice.
 *
 * CIRCULARITY RULE: ownership rewards are never an input here. They are paid
 * OUT of profit, so subtracting them would make profit depend on itself.
 *
 * OPEN vs LOCKED: an open month recomputes live on every read. A locked month
 * returns its frozen snapshot, so closed books never drift.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchJournalLines } from './journal'
import type { JournalLine, StatementSection } from './types'
// The one money-rounding helper. A local `Math.round(n * 100) / 100` looks
// identical but disagrees at the .xx5 midpoints (1.005 rounds DOWN to 1.00
// without the epsilon guard), so "the profit engine" and pnl.ts could return
// figures a paisa apart for the same input. See currency.ts round2.
import { round2 as r2 } from '@/lib/calculations/currency'

// ── Policy ───────────────────────────────────────────────────────────────────

export interface OverheadPolicy {
  allocationBasis: 'billing_proportional'
  includedSections: StatementSection[]
  excludeAccountCodes: string[]
  recoveryRatePercent: number
}

/**
 * Used when the policy table has not been migrated yet, or a read fails.
 * Identical to the row the migration seeds, so behaviour is the same before
 * and after the table exists.
 */
export const DEFAULT_OVERHEAD_POLICY: OverheadPolicy = {
  allocationBasis: 'billing_proportional',
  includedSections: ['cogs', 'opex'],
  excludeAccountCodes: ['opex.salaries'],
  recoveryRatePercent: 20,
}

/**
 * Newest policy effective on or before `asOf`. Append-only by design: a locked
 * month keeps the policy it was computed under, because a later insert has a
 * later effective_from and is filtered out for that month.
 */
export async function loadOverheadPolicy(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
  asOf?: string,
): Promise<OverheadPolicy> {
  try {
    let q = admin
      .from('overhead_allocation_policy')
      .select('allocation_basis, included_sections, exclude_account_codes, recovery_rate_percent, effective_from')
      .order('effective_from', { ascending: false })
      .limit(1)
    if (asOf) q = q.lte('effective_from', asOf)
    const { data, error } = await q
    if (error || !data?.length) return DEFAULT_OVERHEAD_POLICY
    const row = data[0] as Record<string, unknown>
    return {
      allocationBasis: 'billing_proportional',
      includedSections: (row.included_sections as StatementSection[]) ?? DEFAULT_OVERHEAD_POLICY.includedSections,
      excludeAccountCodes: (row.exclude_account_codes as string[]) ?? DEFAULT_OVERHEAD_POLICY.excludeAccountCodes,
      recoveryRatePercent: Number(row.recovery_rate_percent ?? DEFAULT_OVERHEAD_POLICY.recoveryRatePercent),
    }
  } catch {
    return DEFAULT_OVERHEAD_POLICY // pre-migration — behave exactly as before
  }
}

// ── Pure math ────────────────────────────────────────────────────────────────

export interface ProfitComponents {
  revenueInr: number
  contributionInr: number
  baseSalariesInr: number
  expensesInr: number
}

export interface ProfitResult extends ProfitComponents {
  profitInr: number
  /** True when the figures came from a frozen snapshot (locked month). */
  frozen: boolean
}

/** The formula, in one place. Pure so it is trivially testable. */
export function composeProfit(c: ProfitComponents): number {
  return r2(c.revenueInr - c.contributionInr - c.baseSalariesInr - c.expensesInr)
}

/**
 * Company operating expenses from journal lines, per policy.
 *
 * Journal amounts are signed (inflow +, outflow −), so an expense is the
 * magnitude of a negative line — mirroring computeCompanyOpsStrip.
 */
export function expensesFromLines(lines: JournalLine[], policy: OverheadPolicy): number {
  let total = 0
  for (const l of lines) {
    if (!l.section || !policy.includedSections.includes(l.section)) continue
    if (l.accountCode && policy.excludeAccountCodes.includes(l.accountCode)) continue
    if (l.amountInr < 0) total += -l.amountInr
  }
  return r2(total)
}

/** First day of the month, and of the month after — the standard task window. */
export function monthBounds(month: number, year: number): { start: string; nextStart: string } {
  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear = month === 12 ? year + 1 : year
  return {
    start: `${year}-${String(month).padStart(2, '0')}-01`,
    nextStart: `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`,
  }
}

/** Inclusive end date (what fetchJournalLines expects) for a month. */
function inclusiveEnd(month: number, year: number): string {
  const { nextStart } = monthBounds(month, year)
  const d = new Date(`${nextStart}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

// ── Live computation ─────────────────────────────────────────────────────────

/**
 * Compute a month's profit from live data. Every term degrades to 0 on a read
 * failure rather than throwing: a partial profit figure on a dashboard is
 * recoverable, a crashed payroll page is not.
 */
export async function computeMonthlyProfit(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
  month: number,
  year: number,
): Promise<ProfitResult> {
  const { start, nextStart } = monthBounds(month, year)
  const policy = await loadOverheadPolicy(admin, inclusiveEnd(month, year))

  // Revenue = billing of the month's tasks. Same window predicate as
  // computeMonthlyCommissions, so profit and payroll always agree on which
  // tasks belong to a month.
  let revenueInr = 0
  const taskIds: string[] = []
  try {
    const { data } = await admin
      .from('tasks')
      .select('id, billing_amount_inr')
      .gte('task_date', start)
      .lt('task_date', nextStart)
      .is('deleted_at', null)
    for (const t of (data || []) as { id: string; billing_amount_inr: number | null }[]) {
      revenueInr += Number(t.billing_amount_inr || 0)
      taskIds.push(t.id)
    }
  } catch { /* leave 0 */ }

  // Contribution earnings — READ ONLY. Chunked exactly like
  // computeMonthlyCommissions (PostgREST caps `.in()` lists).
  let contributionInr = 0
  try {
    const CHUNK = 200
    for (let i = 0; i < taskIds.length; i += CHUNK) {
      const { data } = await admin
        .from('contribution_scores')
        .select('earnings_inr')
        .in('task_id', taskIds.slice(i, i + CHUNK))
      for (const s of (data || []) as { earnings_inr: number | null }[]) {
        contributionInr += Number(s.earnings_inr || 0)
      }
    }
  } catch { /* leave 0 */ }

  // Base salaries: what the month's payroll actually recorded, falling back to
  // current employee salaries for months not yet drafted (so an open month
  // still shows a realistic profit).
  let baseSalariesInr = 0
  try {
    const { data: rows } = await admin
      .from('payroll').select('base_salary').eq('month', month).eq('year', year)
    if (rows && rows.length > 0) {
      for (const p of rows as { base_salary: number | null }[]) baseSalariesInr += Number(p.base_salary || 0)
    } else {
      const { data: emps } = await admin
        .from('employees').select('base_salary').eq('is_active', true)
      for (const e of (emps || []) as { base_salary: number | null }[]) baseSalariesInr += Number(e.base_salary || 0)
    }
  } catch { /* leave 0 */ }

  // Company expenses (includes auto-posted recurring expenses).
  let expensesInr = 0
  try {
    const lines = await fetchJournalLines(admin, {
      from: start, to: inclusiveEnd(month, year), scope: 'company',
    })
    expensesInr = expensesFromLines(lines, policy)
  } catch { /* leave 0 */ }

  const components: ProfitComponents = {
    revenueInr: r2(revenueInr),
    contributionInr: r2(contributionInr),
    baseSalariesInr: r2(baseSalariesInr),
    expensesInr,
  }
  return { ...components, profitInr: composeProfit(components), frozen: false }
}

/**
 * A month's profit, honouring closed books: locked months return their frozen
 * snapshot, open months recompute. This is what every consumer should call.
 */
export async function getMonthlyProfit(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
  month: number,
  year: number,
): Promise<ProfitResult> {
  try {
    const { data } = await admin
      .from('profit_snapshots')
      .select('revenue_inr, contribution_inr, base_salaries_inr, expenses_inr, profit_inr')
      .eq('month', month).eq('year', year)
      .maybeSingle()
    if (data) {
      const row = data as Record<string, unknown>
      return {
        revenueInr: Number(row.revenue_inr || 0),
        contributionInr: Number(row.contribution_inr || 0),
        baseSalariesInr: Number(row.base_salaries_inr || 0),
        expensesInr: Number(row.expenses_inr || 0),
        profitInr: Number(row.profit_inr || 0),
        frozen: true,
      }
    }
  } catch { /* pre-migration — fall through to live */ }
  return computeMonthlyProfit(admin, month, year)
}

/** Sum of monthly profits across a range — quarterly and yearly figures.
 *  Frozen months contribute their snapshot, so a closed quarter never drifts. */
export async function getPeriodProfit(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
  months: { month: number; year: number }[],
): Promise<ProfitResult> {
  const acc: ProfitComponents = { revenueInr: 0, contributionInr: 0, baseSalariesInr: 0, expensesInr: 0 }
  let allFrozen = months.length > 0
  // Each month is an independent read, so they go out together — a quarter is
  // 3 round trips deep instead of 3 in series, a year 12. Promise.all keeps
  // input order, which matters: the accumulation below must stay deterministic
  // or float addition can land on a different paisa run to run.
  const results = await Promise.all(months.map(m => getMonthlyProfit(admin, m.month, m.year)))
  for (const r of results) {
    acc.revenueInr += r.revenueInr
    acc.contributionInr += r.contributionInr
    acc.baseSalariesInr += r.baseSalariesInr
    acc.expensesInr += r.expensesInr
    if (!r.frozen) allFrozen = false
  }
  const components: ProfitComponents = {
    revenueInr: r2(acc.revenueInr),
    contributionInr: r2(acc.contributionInr),
    baseSalariesInr: r2(acc.baseSalariesInr),
    expensesInr: r2(acc.expensesInr),
  }
  return { ...components, profitInr: composeProfit(components), frozen: allFrozen }
}

/**
 * Freeze a month's profit. Called when the owner locks the period.
 *
 * HISTORICAL PROTECTION: a month that is already finalized keeps its existing
 * snapshot — re-freezing would let a later data edit silently rewrite closed
 * books. Guarded before any write, matching every other money writer.
 */
export async function persistProfitSnapshot(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
  month: number,
  year: number,
): Promise<{ ok: boolean; skipped?: 'exists' }> {
  const { data: existing } = await admin
    .from('profit_snapshots').select('id').eq('month', month).eq('year', year).maybeSingle()
  if (existing) return { ok: true, skipped: 'exists' }

  const p = await computeMonthlyProfit(admin, month, year)
  const policy = await loadOverheadPolicy(admin, inclusiveEnd(month, year))
  const { error } = await admin.from('profit_snapshots').insert({
    month, year,
    revenue_inr: p.revenueInr,
    contribution_inr: p.contributionInr,
    base_salaries_inr: p.baseSalariesInr,
    expenses_inr: p.expensesInr,
    profit_inr: p.profitInr,
    breakdown: {
      policy,
      formula: 'revenue - contribution - baseSalaries - expenses',
      note: 'opex.salaries excluded from expenses to avoid double-counting labour already subtracted as contribution + base salaries.',
    },
  })
  return { ok: !error }
}

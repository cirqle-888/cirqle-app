/**
 * Ownership engine — the IO shell around the pure core.
 *
 * Loads programs, rules and the money for a period; delegates every decision
 * to compute.ts; writes immutable award snapshots; totals them into payroll.
 *
 * THE CONTRIBUTION ENGINE IS UNTOUCHED. This reads task billing and the
 * profit engine's output; it never reads, writes or reweights
 * contribution_scores. Ownership is a second, independent earning stream.
 *
 * HISTORICAL PROTECTION: awards are never recomputed into a closed month.
 * Once a payroll is paid or a period is locked, `isMonthFinalized` blocks the
 * write and the stored snapshot stands — the same guard every other money
 * writer in the app funnels through.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { isMonthFinalized } from '@/lib/payroll/compute'
import { getPeriodProfit, monthBounds } from '@/lib/finance/profit'
import { fetchJournalLines } from '@/lib/finance/journal'
import { loadOrgGraph, resolveScope, matchesScope } from '@/lib/org/units'
import { computeAwards, resolveParticipants } from './compute'
import { monthsInPeriod, periodForBookingMonth, activeForPeriod } from './periods'
import type {
  OwnershipAward, OwnershipPeriod, OwnershipProgram, OwnershipRule, PeriodAggregates,
} from './types'

const r2 = (n: number) => Math.round(n * 100) / 100

// ── Loading ──────────────────────────────────────────────────────────────────

/** Pre-migration environments return empty lists, so every caller no-ops. */
export async function loadPrograms(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
): Promise<{ programs: OwnershipProgram[]; rules: OwnershipRule[] }> {
  try {
    const [p, r] = await Promise.all([
      admin.from('ownership_programs').select('*').order('created_at'),
      admin.from('ownership_rules').select('*').order('created_at'),
    ])
    if (p.error || r.error) return { programs: [], rules: [] }
    return {
      programs: (p.data || []).map(mapProgram),
      rules: (r.data || []).map(mapRule),
    }
  } catch {
    return { programs: [], rules: [] }
  }
}

function mapProgram(r: Record<string, unknown>): OwnershipProgram {
  return {
    id: r.id as string,
    name: r.name as string,
    programType: (r.program_type as string) ?? 'revenue_share',
    basis: r.basis as OwnershipProgram['basis'],
    periodType: (r.period_type as OwnershipProgram['periodType']) ?? 'monthly',
    scopeKind: (r.scope_kind as OwnershipProgram['scopeKind']) ?? 'company',
    scopeId: (r.scope_id as string) ?? null,
    periodStart: (r.period_start as string) ?? null,
    periodEnd: (r.period_end as string) ?? null,
    effectiveFrom: r.effective_from as string,
    effectiveTo: (r.effective_to as string) ?? null,
    isActive: r.is_active !== false,
  }
}

function mapRule(r: Record<string, unknown>): OwnershipRule {
  return {
    id: r.id as string,
    programId: r.program_id as string,
    employeeId: (r.employee_id as string) ?? null,
    designationId: (r.designation_id as string) ?? null,
    percent: r.percent == null ? null : Number(r.percent),
    fixedAmountInr: r.fixed_amount_inr == null ? null : Number(r.fixed_amount_inr),
    label: (r.label as string) ?? null,
    effectiveFrom: r.effective_from as string,
    effectiveTo: (r.effective_to as string) ?? null,
    isActive: r.is_active !== false,
  }
}

/** designationId → active employee ids. Powers designation-wide rules. */
export async function loadMembersByDesignation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  try {
    const { data } = await admin
      .from('employees').select('id, designation_id')
      .eq('is_active', true).or('is_archived.is.null,is_archived.eq.false')
    for (const e of (data || []) as { id: string; designation_id: string | null }[]) {
      if (!e.designation_id) continue
      const list = out.get(e.designation_id) ?? []
      list.push(e.id)
      out.set(e.designation_id, list)
    }
  } catch { /* pre-migration or read failure — no designation rules fire */ }
  return out
}

// ── Money for a period, per program scope ────────────────────────────────────

/**
 * Scoped billing + collections + profit for one program's period.
 *
 * Billing uses the same task-window predicate as computeMonthlyCommissions, so
 * ownership and payroll always agree on which tasks belong to a period.
 * Profit comes from the ONE profit engine (frozen for locked months), which is
 * what keeps every consumer's profit figure identical by construction.
 */
export async function loadPeriodAggregates(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
  program: OwnershipProgram,
  period: OwnershipPeriod,
): Promise<PeriodAggregates> {
  let billingInr = 0
  let collectedInr = 0
  let profitInr = 0

  // Profit is company-wide by definition (enforced by a CHECK on the table).
  if (program.basis === 'profit') {
    const p = await getPeriodProfit(admin, monthsInPeriod(period))
    profitInr = p.profitInr
  }

  if (program.basis === 'billing') {
    // service_id → category, so a category- or unit-scoped program can filter
    // on the discipline a task belongs to.
    const svcCat = new Map<string, string | null>()
    try {
      const { data } = await admin.from('services').select('id, category_id')
      for (const s of (data || []) as { id: string; category_id: string | null }[]) {
        svcCat.set(s.id, s.category_id)
      }
    } catch { /* leave unmapped — category scoping then matches nothing */ }

    let unitScope: ReturnType<typeof resolveScope> | null = null
    if (program.scopeKind === 'org_unit' && program.scopeId) {
      const { units, scopes } = await loadOrgGraph(admin)
      unitScope = resolveScope(units, scopes, program.scopeId)
    }

    try {
      const { data } = await admin
        .from('tasks')
        .select('billing_amount_inr, client_id, service_id')
        .gte('task_date', period.start)
        .lte('task_date', period.end)
        .is('deleted_at', null)
      for (const t of (data || []) as { billing_amount_inr: number | null; client_id: string | null; service_id: string | null }[]) {
        const categoryId = t.service_id ? svcCat.get(t.service_id) ?? null : null
        let include = false
        switch (program.scopeKind) {
          case 'company':          include = true; break
          case 'client':           include = t.client_id === program.scopeId; break
          case 'service':          include = t.service_id === program.scopeId; break
          case 'service_category': include = categoryId === program.scopeId; break
          case 'org_unit':
            include = unitScope
              ? matchesScope(unitScope, { clientId: t.client_id, serviceId: t.service_id, serviceCategoryId: categoryId })
              : false     // unresolvable unit owns nothing — never everything
            break
        }
        if (include) billingInr += Number(t.billing_amount_inr || 0)
      }
    } catch { /* leave 0 */ }
  }

  if (program.basis === 'collected') {
    // Cash actually received. Entries carry a client but no service dimension,
    // which is why the table CHECK forbids service scopes on this basis.
    try {
      const lines = await fetchJournalLines(admin, { from: period.start, to: period.end })
      let clientFilter: Set<string> | null = null
      if (program.scopeKind === 'client' && program.scopeId) clientFilter = new Set([program.scopeId])
      if (program.scopeKind === 'org_unit' && program.scopeId) {
        const { units, scopes } = await loadOrgGraph(admin)
        clientFilter = resolveScope(units, scopes, program.scopeId).clientIds
      }
      for (const l of lines) {
        if (l.section !== 'revenue' || l.amountInr <= 0) continue
        if (clientFilter && (!l.clientId || !clientFilter.has(l.clientId))) continue
        collectedInr += l.amountInr
      }
    } catch { /* leave 0 */ }
  }

  return { billingInr: r2(billingInr), collectedInr: r2(collectedInr), profitInr: r2(profitInr) }
}

// ── Computing + persisting ───────────────────────────────────────────────────

/** Every award that should exist for a payroll month, across all programs. */
export async function computeAwardsForMonth(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
  month: number,
  year: number,
): Promise<OwnershipAward[]> {
  const { programs, rules } = await loadPrograms(admin)
  if (programs.length === 0) return []
  const membersByDesignation = await loadMembersByDesignation(admin)

  const out: OwnershipAward[] = []
  for (const program of programs) {
    if (!program.isActive) continue
    const period = periodForBookingMonth(
      program.periodType, month, year,
      { start: program.periodStart, end: program.periodEnd },
    )
    if (!period) continue                                        // does not pay this month
    if (!activeForPeriod(program.effectiveFrom, program.effectiveTo, period)) continue

    const live = rules.filter(r =>
      r.programId === program.id && activeForPeriod(r.effectiveFrom, r.effectiveTo, period))
    const participants = resolveParticipants(live, membersByDesignation)
    if (participants.length === 0) continue

    const agg = await loadPeriodAggregates(admin, program, period)
    out.push(...computeAwards(program, participants, agg, period))
  }
  return out
}

/**
 * Persist a month's awards.
 *
 * HISTORICAL EARNINGS PROTECTION: a finalized month keeps the awards it was
 * paid with. Recomputing into closed books would rewrite issued payslips —
 * the same rule every money writer here obeys, checked before any write.
 */
export async function persistAwardsForMonth(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
  month: number,
  year: number,
): Promise<{ persisted: number; skipped?: 'finalized' }> {
  if (await isMonthFinalized(admin, month, year)) {
    return { persisted: 0, skipped: 'finalized' }
  }

  const awards = await computeAwardsForMonth(admin, month, year)

  // Programs/rules can be deleted or deactivated between runs; clearing this
  // month's rows first means a removed rule stops paying instead of lingering.
  await admin.from('ownership_awards')
    .delete().eq('booked_month', month).eq('booked_year', year)
  if (awards.length === 0) return { persisted: 0 }

  const rows = awards.map(a => ({
    program_id: a.programId,
    rule_id: a.ruleId,
    employee_id: a.employeeId,
    period_start: a.period.start,
    period_end: a.period.end,
    basis: a.basis,
    basis_amount_inr: a.basisAmountInr,
    percent: a.percent,
    fixed_amount_inr: a.fixedAmountInr,
    earned_inr: a.earnedInr,
    booked_month: a.period.bookedMonth,
    booked_year: a.period.bookedYear,
    breakdown: a.breakdown,
  }))
  const { error } = await admin.from('ownership_awards')
    .upsert(rows, { onConflict: 'program_id,rule_id,employee_id,period_start' })
  return { persisted: error ? 0 : rows.length }
}

/**
 * Ownership total per employee for a payroll month.
 *
 * Recomputes and stores first (a no-op on a closed month), then reads the
 * snapshots back — so a finalized month returns exactly the frozen figures its
 * payslips were issued with.
 *
 * Returns null on failure so callers can tell "computed as zero" from "could
 * not compute" and leave stored values alone rather than zeroing real pay.
 */
export async function computeMonthlyOwnership(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
  month: number,
  year: number,
): Promise<Record<string, number> | null> {
  try {
    await persistAwardsForMonth(admin, month, year)
    const { data, error } = await admin
      .from('ownership_awards')
      .select('employee_id, earned_inr')
      .eq('booked_month', month).eq('booked_year', year)
    if (error) {
      // A missing table is "feature not installed", not a failure.
      return /does not exist|PGRST205/i.test(error.message || '') ? {} : null
    }
    const out: Record<string, number> = {}
    for (const a of (data || []) as { employee_id: string; earned_inr: number | null }[]) {
      out[a.employee_id] = r2((out[a.employee_id] || 0) + Number(a.earned_inr || 0))
    }
    return out
  } catch {
    return null
  }
}

/** Awards behind a payslip, for the itemised breakdown. */
export async function loadAwardsForPayslip(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
  employeeId: string,
  month: number,
  year: number,
): Promise<{ programName: string; label: string | null; basis: string; basisAmountInr: number; percent: number | null; earnedInr: number }[]> {
  try {
    const { data, error } = await admin
      .from('ownership_awards')
      .select('basis, basis_amount_inr, percent, earned_inr, breakdown, program:ownership_programs(name)')
      .eq('employee_id', employeeId).eq('booked_month', month).eq('booked_year', year)
    if (error) return []
    return (data || []).map((r: Record<string, unknown>) => ({
      programName: (r.program as { name?: string } | null)?.name
        ?? String((r.breakdown as Record<string, unknown>)?.programName ?? 'Ownership reward'),
      label: ((r.breakdown as Record<string, unknown>)?.ruleLabel as string) ?? null,
      basis: r.basis as string,
      basisAmountInr: Number(r.basis_amount_inr || 0),
      percent: r.percent == null ? null : Number(r.percent),
      earnedInr: Number(r.earned_inr || 0),
    }))
  } catch {
    return []
  }
}

export { monthBounds }

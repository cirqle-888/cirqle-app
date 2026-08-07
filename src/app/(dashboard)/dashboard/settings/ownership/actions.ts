'use server'

/**
 * Ownership Platform — configuration actions.
 *
 * Programs and rules are the ONLY thing an owner configures; awards are
 * computed, never entered. Every reward the business wants is a row here:
 * revenue share, profit share, monthly/quarterly/yearly incentives, festival
 * and performance bonuses.
 *
 * Permission: payroll.manage_ownership (admins bypass). It is in CRITICAL_PERMS
 * because it both sets what everyone earns and exposes company profit.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import { isMonthFinalized } from '@/lib/payroll/compute'
import { persistAwardsForMonth, loadPrograms, loadMembersByDesignation, loadPeriodAggregates } from '@/lib/ownership/engine'
import { computeAwards, resolveParticipants, totalProfitSharePercent } from '@/lib/ownership/compute'
import { periodForBookingMonth, activeForPeriod } from '@/lib/ownership/periods'
import type { OwnershipBasis, OwnershipPeriodType, OwnershipScopeKind } from '@/lib/ownership/types'

const REVALIDATE = '/dashboard/settings/ownership'
const MIGRATION = 'supabase/migrations/20260807100000_ownership_platform.sql'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

/** Turn a raw PostgREST "relation missing" into something actionable. */
function friendly(message: string): string {
  return /does not exist|PGRST205|schema cache/i.test(message)
    ? `The Ownership Platform needs a database migration. Run ${MIGRATION} in the Supabase SQL editor, then try again.`
    : message
}

export interface ProgramInput {
  id?: string
  name: string
  programType: string
  basis: OwnershipBasis
  periodType: OwnershipPeriodType
  scopeKind: OwnershipScopeKind
  scopeId?: string | null
  periodStart?: string | null
  periodEnd?: string | null
  effectiveFrom: string
  effectiveTo?: string | null
}

export async function saveProgram(input: ProgramInput): Promise<ActionResult<{ id: string }>> {
  const guard = await requirePermission(PERMS.PAYROLL_MANAGE_OWNERSHIP)
  if (!guard.ok) return { ok: false, error: guard.error }

  const name = (input.name || '').trim()
  if (!name) return { ok: false, error: 'Give the program a name.' }

  // Mirror the table's CHECK constraints so the operator gets a sentence, not
  // a Postgres error.
  if (input.basis === 'profit' && input.scopeKind !== 'company') {
    return { ok: false, error: 'Profit is a company-wide figure — a profit program cannot be scoped to one client or service.' }
  }
  if (input.basis === 'collected' && !['company', 'client', 'org_unit'].includes(input.scopeKind)) {
    return { ok: false, error: 'Collections are recorded per client, not per service — use a company, client or unit scope.' }
  }
  if (input.scopeKind !== 'company' && !input.scopeId) {
    return { ok: false, error: 'Pick what this program is scoped to.' }
  }
  if (input.periodType === 'one_time' && (!input.periodStart || !input.periodEnd)) {
    return { ok: false, error: 'A one-time program needs a start and end date.' }
  }

  const admin = createAdminClient()
  const row = {
    name,
    program_type: input.programType || 'revenue_share',
    basis: input.basis,
    period_type: input.periodType,
    scope_kind: input.scopeKind,
    scope_id: input.scopeKind === 'company' ? null : input.scopeId,
    period_start: input.periodType === 'one_time' ? input.periodStart : null,
    period_end: input.periodType === 'one_time' ? input.periodEnd : null,
    effective_from: input.effectiveFrom,
    effective_to: input.effectiveTo || null,
    updated_at: new Date().toISOString(),
  }

  if (input.id) {
    const { error } = await admin.from('ownership_programs').update(row).eq('id', input.id)
    if (error) return { ok: false, error: friendly(error.message) }
    void logActivity({ actorId: guard.employeeId, entityType: 'payroll', entityId: input.id, action: 'updated', detail: { ownership_program: name } }).catch(() => {})
    revalidatePath(REVALIDATE)
    return { ok: true, data: { id: input.id } }
  }

  const { data, error } = await admin.from('ownership_programs')
    .insert({ ...row, created_by: guard.employeeId }).select('id').single()
  if (error) return { ok: false, error: friendly(error.message) }
  void logActivity({ actorId: guard.employeeId, entityType: 'payroll', entityId: data.id, action: 'created', detail: { ownership_program: name } }).catch(() => {})
  revalidatePath(REVALIDATE)
  return { ok: true, data: { id: data.id } }
}

export async function setProgramActive(id: string, isActive: boolean): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PAYROLL_MANAGE_OWNERSHIP)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('ownership_programs')
    .update({ is_active: isActive, updated_at: new Date().toISOString() }).eq('id', id)
  if (error) return { ok: false, error: friendly(error.message) }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/**
 * Delete a program.
 *
 * Awards cascade with it. That is safe for an open month (they would be
 * recomputed anyway) but would erase the record behind an ALREADY PAID
 * payslip, so a program that has ever paid into a closed month is refused —
 * deactivate it instead, which stops future awards while keeping history.
 */
export async function deleteProgram(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PAYROLL_MANAGE_OWNERSHIP)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()

  const { data: booked } = await admin
    .from('ownership_awards').select('booked_month, booked_year').eq('program_id', id)
  for (const b of (booked || []) as { booked_month: number; booked_year: number }[]) {
    if (await isMonthFinalized(admin, b.booked_month, b.booked_year)) {
      return {
        ok: false,
        error: 'This program has already paid into a closed month. Deactivate it instead — deleting it would erase the record behind an issued payslip.',
      }
    }
  }

  const { error } = await admin.from('ownership_programs').delete().eq('id', id)
  if (error) return { ok: false, error: friendly(error.message) }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

export interface RuleInput {
  id?: string
  programId: string
  employeeId?: string | null
  designationId?: string | null
  percent?: number | null
  fixedAmountInr?: number | null
  label?: string | null
  effectiveFrom: string
  effectiveTo?: string | null
}

export async function saveRule(input: RuleInput): Promise<ActionResult<{ id: string }>> {
  const guard = await requirePermission(PERMS.PAYROLL_MANAGE_OWNERSHIP)
  if (!guard.ok) return { ok: false, error: guard.error }

  const hasEmployee = !!input.employeeId
  const hasDesignation = !!input.designationId
  if (hasEmployee === hasDesignation) {
    return { ok: false, error: 'Target either one employee or one designation — not both, not neither.' }
  }
  const hasPercent = input.percent != null && input.percent !== undefined
  const hasFixed = input.fixedAmountInr != null && input.fixedAmountInr !== undefined
  if (hasPercent === hasFixed) {
    return { ok: false, error: 'Set either a percentage or a fixed amount — not both.' }
  }

  const admin = createAdminClient()
  const row = {
    program_id: input.programId,
    employee_id: input.employeeId || null,
    designation_id: input.designationId || null,
    percent: hasPercent ? input.percent : null,
    fixed_amount_inr: hasFixed ? input.fixedAmountInr : null,
    label: input.label || null,
    effective_from: input.effectiveFrom,
    effective_to: input.effectiveTo || null,
    updated_at: new Date().toISOString(),
  }

  if (input.id) {
    const { error } = await admin.from('ownership_rules').update(row).eq('id', input.id)
    if (error) return { ok: false, error: friendly(error.message) }
    revalidatePath(REVALIDATE)
    return { ok: true, data: { id: input.id } }
  }
  const { data, error } = await admin.from('ownership_rules')
    .insert({ ...row, created_by: guard.employeeId }).select('id').single()
  if (error) return { ok: false, error: friendly(error.message) }
  revalidatePath(REVALIDATE)
  return { ok: true, data: { id: data.id } }
}

export async function deleteRule(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PAYROLL_MANAGE_OWNERSHIP)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('ownership_rules').delete().eq('id', id)
  if (error) return { ok: false, error: friendly(error.message) }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/**
 * "What would this pay right now?" — computed live, never stored.
 *
 * The point is that an owner can see the consequence of a rule BEFORE it
 * reaches a payslip. Also returns the total committed profit share, so
 * promising 130% of profit is visible at configuration time rather than on
 * payday.
 */
export async function previewMonth(month: number, year: number): Promise<ActionResult<{
  rows: { programName: string; employeeId: string; label: string | null; basisAmountInr: number; earnedInr: number }[]
  totalInr: number
  profitSharePercent: number
}>> {
  const guard = await requirePermission(PERMS.PAYROLL_MANAGE_OWNERSHIP)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { programs, rules } = await loadPrograms(admin)
  const membersByDesignation = await loadMembersByDesignation(admin)

  const rows: { programName: string; employeeId: string; label: string | null; basisAmountInr: number; earnedInr: number }[] = []
  for (const program of programs) {
    if (!program.isActive) continue
    const period = periodForBookingMonth(program.periodType, month, year, { start: program.periodStart, end: program.periodEnd })
    if (!period) continue
    if (!activeForPeriod(program.effectiveFrom, program.effectiveTo, period)) continue
    const live = rules.filter(r => r.programId === program.id && activeForPeriod(r.effectiveFrom, r.effectiveTo, period))
    const participants = resolveParticipants(live, membersByDesignation)
    if (participants.length === 0) continue
    const agg = await loadPeriodAggregates(admin, program, period)
    for (const a of computeAwards(program, participants, agg, period)) {
      rows.push({
        programName: program.name,
        employeeId: a.employeeId,
        label: a.breakdown.ruleLabel as string | null,
        basisAmountInr: a.basisAmountInr,
        earnedInr: a.earnedInr,
      })
    }
  }

  return {
    ok: true,
    data: {
      rows,
      totalInr: Math.round(rows.reduce((s, r) => s + r.earnedInr, 0) * 100) / 100,
      profitSharePercent: totalProfitSharePercent(programs, rules, membersByDesignation),
    },
  }
}

/** Recompute and store a month's awards — the "Run now" for one-time programs. */
export async function runAwardsForMonth(month: number, year: number): Promise<ActionResult<{ persisted: number; skipped?: string }>> {
  const guard = await requirePermission(PERMS.PAYROLL_MANAGE_OWNERSHIP)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  try {
    const res = await persistAwardsForMonth(admin, month, year)
    revalidatePath(REVALIDATE)
    revalidatePath('/dashboard/payroll')
    return { ok: true, data: res }
  } catch (e) {
    return { ok: false, error: friendly(e instanceof Error ? e.message : 'Could not compute awards.') }
  }
}

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
import { requirePermission, requireReadPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import { isMonthFinalized } from '@/lib/payroll/compute'
import { persistAwardsForMonth, syncPendingPayrollOwnership, loadPrograms, loadMembersByDesignation, loadPeriodAggregates, clientsOf } from '@/lib/ownership/engine'
import { computeAwards, resolveParticipants, totalProfitSharePercent } from '@/lib/ownership/compute'
import { periodForBookingMonth, activeForPeriod } from '@/lib/ownership/periods'
import { PER_PERSON_BASES, PER_PERSON_MONEY_BASES, type OwnershipBasis, type OwnershipPeriodType, type OwnershipScopeKind } from '@/lib/ownership/types'
import { isActivityKind } from '@/lib/ownership/work-measures'

const REVALIDATE = '/dashboard/settings/ownership'
const MIGRATION = 'supabase/migrations/20260807100000_ownership_platform.sql'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

/** Turn a raw PostgREST "relation missing" into something actionable. */
function friendly(message: string): string {
  if (/employee_ids/i.test(message)) {
    return 'One rule for several employees needs a database migration. Run supabase/migrations/20261007100000_ownership_rule_employee_ids.sql in the Supabase SQL editor, then try again.'
  }
  if (/does not exist|PGRST205|schema cache/i.test(message)) {
    return `The Ownership Platform needs a database migration. Run ${MIGRATION} in the Supabase SQL editor, then try again.`
  }
  // A basis the table's CHECK doesn't know yet — the constraint arrives with a
  // later migration, and the raw Postgres string says nothing an owner can act on.
  if (/violates check constraint|23514/i.test(message)) {
    return `This program uses a setting your database hasn't been migrated for yet. Run the pending migrations in supabase/migrations/ in the Supabase SQL editor, then try again.`
  }
  return message
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
  /** `activities` basis only. */
  activityKinds?: string[]
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
  if (PER_PERSON_BASES.includes(input.basis) && input.scopeKind !== 'company') {
    return { ok: false, error: 'This reward measures each person’s own work, so it is company-wide — remove the client/service limit.' }
  }
  const activityKinds = (input.activityKinds ?? []).filter(isActivityKind)
  if (input.basis === 'activities' && activityKinds.length === 0) {
    return { ok: false, error: 'Pick at least one kind of activity to count.' }
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
    // Only written when used, so programs keep saving before 20261006100000 runs.
    ...(input.basis === 'activities' ? { activity_kinds: activityKinds } : {}),
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
  /** Several employees on one rule — each paid on their own work. */
  employeeIds?: string[]
  designationId?: string | null
  percent?: number | null
  fixedAmountInr?: number | null
  label?: string | null
  effectiveFrom: string
  effectiveTo?: string | null
  /** clients_handled programs: which clients this person handles. */
  clientIds?: string[]
}

export async function saveRule(input: RuleInput): Promise<ActionResult<{ id: string }>> {
  const guard = await requirePermission(PERMS.PAYROLL_MANAGE_OWNERSHIP)
  if (!guard.ok) return { ok: false, error: guard.error }

  // One person is stored as employee_id (works before 20261007100000); two or
  // more go in employee_ids.
  const people = [...new Set([...(input.employeeIds ?? []), ...(input.employeeId ? [input.employeeId] : [])].filter(Boolean))]
  const hasEmployee = people.length > 0
  const hasDesignation = !!input.designationId
  if (hasEmployee === hasDesignation) {
    return { ok: false, error: 'Pick employees or a designation — not both, not neither.' }
  }
  const hasPercent = input.percent != null && input.percent !== undefined
  const hasFixed = input.fixedAmountInr != null && input.fixedAmountInr !== undefined
  if (hasPercent === hasFixed) {
    return { ok: false, error: 'Set either a percentage or a fixed amount — not both.' }
  }

  const admin = createAdminClient()

  // A rule's amount means whatever its PROGRAM's basis says it means, so the
  // basis has to be read before the rule can be judged. On a per-unit basis
  // `fixed_amount_inr` is the rate PER UNIT, and a percentage of a row count
  // is not a thing — caught here rather than paying ₹0 silently every month.
  const { data: prog } = await admin
    .from('ownership_programs').select('basis').eq('id', input.programId).maybeSingle()
  const b = (prog as { basis?: OwnershipBasis } | null)?.basis
  if (b && PER_PERSON_BASES.includes(b) && !PER_PERSON_MONEY_BASES.includes(b) && hasPercent) {
    return { ok: false, error: 'This reward is a rupee rate per item, not a percentage — set the ₹ amount instead.' }
  }
  const row = {
    program_id: input.programId,
    employee_id: people.length === 1 ? people[0] : null,
    designation_id: hasDesignation ? input.designationId : null,
    // Only written when it holds a list (or clears one on edit), so one-person
    // and designation rules keep saving before the migration runs.
    ...(people.length > 1 ? { employee_ids: people } : input.id ? { employee_ids: null } : {}),
    percent: hasPercent ? input.percent : null,
    fixed_amount_inr: hasFixed ? input.fixedAmountInr : null,
    label: input.label || null,
    effective_from: input.effectiveFrom,
    effective_to: input.effectiveTo || null,
    updated_at: new Date().toISOString(),
    // Written only for client-handling rules, so other rules save before 20261006120000.
    ...(b === 'clients_handled' ? { client_ids: (input.clientIds ?? []).filter(Boolean) } : {}),
  }

  if (input.id) {
    let { error } = await admin.from('ownership_rules').update(row).eq('id', input.id)
    // Pre-migration: clearing a list that cannot exist yet — retry without it.
    if (error && /employee_ids/i.test(error.message) && people.length <= 1) {
      const { employee_ids: _drop, ...rest } = row as Record<string, unknown>
      void _drop
      ;({ error } = await admin.from('ownership_rules').update(rest).eq('id', input.id))
    }
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

export interface PreviewRow {
  programName: string; employeeId: string; label: string | null; basis: string
  basisAmountInr: number; percent: number | null; fixedAmountInr: number | null; earnedInr: number
  /** What was counted — the entries, clients or planned tasks behind the number. */
  items: { label: string; date: string; amountInr?: number }[]
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
  rows: PreviewRow[]
  totalInr: number
  profitSharePercent: number
}>> {
  const guard = await requireReadPermission(PERMS.PAYROLL_MANAGE_OWNERSHIP)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { programs, rules } = await loadPrograms(admin)
  const membersByDesignation = await loadMembersByDesignation(admin)

  const rows: PreviewRow[] = []
  for (const program of programs) {
    if (!program.isActive) continue
    const period = periodForBookingMonth(program.periodType, month, year, { start: program.periodStart, end: program.periodEnd })
    if (!period) continue
    if (!activeForPeriod(program.effectiveFrom, program.effectiveTo, period)) continue
    const live = rules.filter(r => r.programId === program.id && activeForPeriod(r.effectiveFrom, r.effectiveTo, period))
    const participants = resolveParticipants(live, membersByDesignation)
    if (participants.length === 0) continue
    const agg = await loadPeriodAggregates(
      admin, program, period, participants.map(p => p.employeeId), clientsOf(participants))
    for (const a of computeAwards(program, participants, agg, period)) {
      rows.push({
        programName: program.name,
        employeeId: a.employeeId,
        label: a.breakdown.ruleLabel as string | null,
        basis: program.basis as string,
        basisAmountInr: a.basisAmountInr,
        percent: a.percent,
        fixedAmountInr: a.fixedAmountInr,
        earnedInr: a.earnedInr,
        items: (a.breakdown.items as PreviewRow['items']) ?? [],
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
    // Pending payslips for the month take the new ownership straight away.
    await syncPendingPayrollOwnership(admin, month, year).catch(() => ({ updated: 0 }))
    revalidatePath(REVALIDATE)
    revalidatePath('/dashboard/payroll')
    return { ok: true, data: res }
  } catch (e) {
    return { ok: false, error: friendly(e instanceof Error ? e.message : 'Could not compute awards.') }
  }
}

// ── Who handles each client ──────────────────────────────────────────────────

/**
 * Set (or clear) the employee who handles a client, from a date. The previous
 * handler's row is closed the day before, so earlier work stays credited to
 * them — a handover never moves past months. Pay-bearing, so gated like the
 * rest of Ownership.
 */
export async function setClientHandler(clientId: string, employeeId: string | null, fromDate: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PAYROLL_MANAGE_OWNERSHIP)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) return { ok: false, error: 'Pick a valid start date.' }
  const admin = createAdminClient()
  const { data: open, error: readErr } = await admin.from('client_handlers')
    .select('id, employee_id, effective_from').eq('client_id', clientId).is('effective_to', null).maybeSingle()
  if (readErr) return { ok: false, error: friendly(readErr.message) }
  const cur = open as { id: string; employee_id: string; effective_from: string } | null
  if (cur?.employee_id === employeeId) return { ok: true }
  if (cur) {
    if (cur.effective_from >= fromDate) {
      // Replaced before it ever applied — drop it rather than leave an empty range.
      await admin.from('client_handlers').delete().eq('id', cur.id)
    } else {
      const d = new Date(`${fromDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1)
      await admin.from('client_handlers').update({ effective_to: d.toISOString().slice(0, 10) }).eq('id', cur.id)
    }
  }
  if (employeeId) {
    const { error } = await admin.from('client_handlers')
      .insert({ client_id: clientId, employee_id: employeeId, effective_from: fromDate, created_by: guard.employeeId })
    if (error) return { ok: false, error: friendly(error.message) }
  }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

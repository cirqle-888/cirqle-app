'use server'

/**
 * Payroll server actions — all financial mutations go through here.
 *
 * Every function enforces permission via src/lib/auth/enforce.ts before
 * touching the database. The anon client RLS is wide-open, so this
 * server-layer check is the authoritative gate.
 *
 * Permission requirements:
 *   payroll.edit      → create/delete payroll records, advances, credits
 *   payroll.mark_paid → mark paid / revert to pending (workflow transition)
 *   payroll.edit      → toggle reveal_salary
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/auth/enforce'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'

const REVALIDATE = '/dashboard/payroll'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

// ─── Refresh Payroll ──────────────────────────────────────────────────────────

export interface RefreshPayrollInput {
  id: string
  newCommission: number
  newNetSalary: number
}

export async function refreshPayrollRecord(
  input: RefreshPayrollInput,
): Promise<ActionResult<{ row: any }>> {
  const guard = await requirePermission(PERMS.PAYROLL_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()

  // Fetch the existing record (with employee for the audit log).
  const { data: record, error: fetchErr } = await admin
    .from('payroll')
    .select('*, employee:employees(id, cqid, name)')
    .eq('id', input.id)
    .single()

  if (fetchErr || !record) return { ok: false, error: fetchErr?.message || 'Payroll record not found' }
  // Paid records are immutable — never refresh them.
  if (record.status === 'paid') return { ok: false, error: 'Cannot refresh a paid payroll record' }

  const oldComm = record.commission_earned || 0
  const oldNet  = record.net_salary || 0

  // Tolerance check — ignore sub-rupee float noise so we don't write a no-op.
  if (Math.round(oldComm) === Math.round(input.newCommission) &&
      Math.round(oldNet)  === Math.round(input.newNetSalary)) {
    return { ok: true, data: { row: record } } // Already in sync
  }

  const { data, error } = await admin
    .from('payroll')
    .update({
      commission_earned: input.newCommission,
      net_salary:        input.newNetSalary,
    })
    .eq('id', input.id)
    .select('*, employee:employees(id, cqid, name)')
    .single()

  if (error) return { ok: false, error: error.message }

  // Audit via the activity log (NOT the user-editable notes field).
  void logActivity({
    actorId:    guard.employeeId,
    subjectId:  record.employee_id,
    entityType: 'payroll',
    entityId:   input.id,
    action:     'payroll_refreshed',
    detail: {
      cqid:           record.employee?.cqid ?? null,
      month:          record.month,
      year:           record.year,
      prevCommission: oldComm,
      newCommission:  input.newCommission,
      prevNet:        oldNet,
      newNet:         input.newNetSalary,
    },
  })

  revalidatePath(REVALIDATE)
  return { ok: true, data: { row: data } }
}

// ─── Auto-Recalculate Payroll for Month ──────────────────────────────────────

export interface RecalculateMonthInput {
  month: number
  year: number
  source?: 'task_edit' | 'contribution_edit' | 'csv_contribution_import' | 'csv_task_import' | 'manual_refresh'
}

export async function recalculatePayrollForMonth(
  input: RecalculateMonthInput,
): Promise<ActionResult<{ updated: number; updates: any[] }>> {
  const guard = await requirePermission(PERMS.PAYROLL_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()

  // Month window: [monthStart, nextMonthStart)
  const monthStr = `${input.year}-${String(input.month).padStart(2, '0')}`
  const nextMonth = input.month === 12 ? 1 : input.month + 1
  const nextYear = input.month === 12 ? input.year + 1 : input.year
  const nextMonthStr = `${nextYear}-${String(nextMonth).padStart(2, '0')}`
  const monthStart = `${monthStr}-01`
  const nextMonthStart = `${nextMonthStr}-01`

  // Commission per employee for this month — computed the SAME way the payroll
  // client does it (group scores by the linked task's month). NOTE: a PostgREST
  // filter on an embedded resource (.gte('task.task_date', …)) does NOT filter
  // the parent contribution_scores rows, so we resolve the month's task ids
  // first and filter scores by task_id. Scores with no task fall back to their
  // calculated_at month (mirrors the client's monthCommissions logic).
  const commissionByEmployee: Record<string, number> = {}

  // 1) Task-linked scores: find this month's task ids, then sum their scores.
  const { data: monthTasks, error: tasksErr } = await admin
    .from('tasks')
    .select('id')
    .gte('task_date', monthStart)
    .lt('task_date', nextMonthStart)
    .is('deleted_at', null)
  if (tasksErr) return { ok: false, error: tasksErr.message }

  const taskIds = (monthTasks ?? []).map((t: any) => t.id)
  if (taskIds.length > 0) {
    // Chunk the id list to stay well under URL-length limits.
    const CHUNK = 200
    for (let i = 0; i < taskIds.length; i += CHUNK) {
      const chunk = taskIds.slice(i, i + CHUNK)
      const { data: scores, error: scoresErr } = await admin
        .from('contribution_scores')
        .select('employee_id, earnings_inr')
        .in('task_id', chunk)
      if (scoresErr) return { ok: false, error: scoresErr.message }
      scores?.forEach((s: any) => {
        commissionByEmployee[s.employee_id] =
          (commissionByEmployee[s.employee_id] || 0) + (s.earnings_inr || 0)
      })
    }
  }

  // 2) Orphan scores (no task_id, e.g. earnings-only CSV imports): bucket them
  //    into the month by calculated_at, matching the client's fallback.
  const { data: orphanScores, error: orphanErr } = await admin
    .from('contribution_scores')
    .select('employee_id, earnings_inr, calculated_at')
    .is('task_id', null)
    .gte('calculated_at', monthStart)
    .lt('calculated_at', nextMonthStart)
  if (orphanErr) return { ok: false, error: orphanErr.message }
  orphanScores?.forEach((s: any) => {
    commissionByEmployee[s.employee_id] =
      (commissionByEmployee[s.employee_id] || 0) + (s.earnings_inr || 0)
  })

  // Get all pending payroll for this month with employee info
  const { data: payroll, error: payrollErr } = await admin
    .from('payroll')
    .select('id, employee_id, base_salary, commission_earned, advances_deducted, other_deductions, employee:employees(id, cqid)')
    .eq('month', input.month)
    .eq('year', input.year)
    .eq('status', 'pending')

  if (payrollErr) return { ok: false, error: payrollErr.message }
  if (!payroll || payroll.length === 0) {
    return { ok: true, data: { updated: 0, updates: [] } }
  }

  // Track all updates for logging
  const updates: any[] = []

  // Update each pending payroll record with recalculated commission
  let updated = 0
  for (const record of payroll) {
    // Round commission to the rupee — IDENTICAL to the payroll client's
    // monthCommissions (Math.round) so auto-sync and the manual per-record
    // refresh produce the same stored value (no flip-flopping).
    const newCommission = Math.round(commissionByEmployee[record.employee_id] || 0)
    const oldCommission = record.commission_earned || 0

    // Skip if commission is unchanged (≥ ₹1 difference required to write).
    if (Math.round(oldCommission) === newCommission) continue

    // Net salary clamped to ≥ 0 — matches the payroll client's handleRefreshPayroll.
    const baseMinusDeductions =
      (record.base_salary || 0) -
      (record.advances_deducted || 0) -
      (record.other_deductions || 0)
    const oldNetSalary = Math.max(0, baseMinusDeductions + oldCommission)
    const newNetSalary = Math.max(0, baseMinusDeductions + newCommission)

    const { error: updateErr } = await admin
      .from('payroll')
      .update({
        commission_earned: newCommission,
        net_salary: newNetSalary,
      })
      .eq('id', record.id)

    if (!updateErr) {
      updated++
      updates.push({
        payrollId: record.id,
        employeeId: record.employee_id,
        cqid: record.employee?.cqid,
        oldCommission,
        newCommission,
        oldNetSalary,
        newNetSalary,
        commissionDiff: newCommission - oldCommission,
        netSalaryDiff: newNetSalary - oldNetSalary,
      })
    }
  }

  // Log activity with detailed changes
  if (updated > 0) {
    void logActivity({
      actorId:    guard.employeeId,
      entityType: 'payroll',
      action:     'auto_recalculated',
      detail: {
        month: input.month,
        year: input.year,
        recordsUpdated: updated,
        source: input.source || 'unknown',
        changes: updates,
      },
    })
  }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { updated, updates } }
}

// ─── Batch Recalculate Payroll for Multiple Months ────────────────────────────

export interface RecalculateMonthsInput {
  months: { month: number; year: number }[]
  source?: RecalculateMonthInput['source']
}

export async function recalculatePayrollForMonths(
  input: RecalculateMonthsInput,
): Promise<ActionResult<{ totalUpdated: number; monthResults: any[] }>> {
  const guard = await requirePermission(PERMS.PAYROLL_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const monthResults: any[] = []
  let totalUpdated = 0

  // Deduplicate months — so importing many tasks from the same month only
  // recalculates that month's payroll ONCE (requirement #5).
  const uniqueMonths = Array.from(
    new Map(input.months.map(m => [`${m.year}-${m.month}`, m])).values()
  )

  for (const monthInput of uniqueMonths) {
    const result = await recalculatePayrollForMonth({
      ...monthInput,
      source: input.source,
    })
    if (result.ok && result.data) {
      totalUpdated += result.data.updated
      monthResults.push({
        month: monthInput.month,
        year: monthInput.year,
        updated: result.data.updated,
        updates: result.data.updates,
      })
    }
  }

  return { ok: true, data: { totalUpdated, monthResults } }
}

// ─── Bulk Generate ────────────────────────────────────────────────────────────

export interface PayrollInsertRow {
  employee_id: string
  month: number
  year: number
  base_salary: number
  commission_earned: number
  advances_deducted: number
  other_deductions: number
  net_salary: number
  status: 'pending'
}

export async function bulkGeneratePayroll(
  records: PayrollInsertRow[],
): Promise<ActionResult<{ rows: any[] }>> {
  const guard = await requirePermission(PERMS.PAYROLL_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!records.length) return { ok: false, error: 'No records to generate.' }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('payroll')
    .insert(records)
    .select('*, employee:employees(id, cqid, name)')
  if (error) return { ok: false, error: error.message }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { rows: data ?? [] } }
}

// ─── Single Payroll Record ────────────────────────────────────────────────────

export interface PayrollFormInput {
  employee_id: string
  month: number
  year: number
  base_salary: number
  commission_earned: number
  advances_deducted: number
  other_deductions: number
  net_salary: number
}

export async function createPayrollRecord(
  input: PayrollFormInput,
): Promise<ActionResult<{ row: any }>> {
  const guard = await requirePermission(PERMS.PAYROLL_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('payroll')
    .insert({ ...input, status: 'pending' })
    .select('*, employee:employees(id, cqid, name)')
    .single()
  if (error) return { ok: false, error: error.message }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { row: data } }
}

// ─── Mark Paid ────────────────────────────────────────────────────────────────

export interface MarkPaidInput {
  id: string
  employeeId: string
  employeeCqid: string
  month: number
  year: number
  finalNet: number
  liveCommission: number
  salaryCategory: string
}

export async function markPayrollPaid(
  input: MarkPaidInput,
): Promise<ActionResult<{ updates: Record<string, unknown> }>> {
  const guard = await requirePermission(PERMS.PAYROLL_MARK_PAID)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const today = new Date().toISOString().split('T')[0]

  const updates: Record<string, unknown> = { status: 'paid', paid_date: today }
  if (input.liveCommission > 0) {
    updates.commission_earned = input.liveCommission
    updates.net_salary = input.finalNet
  }

  const { error: updateErr } = await admin
    .from('payroll')
    .update(updates)
    .eq('id', input.id)
  if (updateErr) return { ok: false, error: updateErr.message }

  // Log: payroll marked paid (fire-and-forget)
  void logActivity({
    actorId:    guard.employeeId,
    subjectId:  input.employeeId,
    entityType: 'payroll',
    entityId:   input.id,
    action:     'marked_paid',
    detail:     { month: input.month, year: input.year, net: input.finalNet, cqid: input.employeeCqid },
  })

  // Auto-create Cash Book outflow entry
  if (input.finalNet > 0) {
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
    const monthName = MONTHS[input.month - 1]
    await admin.from('cashbook_entries').insert({
      entry_date:  today,
      type:        'outflow',
      category_id: input.salaryCategory,
      employee_id: input.employeeId,
      description: `Salary — ${input.employeeCqid} — ${monthName} ${input.year}`,
      amount:      input.finalNet,
      amount_inr:  input.finalNet,
      currency:    'INR',
      reference:   `payroll:${input.id}`,
    })
  }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { updates } }
}

// ─── Mark Unpaid ─────────────────────────────────────────────────────────────

export async function markPayrollUnpaid(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PAYROLL_MARK_PAID)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { error } = await admin
    .from('payroll')
    .update({ status: 'pending', paid_date: null })
    .eq('id', id)
  if (error) return { ok: false, error: error.message }

  await admin.from('cashbook_entries').delete().eq('reference', `payroll:${id}`)

  // Log: payroll reverted to unpaid (fire-and-forget)
  void logActivity({
    actorId:    guard.employeeId,
    entityType: 'payroll',
    entityId:   id,
    action:     'edited',
    detail:     { status_change: 'paid → pending' },
  })

  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ─── Toggle Reveal Salary ─────────────────────────────────────────────────────

export async function toggleRevealSalary(
  empId: string,
  current: boolean,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PAYROLL_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { error } = await admin
    .from('employees')
    .update({ reveal_salary: !current })
    .eq('id', empId)
  if (error) return { ok: false, error: error.message }

  return { ok: true }
}

// ─── Salary Advance ───────────────────────────────────────────────────────────

export interface AdvanceInput {
  employee_id: string
  amount: number
  advance_date: string
  reason: string
  repayment_type: string
}

export async function createSalaryAdvance(
  input: AdvanceInput,
): Promise<ActionResult<{ row: any }>> {
  const guard = await requirePermission(PERMS.PAYROLL_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('salary_advances')
    .insert({ ...input, status: 'pending' })
    .select('*, employee:employees(id, cqid)')
    .single()
  if (error) return { ok: false, error: error.message }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { row: data } }
}

// ─── Credit Ledger ────────────────────────────────────────────────────────────

export interface CreditInput {
  entity_type: string
  entity_id: string
  credit_type: string
  amount: number
  credit_date: string
  notes: string
}

export async function createCreditEntry(
  input: CreditInput,
): Promise<ActionResult<{ row: any }>> {
  const guard = await requirePermission(PERMS.PAYROLL_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('credit_ledger')
    .insert(input)
    .select('*, employee:employees(id, cqid)')
    .single()
  if (error) return { ok: false, error: error.message }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { row: data } }
}

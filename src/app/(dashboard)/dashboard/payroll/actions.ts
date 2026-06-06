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
  
  // Fetch existing record
  const { data: record, error: fetchErr } = await admin
    .from('payroll')
    .select('*')
    .eq('id', input.id)
    .single()
    
  if (fetchErr || !record) return { ok: false, error: fetchErr?.message || 'Not found' }
  if (record.status === 'paid') return { ok: false, error: 'Cannot refresh a paid payroll record' }

  // Check if anything actually changed
  if (record.commission_earned === input.newCommission && record.net_salary === input.newNetSalary) {
    return { ok: true, data: { row: record } } // Nothing to do
  }

  const oldComm = record.commission_earned || 0
  const oldNet = record.net_salary || 0

  const nowStr = new Date().toISOString()
  const auditNote = `[System ${nowStr.slice(0,19).replace('T', ' ')}]: Refreshed payroll. Commission: ${oldComm} -> ${input.newCommission}. Net Salary: ${oldNet} -> ${input.newNetSalary}.`
  
  const newNotes = record.notes ? `${record.notes}\n${auditNote}` : auditNote

  const { data, error } = await admin
    .from('payroll')
    .update({ 
      commission_earned: input.newCommission, 
      net_salary: input.newNetSalary,
      notes: newNotes
    })
    .eq('id', input.id)
    .select('*, employee:employees(id, cqid, name)')
    .single()

  if (error) return { ok: false, error: error.message }

  // Log activity
  void logActivity({
    actorId: guard.employeeId,
    entityType: 'payroll',
    entityId: input.id,
    action: 'edited',
    detail: { refresh: true, old_net: oldNet, new_net: input.newNetSalary }
  })

  revalidatePath(REVALIDATE)
  return { ok: true, data: { row: data } }
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

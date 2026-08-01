'use server'

/**
 * Employee Commission Agreements — CRUD + scoped recompute.
 *
 * Gated on `employees.manage_agreements`. After any change we recompute the
 * AFFECTED tasks so earnings/payroll reflect it — scoped per the owner-approved
 * rule: current + previous month auto (covers pending payroll); paid payroll is
 * never touched (the payroll recompute is pending-only); older history needs the
 * manual "Recalculate history" action.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { recalcTaskCommissions } from '@/lib/sync/integrity'
import { recalculatePayrollForMonth } from '@/app/(dashboard)/dashboard/payroll/actions'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

export interface AgreementInput {
  id?: string
  employee_id: string
  client_id: string | null
  service_id: string | null
  agreement_type: 'fixed_per_task' | 'percentage_of_billing' | 'percentage_of_pool'
  agreement_value: number
  effective_from: string
  effective_to?: string | null
  is_active?: boolean
  notes?: string | null
}

const PERM = PERMS.EMPLOYEES_MANAGE_AGREEMENTS

// ─── List ───────────────────────────────────────────────────────────────────

export async function listEmployeeAgreements(employeeId: string): Promise<ActionResult<{ rows: any[] }>> {
  const guard = await requirePermission(PERM)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('employee_commission_agreements')
    .select('*')
    .eq('employee_id', employeeId)
    .order('created_at', { ascending: false })
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: { rows: data ?? [] } }
}

// ─── Create / Update ──────────────────────────────────────────────────────────

export async function saveAgreement(input: AgreementInput): Promise<ActionResult<{ row: any }>> {
  const guard = await requirePermission(PERM)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!input.employee_id) return { ok: false, error: 'Employee is required.' }
  if (!(input.agreement_value >= 0)) return { ok: false, error: 'Agreement value must be ≥ 0.' }

  const admin = createAdminClient()
  const payload = {
    employee_id: input.employee_id,
    client_id: input.client_id || null,
    service_id: input.service_id || null,
    agreement_type: input.agreement_type,
    agreement_value: input.agreement_value,
    effective_from: input.effective_from,
    effective_to: input.effective_to || null,
    is_active: input.is_active ?? true,
    notes: input.notes || null,
    updated_at: new Date().toISOString(),
  }

  let row: any
  if (input.id) {
    const { data, error } = await admin.from('employee_commission_agreements').update(payload).eq('id', input.id).select().single()
    if (error) return { ok: false, error: error.message }
    row = data
  } else {
    const { data, error } = await admin.from('employee_commission_agreements')
      .insert({ ...payload, created_by: guard.employeeId }).select().single()
    if (error) return { ok: false, error: error.message }
    row = data
  }

  await recomputeAffected(admin, input.employee_id, input.client_id || null, input.service_id || null)
  revalidatePath('/dashboard/reports/contribution-analysis')
  return { ok: true, data: { row } }
}

// ─── Toggle active ──────────────────────────────────────────────────────────

export async function toggleAgreement(id: string, isActive: boolean): Promise<ActionResult> {
  const guard = await requirePermission(PERM)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('employee_commission_agreements')
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq('id', id).select('employee_id, client_id, service_id').single()
  if (error) return { ok: false, error: error.message }
  await recomputeAffected(admin, data.employee_id, data.client_id, data.service_id)
  return { ok: true }
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteAgreement(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERM)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { data: existing } = await admin
    .from('employee_commission_agreements').select('employee_id, client_id, service_id').eq('id', id).single()
  const { error } = await admin.from('employee_commission_agreements').delete().eq('id', id)
  if (error) return { ok: false, error: error.message }
  if (existing) await recomputeAffected(admin, existing.employee_id, existing.client_id, existing.service_id)
  return { ok: true }
}

// ─── Manual full-history recompute ────────────────────────────────────────────

export async function recomputeAgreementHistory(employeeId: string): Promise<ActionResult<{ tasks: number }>> {
  const guard = await requirePermission(PERM)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const n = await recomputeAffected(admin, employeeId, null, null, /* allHistory */ true)
  return { ok: true, data: { tasks: n } }
}

// ─── Internal: recompute affected tasks (base recalc + agreement sync) ─────────

async function recomputeAffected(
  admin: ReturnType<typeof createAdminClient>,
  employeeId: string,
  clientId: string | null,
  serviceId: string | null,
  allHistory = false,
): Promise<number> {
  // Window: current + previous month (auto) unless full history requested.
  const now = new Date()
  const fromDate = allHistory
    ? '2000-01-01'
    : new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10)

  // Tasks the employee has a contribution score on, within the window, matching
  // the agreement scope (null = any).
  const { data: scoreRows } = await admin
    .from('contribution_scores')
    .select('task_id, task:tasks(id, client_id, service_id, task_date, deleted_at)')
    .eq('employee_id', employeeId)
    .gt('score_percentage', 0)
  const taskIds = new Set<string>()
  const months = new Set<string>()
  for (const r of (scoreRows ?? []) as any[]) {
    const t = r.task
    if (!t || t.deleted_at) continue
    if ((t.task_date || '') < fromDate) continue
    if (clientId && t.client_id !== clientId) continue
    if (serviceId && t.service_id !== serviceId) continue
    taskIds.add(t.id)
    if (t.task_date) months.add(t.task_date.slice(0, 7)) // YYYY-MM
  }

  // Recompute each affected task (recalc base → applies agreement sync at end).
  for (const id of taskIds) {
    try { await recalcTaskCommissions(id) } catch { /* best-effort */ }
  }

  // Refresh pending payroll for the affected months (paid stays immutable).
  for (const m of months) {
    const [y, mo] = m.split('-').map(Number)
    void recalculatePayrollForMonth({ month: mo, year: y, source: 'task_edit' }).catch(() => {})
  }

  return taskIds.size
}

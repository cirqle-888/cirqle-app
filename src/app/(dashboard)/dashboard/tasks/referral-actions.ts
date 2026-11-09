'use server'

/**
 * Referral commission on a job — "this work came through <staff>, pay them X%".
 *
 * The job carries the referral (tasks.referred_by + tasks.referral_percent);
 * the built-in "Referral commission" ownership program pays it into the
 * payslip of the month the job is dated. See the migration
 * 20261110100000_task_referral_commission.sql and work-measures.ts
 * attributeReferrals.
 *
 * Gated on `payroll.manage_ownership`: a referral is pay, and setting one is
 * deciding someone's earnings. Admins hold every key, so they pass too.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission, requireReadPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import { isMonthFinalized } from '@/lib/payroll/compute'
import { syncPendingPayrollOwnership } from '@/lib/ownership/engine'
import { validateReferral } from '@/lib/ownership/referral'

type Result<T = void> = { ok: true; data: T } | { ok: false; error: string }

export interface TaskReferral {
  /** False before the migration — the editor hides the section entirely. */
  available: boolean
  referredBy: string | null
  percent: number | null
  /** CQIDs only: employee names are private by design (see Settings → Ownership). */
  employees: { id: string; cqid: string }[]
  /** The job's month is paid or locked — the referral is shown but not editable. */
  locked: boolean
}

const monthOf = (date: string | null) => {
  if (!date) return null
  const [y, m] = date.slice(0, 10).split('-').map(Number)
  return y && m ? { month: m, year: y } : null
}

export async function getTaskReferral(taskId: string): Promise<Result<TaskReferral>> {
  const guard = await requireReadPermission(PERMS.PAYROLL_MANAGE_OWNERSHIP)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()

  const [{ data: task, error }, { data: emps }] = await Promise.all([
    admin.from('tasks').select('referred_by, referral_percent, task_date').eq('id', taskId).maybeSingle(),
    admin.from('employees').select('id, cqid').eq('is_active', true).order('cqid'),
  ])
  // A missing column means the migration has not run: hide, don't fail.
  if (error) return { ok: true, data: { available: false, referredBy: null, percent: null, employees: [], locked: false } }

  const t = task as { referred_by: string | null; referral_percent: number | string | null; task_date: string | null } | null
  const when = monthOf(t?.task_date ?? null)
  return {
    ok: true,
    data: {
      available: true,
      referredBy: t?.referred_by ?? null,
      percent: t?.referral_percent == null ? null : Number(t.referral_percent),
      employees: (emps ?? []) as { id: string; cqid: string }[],
      locked: when ? await isMonthFinalized(admin, when.month, when.year) : false,
    },
  }
}

/**
 * Set or clear a job's referral. `employeeId: null` clears it.
 *
 * Refused for a month that is paid or locked: the award there is frozen, so a
 * change would look saved and pay nothing — worse than saying no.
 */
export async function setTaskReferral(
  taskId: string,
  employeeId: string | null,
  percent: number | null,
): Promise<Result> {
  const guard = await requirePermission(PERMS.PAYROLL_MANAGE_OWNERSHIP)
  if (!guard.ok) return { ok: false, error: guard.error }

  const checked = validateReferral(employeeId, percent)
  if (!checked.ok) return { ok: false, error: checked.error }

  const admin = createAdminClient()
  const { data: task } = await admin.from('tasks')
    .select('task_number, task_date, referred_by, referral_percent').eq('id', taskId).maybeSingle()
  if (!task) return { ok: false, error: 'Task not found.' }
  const t = task as { task_number: number | null; task_date: string | null }

  const when = monthOf(t.task_date)
  if (when && await isMonthFinalized(admin, when.month, when.year)) {
    return { ok: false, error: `Payroll for ${when.month}/${when.year} is already paid or locked, so this job's referral can no longer change.` }
  }

  if (checked.employeeId) {
    const { data: emp } = await admin.from('employees').select('id').eq('id', checked.employeeId).eq('is_active', true).maybeSingle()
    if (!emp) return { ok: false, error: 'That staff member is not active.' }
  }

  const { error } = await admin.from('tasks')
    .update({ referred_by: checked.employeeId, referral_percent: checked.percent })
    .eq('id', taskId)
  if (error) {
    return { ok: false, error: /referred_by|referral_percent/.test(error.message)
      ? 'Referral commission needs its database migration first (20261110100000_task_referral_commission).'
      : error.message }
  }

  void logActivity({
    actorId: guard.employeeId,
    entityType: 'task',
    entityId: taskId,
    action: 'updated',
    detail: {
      title: `#${t.task_number ?? ''}`,
      referral: checked.employeeId ? { employeeId: checked.employeeId, percent: checked.percent } : null,
    },
  })

  // Bring that month's PENDING payslips in line now, so the commission shows
  // up without anyone pressing "Run now". Paid payslips are never touched.
  if (when) {
    try { await syncPendingPayrollOwnership(admin, when.month, when.year) } catch { /* next payroll run catches up */ }
  }
  return { ok: true, data: undefined }
}

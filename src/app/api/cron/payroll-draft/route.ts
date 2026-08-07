import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { computeMonthlyCommissions } from '@/lib/payroll/compute'
import { pendingAdjustmentTotals } from '@/lib/payroll/adjustments'
import { computeMonthlyOwnership } from '@/lib/ownership/engine'
import { notifyAdmins } from '@/lib/notifications/create'
import { logCronRun } from '@/lib/cron/log'

/**
 * Monthly payroll auto-draft cron.
 *
 * Turns "open Payroll, click Bulk Generate, confirm" into "review what's
 * already drafted" — runs on the 1st of the month for the just-completed
 * PREVIOUS month (so every contribution score for that month is final).
 *
 * Drafts every active employee who is owed ANYTHING for the month — task
 * commission, a fixed base salary, or a prior-period adjustment. (It used to
 * require commission > 0, which meant support staff on a fixed salary and no
 * task contributions were never drafted at all.) Employees owed nothing are
 * still skipped, so no empty rows need manual cleanup.
 *
 * Skips anyone who already has a payroll row for that month/year (idempotent —
 * also backstopped by the table's UNIQUE(employee_id, month, year)).
 * Drafted rows land as status='pending', identical in shape to what the
 * bulk-generate modal inserts — fully editable, reviewable, deletable by staff
 * before being marked paid. Never touches existing or paid records.
 *
 *   GET /api/cron/payroll-draft
 *
 * Auth: same shared-secret pattern as /api/cron/cleanup-product-images.
 * Schedule on the 1st of each month in vercel.json.
 */

function authorized(req: NextRequest): boolean {
  const token = process.env.CRON_SECRET
  if (!token) return false // fail closed — never run unauthenticated
  const header = req.headers.get('authorization') || ''
  return header === `Bearer ${token}`
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()

  // Previous calendar month (1-indexed), wrapping the year at January.
  const now = new Date()
  const month = now.getMonth() === 0 ? 12 : now.getMonth()
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()

  const commissionRes = await computeMonthlyCommissions(admin, month, year)
  if (!commissionRes.ok) {
    await logCronRun(admin, 'payroll-draft', false, { month, year }, commissionRes.error)
    return NextResponse.json({ ok: false, error: commissionRes.error }, { status: 500 })
  }
  const { commissionByEmployee } = commissionRes

  const [employeesRes, existingRes] = await Promise.all([
    admin.from('employees').select('id, base_salary').eq('is_active', true),
    admin.from('payroll').select('employee_id').eq('month', month).eq('year', year),
  ])
  if (employeesRes.error) {
    await logCronRun(admin, 'payroll-draft', false, { month, year }, employeesRes.error.message)
    return NextResponse.json({ ok: false, error: employeesRes.error.message }, { status: 500 })
  }
  if (existingRes.error) {
    await logCronRun(admin, 'payroll-draft', false, { month, year }, existingRes.error.message)
    return NextResponse.json({ ok: false, error: existingRes.error.message }, { status: 500 })
  }

  const existingIds = new Set((existingRes.data || []).map((r: any) => r.employee_id))

  // Corrections owed for already-closed months ride along in this draft. Never
  // blocks the draft: a missing table (pre-migration) or a read failure simply
  // means no adjustments this run.
  const adjustmentByEmployee = await pendingAdjustmentTotals(admin).catch(() => ({} as Record<string, number>))

  // Ownership rewards earned for the month. Never blocks the draft — an
  // uncomputable month simply drafts without them and a later recalc fills
  // them in.
  const ownershipByEmployee = (await computeMonthlyOwnership(admin, month, year).catch(() => null)) ?? {}

  const rows = (employeesRes.data || [])
    .filter((e: any) => !existingIds.has(e.id))
    .map((e: any) => ({
      employee: e,
      commission: Math.round(commissionByEmployee[e.id] || 0),
      adjustment: Math.round(adjustmentByEmployee[e.id] || 0),
      ownership: Math.round(ownershipByEmployee[e.id] || 0),
      baseSalary: Number(e.base_salary) || 0,
    }))
    // Draft anyone with ANY component. The old `commission > 0` test silently
    // excluded support staff paid a fixed salary and no task commission — they
    // never appeared in payroll at all.
    .filter(({ commission, adjustment, ownership, baseSalary }) =>
      commission > 0 || adjustment !== 0 || ownership > 0 || baseSalary > 0)
    .map(({ employee, commission, adjustment, ownership, baseSalary }) => ({
      employee_id: employee.id,
      month,
      year,
      base_salary: baseSalary,
      commission_earned: commission,
      adjustment_earned: adjustment,
      ownership_earned: ownership,
      advances_deducted: 0,
      other_deductions: 0,
      net_salary: Math.max(0, baseSalary + commission + adjustment + ownership),
      status: 'pending' as const,
    }))

  if (rows.length === 0) {
    await logCronRun(admin, 'payroll-draft', true, { month, year, drafted: 0 })
    return NextResponse.json({ ok: true, month, year, drafted: 0 })
  }

  const { data: inserted, error: insertErr } = await admin.from('payroll').insert(rows).select('id')
  if (insertErr) {
    await logCronRun(admin, 'payroll-draft', false, { month, year }, insertErr.message)
    return NextResponse.json({ ok: false, error: insertErr.message }, { status: 500 })
  }

  const count = inserted?.length || 0
  void notifyAdmins({
    type: 'payroll_draft_created',
    title: `Payroll drafted for ${count} employee${count === 1 ? '' : 's'} — ${month}/${year}`,
    message: 'Review and mark paid in HR & Payroll.',
    link: '/dashboard/payroll',
    sourceKey: `payroll_draft:${year}-${String(month).padStart(2, '0')}`,
  })

  await logCronRun(admin, 'payroll-draft', true, { month, year, drafted: count })
  return NextResponse.json({ ok: true, month, year, drafted: count })
}

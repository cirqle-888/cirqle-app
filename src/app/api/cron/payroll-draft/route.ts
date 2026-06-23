import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { computeMonthlyCommissions } from '@/lib/payroll/compute'
import { notifyAdmins } from '@/lib/notifications/create'
import { logCronRun } from '@/lib/cron/log'

/**
 * Monthly payroll auto-draft cron.
 *
 * Turns "open Payroll, click Bulk Generate, confirm" into "review what's
 * already drafted" — runs on the 1st of the month for the just-completed
 * PREVIOUS month (so every contribution score for that month is final).
 *
 * Mirrors the existing manual bulk-generate-modal's "only employees with
 * earnings" mode exactly: skips any active employee whose commission for the
 * month is 0 (no drafting empty rows that need manual cleanup), and skips
 * anyone who already has a payroll row for that month/year (idempotent —
 * also backstopped by the table's UNIQUE(employee_id, month, year)).
 * Drafted rows land as status='pending', identical in shape to what the
 * modal itself inserts — fully editable, reviewable, deletable by staff
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

  const rows = (employeesRes.data || [])
    .filter((e: any) => !existingIds.has(e.id))
    .map((e: any) => {
      const commission = Math.round(commissionByEmployee[e.id] || 0)
      return { employee: e, commission }
    })
    .filter(({ commission }) => commission > 0) // "only employees with activity"
    .map(({ employee, commission }) => ({
      employee_id: employee.id,
      month,
      year,
      base_salary: employee.base_salary || 0,
      commission_earned: commission,
      advances_deducted: 0,
      other_deductions: 0,
      net_salary: Math.max(0, (employee.base_salary || 0) + commission),
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

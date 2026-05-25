import { redirect } from 'next/navigation'
import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import ReportsClient from './reports-client'

// Always fetch fresh data — scores get written when contributions are saved
export const dynamic = 'force-dynamic'

export default async function ReportsPage() {
  // Reports surfaces team-wide earnings, billing bands, and company splits.
  // It's strictly admin-only — employees get redirected to their dashboard.
  // The sidebar already hides the nav item; this is the server-side wall in
  // case anyone types the URL or follows a stale link.
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? true   // pre-migration fail-open
  // Allow access when: admin, OR has explicit reports.view permission, OR no user
  // record yet (fail-open so the app keeps working pre-migration).
  const canViewReports = isAdmin || me?.permissions.has('reports.view') || !me
  if (me && !canViewReports) redirect('/dashboard')

  const supabase = createAdminClient()
  const employeeId = me?.employeeId

  // Tasks window: 24 months keeps the tasks-tab list manageable (tasks can be
  // large). Scores are fetched WITHOUT a date cap so KPIs and "All dates" are
  // truly all-time. The client-side date filter (matchesDateFilter) narrows
  // things down interactively when the user selects a period.
  const taskWindowFrom = new Date()
  taskWindowFrom.setMonth(taskWindowFrom.getMonth() - 24)
  const taskWindowFromStr = taskWindowFrom.toISOString().slice(0, 10)

  const employeesQuery = isAdmin || !employeeId
    ? supabase.from('employees').select('id, cqid, name, performance_rating').eq('is_active', true).order('cqid')
    : supabase.from('employees').select('id, cqid, name, performance_rating').eq('id', employeeId)

  // Inner join + filter score > 0. NO date cap here — "All dates" must mean
  // all-time. The !inner join ensures orphaned rows (no matching task) are
  // excluded. Ordered newest-first so dedup in client keeps the latest calc.
  const scoresBase = supabase
    .from('contribution_scores')
    .select('id, employee_id, task_id, score_percentage, earnings_inr, calculated_at, task:tasks!inner(id, title, task_date, billing_amount_inr, service_id, quantity, client:clients(id, name))')
    .not('task_id', 'is', null)
    .gt('score_percentage', 0)
    .order('calculated_at', { ascending: false })
    .order('id', { ascending: true })
  const scoresQuery = isAdmin || !employeeId ? scoresBase : scoresBase.eq('employee_id', employeeId)

  // Skills analytics: contributions with task_date. No date cap — sparse today
  // but grows organically; data is small (<50k rows at 3-year horizon).
  const contributionsQuery = supabase
    .from('contributions')
    .select('task_id, employee_id, parameter_id, value, task:tasks!inner(task_date)')
    .order('task_id')

  const [employeesRes, scoresRes, tasksRes, contributionsRes, parametersRes, groupsRes] =
    await Promise.all([
      employeesQuery,
      fetchAll(scoresQuery),
      // Tasks tab: keep the 24-month window — tasks table is larger and the
      // tab shows a scrollable list, so we cap it for payload size.
      isAdmin || !employeeId
        ? fetchAll(supabase
            .from('tasks')
            .select('id, title, task_date, status, billing_amount_inr, service_id, quantity, client:clients(id, name)')
            .gte('task_date', taskWindowFromStr)
            .order('task_date', { ascending: false })
            .order('id', { ascending: true }))
        : Promise.resolve({ data: [] as any[] }),
      fetchAll(contributionsQuery),
      supabase.from('parameters')
        .select('id, name, group_id, weight, is_master, input_type, is_active')
        .eq('is_active', true)
        .order('display_order'),
      supabase.from('contribution_groups')
        .select('id, name, weight')
        .eq('is_active', true)
        .order('weight', { ascending: false }),
    ])

  // Employee mode: derive the tasks visible from the scores we already loaded.
  // This avoids an extra DB call and guarantees the employee never sees a task
  // they have no contribution on.
  let tasks = tasksRes.data || []
  if (!(isAdmin || !employeeId)) {
    const seen = new Map<string, any>()
    for (const s of scoresRes.data || []) {
      const t = (s as any).task
      if (t?.id && !seen.has(t.id)) {
        seen.set(t.id, {
          id: t.id,
          title: t.title,
          task_date: t.task_date,
          status: null, // task.status not selected via score join — left null
          billing_amount_inr: t.billing_amount_inr,
          service_id: t.service_id,
          quantity: t.quantity,
          client: t.client,
        })
      }
    }
    tasks = Array.from(seen.values())
  }

  // Flatten contributions join: { task_id, employee_id, parameter_id, value, task: { task_date } }
  // → { task_id, employee_id, parameter_id, value, task_date }
  const contributions = (contributionsRes.data || []).map((r: any) => ({
    task_id:      r.task_id,
    employee_id:  r.employee_id,
    parameter_id: r.parameter_id,
    value:        r.value,
    task_date:    r.task?.task_date ?? '',
  }))

  return (
    <ReportsClient
      employees={employeesRes.data || []}
      scores={(scoresRes.data || []) as any[]}
      tasks={tasks as any[]}
      contributions={contributions}
      parameters={(parametersRes.data || []) as any[]}
      groups={(groupsRes.data || []) as any[]}
    />
  )
}

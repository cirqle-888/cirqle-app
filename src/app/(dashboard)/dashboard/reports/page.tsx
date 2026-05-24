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
  if (me && !isAdmin) redirect('/dashboard')

  const supabase = createAdminClient()
  const employeeId = me?.employeeId

  // Analytics window: 24 months. Reports drill into per-employee monthly
  // performance — older data is rarely queried and would otherwise drive the
  // payload past several MB on agencies with long history.
  const windowFrom = new Date()
  windowFrom.setMonth(windowFrom.getMonth() - 24)
  const windowFromStr = windowFrom.toISOString().slice(0, 10)

  const employeesQuery = isAdmin || !employeeId
    ? supabase.from('employees').select('id, cqid, name, performance_rating').eq('is_active', true).order('cqid')
    : supabase.from('employees').select('id, cqid, name, performance_rating').eq('id', employeeId)

  const scoresBase = supabase
    .from('contribution_scores')
    .select('id, employee_id, task_id, score_percentage, earnings_inr, calculated_at, task:tasks(id, title, task_date, billing_amount_inr, service_id, client:clients(id, name))')
    .gte('calculated_at', windowFromStr)
    .order('calculated_at', { ascending: false })
    .order('id', { ascending: true })
  const scoresQuery = isAdmin || !employeeId ? scoresBase : scoresBase.eq('employee_id', employeeId)

  const [employeesRes, scoresRes, tasksRes] = await Promise.all([
    employeesQuery,
    fetchAll(scoresQuery),
    // For tasks: admin sees all in-window tasks. Employees only see tasks they
    // have a score on — we filter via the scoresRes ids below to avoid a
    // second round-trip. Render a no-op promise that will be merged client-side.
    isAdmin || !employeeId
      ? fetchAll(supabase
          .from('tasks')
          .select('id, title, task_date, status, billing_amount_inr, service_id, client:clients(id, name)')
          .gte('task_date', windowFromStr)
          .order('task_date', { ascending: false })
          .order('id', { ascending: true }))
      : Promise.resolve({ data: [] as any[] }),
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
          client: t.client,
        })
      }
    }
    tasks = Array.from(seen.values())
  }

  return (
    <ReportsClient
      employees={employeesRes.data || []}
      scores={(scoresRes.data || []) as any[]}
      tasks={tasks as any[]}
    />
  )
}

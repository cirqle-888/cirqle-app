import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchAll, stablePaginationQuery } from '@/lib/supabase/server'
import { defaultWindow } from '@/lib/reports/date-bounds'
import PortalClient from './portal-client'

export const dynamic = 'force-dynamic'

export default async function PortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  let supabase: ReturnType<typeof createAdminClient>
  try {
    supabase = createAdminClient()
  } catch {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="text-center max-w-sm">
          <div className="text-4xl mb-4">⚙️</div>
          <h1 className="text-lg font-semibold mb-2">Portal not configured</h1>
          <p className="text-sm text-muted-foreground">The admin needs to add the service role key to enable the employee portal.</p>
        </div>
      </div>
    )
  }

  // 1. Fetch employee by portal_token
  const { data: employee, error: empError } = await supabase
    .from('employees')
    .select('id, cqid, name, email, performance_rating, base_salary, is_active')
    .eq('portal_token', token)
    .single()

  if (empError || !employee || !employee.is_active) {
    return notFound()
  }

  // 2. Fetch all data in parallel
  // TODO [SCALABILITY SAFEGUARD]: Future optional date-window filtering
  // TODO [SCALABILITY SAFEGUARD]: Lazy loading support
  // TODO [SCALABILITY SAFEGUARD]: Cursor pagination preparation
  // Egress guard: the portal shows an employee's recent work, and it used to
  // fetch EVERY task in the company (all clients, all history) on every view
  // of a public token page. Bounded to the last 12 months — the "later"
  // optimisation the TODO above promised, made real once egress became the
  // binding Supabase quota.
  const portalWindow = defaultWindow()
  const [
    assignmentsRes, tasksRes, contribsRes, scoresRes,
    paramsRes, groupsRes, paramServicesRes, groupServicesRes,
  ] = await Promise.all([
    fetchAll(stablePaginationQuery(supabase.from('task_assignments').select('task_id').eq('employee_id', employee.id))),
    fetchAll(stablePaginationQuery(
      supabase.from('tasks')
        .select('id, title, service_id, billing_amount_inr, status, task_date, client:clients(id, name), service:services(id, name)')
        .in('status', ['pending', 'in_progress', 'done', 'delivered', 'invoiced', 'paid'])
        .gte('task_date', portalWindow.from!)
        .order('task_date', { ascending: false })
    )),
    fetchAll(stablePaginationQuery(
      supabase.from('contributions')
        .select('task_id, parameter_id, value')
        .eq('employee_id', employee.id)
        .gt('value', 0)
    )),
    fetchAll(stablePaginationQuery(
      supabase.from('contribution_scores')
        .select('task_id, score_percentage, earnings_inr')
        .eq('employee_id', employee.id)
    )),
    supabase.from('parameters').select('*').eq('is_active', true).order('display_order'),
    supabase.from('contribution_groups').select('*').eq('is_active', true).order('display_order'),
    supabase.from('parameter_services').select('parameter_id, service_id'),
    supabase.from('group_services').select('group_id, service_id'),
  ])

  const assignedTaskIds = new Set((assignmentsRes.data || []).map((a: any) => a.task_id))
  const allTasks = tasksRes.data || []
  const myTasks = allTasks.filter((t: any) => assignedTaskIds.has(t.id))

  return (
    <PortalClient
      employee={employee}
      tasks={myTasks}
      contributions={contribsRes.data || []}
      scores={scoresRes.data || []}
      parameters={paramsRes.data || []}
      groups={groupsRes.data || []}
      parameterServices={paramServicesRes.data || []}
      groupServices={groupServicesRes.data || []}
      token={token}
    />
  )
}

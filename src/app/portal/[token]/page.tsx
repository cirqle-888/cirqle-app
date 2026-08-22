import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchAll, fetchAllIn, stablePaginationQuery } from '@/lib/supabase/server'
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

  // 2. Fetch in two waves.
  //
  // Wave 1 is everything that identifies THIS employee's work, plus the static
  // lookups. Wave 2 then asks only for the tasks those ids name.
  //
  // This replaces a fetch-everything-then-filter shape that was both wrong and
  // expensive on a PUBLIC page: it pulled every task in the company for the
  // window (all clients, all employees) and then narrowed to the viewer's own
  // by set membership. Two problems with that. The narrowing key was
  // `task_assignments`, a table that is EMPTY in this database — so the filter
  // matched nothing and every portal rendered zero tasks. And the rows it
  // discarded were other clients' work, egressed on an unauthenticated route.
  //
  // Membership now also accepts contributions and contribution_scores, which
  // are how work is actually attributed here (task_assignments is kept in the
  // union so it starts working by itself if it is ever populated).
  const portalWindow = defaultWindow()
  const [
    assignmentsRes, contribsRes, scoresRes,
    paramsRes, groupsRes, paramServicesRes, groupServicesRes,
  ] = await Promise.all([
    fetchAll(stablePaginationQuery(supabase.from('task_assignments').select('task_id').eq('employee_id', employee.id))),
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

  const myTaskIds = Array.from(new Set([
    ...(assignmentsRes.data || []).map((a: any) => a.task_id),
    ...(contribsRes.data    || []).map((c: any) => c.task_id),
    ...(scoresRes.data      || []).map((s: any) => s.task_id),
  ].filter(Boolean) as string[]))

  // Still date-bounded: the portal shows recent work, not an entire career.
  const tasksRes = await fetchAllIn(
    (idChunk) => stablePaginationQuery(
      supabase.from('tasks')
        .select('id, title, service_id, billing_amount_inr, status, task_date, client:clients(id, name), service:services(id, name)')
        .in('id', idChunk)
        .in('status', ['pending', 'in_progress', 'done', 'delivered', 'invoiced', 'paid'])
        .gte('task_date', portalWindow.from!)
    ),
    myTaskIds,
  )

  const myTasks = (tasksRes.data || [])
    .sort((a: any, b: any) => String(b.task_date).localeCompare(String(a.task_date)))

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

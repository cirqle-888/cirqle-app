import { createClient, fetchAll, stablePaginationQuery } from '@/lib/supabase/server'
import TasksClient from './tasks-client'

export const dynamic = 'force-dynamic'

// Supabase enforces a server-side max-rows cap (default 1,000) that overrides
// any client `.limit()` value. To fetch every task we paginate with `.range()`
// in chunks of 1,000 until we hit a partial page. Capped at 50,000 as a
// runaway-safety guard (10× more than any real agency should hit).
async function fetchAllTasks(supabase: Awaited<ReturnType<typeof createClient>>, hasDeletedAt: boolean) {
  const PAGE = 1000
  const MAX_PAGES = 50          // 50 × 1000 = 50,000 hard ceiling
  const all: any[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    let q = supabase
      .from('tasks')
      .select(`*, client:clients(id, name, code), service:services(id, name)`)
      .order('task_number', { ascending: false, nullsFirst: false })
      .order('id', { ascending: true })
      .range(page * PAGE, (page + 1) * PAGE - 1)
    if (hasDeletedAt) q = q.is('deleted_at', null)
    const { data, error } = await q
    if (error || !data) break
    all.push(...data)
    if (data.length < PAGE) break    // last page reached
  }
  return all
}

export default async function TasksPage() {
  const supabase = await createClient()

  // Check if deleted_at column exists by probing with a limit-0 query
  const probe = await supabase
    .from('tasks')
    .select('deleted_at')
    .limit(0)

  const hasDeletedAt = !probe.error

  const cutoff = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString()

  // Only use soft-delete filters if the column exists
  if (hasDeletedAt) {
    // Auto-purge tasks deleted more than 45 days ago
    await supabase.from('tasks').delete().not('deleted_at', 'is', null).lt('deleted_at', cutoff)
  }

  const fallback = <T,>() => ({ data: [] as T[], error: null })

  // Fetch tasks via pagination (bypasses Supabase's 1000-row response cap)
  // in parallel with all the smaller reference-data queries.
  const [allTasks, dbCountRes, clientsRes, servicesRes, clientPricingsRes, employeesRes, taskAssignmentsRes,
    groupsRes, paramsRes, groupServicesRes, paramServicesRes,
    taskGroupsRes, taskGroupAssignmentsRes, taskParamAssignmentsRes] = await Promise.all([
    fetchAllTasks(supabase, hasDeletedAt),
    // Real DB count — tells us if there are more tasks than loaded
    hasDeletedAt
      ? supabase.from('tasks').select('id', { count: 'exact', head: true }).is('deleted_at', null)
      : supabase.from('tasks').select('id', { count: 'exact', head: true }),
    supabase.from('clients').select('id, name, code').eq('is_active', true).order('name'),
    supabase.from('services').select('id, name, default_price, default_currency, pricing_type').eq('is_active', true).order('display_order').order('name'),
    supabase.from('client_service_pricing').select('client_id, service_id, price, currency'),
    supabase.from('employees').select('id, cqid, name, is_active').eq('is_active', true).order('cqid'),
    supabase.from('task_assignments').select('task_id, employee_id'),
    supabase.from('contribution_groups').select('*').order('display_order'),
    supabase.from('parameters').select('*').order('display_order'),
    supabase.from('group_services').select('group_id, service_id'),
    supabase.from('parameter_services').select('parameter_id, service_id'),
    supabase.from('task_groups').select('task_id, group_id')
      .then(r => r, () => fallback<{ task_id: string; group_id: string }>()),
    supabase.from('task_group_assignments').select('task_id, group_id, employee_id')
      .then(r => r, () => fallback<{ task_id: string; group_id: string; employee_id: string }>()),
    supabase.from('task_parameter_assignments').select('task_id, parameter_id, employee_id')
      .then(r => r, () => fallback<{ task_id: string; parameter_id: string; employee_id: string }>()),
  ])

  // Fetch visibility settings
  const [visibilityBillingRes, visibilityContribRes, visibilityNamesRes] = await Promise.all([
    supabase.from('company_settings').select('value').eq('key', 'visibility_billing').maybeSingle(),
    supabase.from('company_settings').select('value').eq('key', 'visibility_contributions').maybeSingle(),
    supabase.from('company_settings').select('value').eq('key', 'visibility_employee_names').maybeSingle(),
  ])

  // Fetch trash only if column exists
  let trashRes = { data: [] as any[] }
  if (hasDeletedAt) {
    const q = supabase
      .from('tasks')
      .select(`*, client:clients(id, name, code), service:services(id, name)`)
      .not('deleted_at', 'is', null)
      .gte('deleted_at', cutoff)
      .order('deleted_at', { ascending: false })
    
    trashRes = await fetchAll(stablePaginationQuery(q)) as any
  }

  return (
    <TasksClient
      dbTaskTotal={dbCountRes.count ?? undefined}
      initialTasks={allTasks || []}
      initialTrash={(trashRes.data || []) as any[]}
      clients={clientsRes.data || []}
      services={servicesRes.data || []}
      clientPricings={(clientPricingsRes.data || []) as any[]}
      employees={(employeesRes.data || []) as any[]}
      taskAssignments={(taskAssignmentsRes.data || []) as any[]}
      groups={(groupsRes.data || []) as any[]}
      parameters={(paramsRes.data || []) as any[]}
      groupServices={(groupServicesRes.data || []) as any[]}
      parameterServices={(paramServicesRes.data || []) as any[]}
      taskGroups={(taskGroupsRes.data || []) as any[]}
      taskGroupAssignments={(taskGroupAssignmentsRes.data || []) as any[]}
      taskParamAssignments={(taskParamAssignmentsRes.data || []) as any[]}
      visibilitySettings={{
        billing:        (visibilityBillingRes.data?.value as string) || 'all',
        contributions:  (visibilityContribRes.data?.value as string) || 'all',
        employee_names: (visibilityNamesRes.data?.value as string) || 'all',
      }}
    />
  )
}

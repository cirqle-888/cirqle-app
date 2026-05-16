import { createClient } from '@/lib/supabase/server'
import TasksClient from './tasks-client'

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

  const [tasksRes, clientsRes, servicesRes, clientPricingsRes, employeesRes, taskAssignmentsRes,
    groupsRes, paramsRes, groupServicesRes, paramServicesRes,
    taskGroupsRes, taskGroupAssignmentsRes, taskParamAssignmentsRes] = await Promise.all([
    hasDeletedAt
      ? supabase
          .from('tasks')
          .select(`*, client:clients(id, name, code), service:services(id, name)`)
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
      : supabase
          .from('tasks')
          .select(`*, client:clients(id, name, code), service:services(id, name)`)
          .order('created_at', { ascending: false }),
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

  // Fetch trash only if column exists
  const trashRes = hasDeletedAt
    ? await supabase
        .from('tasks')
        .select(`*, client:clients(id, name, code), service:services(id, name)`)
        .not('deleted_at', 'is', null)
        .gte('deleted_at', cutoff)
        .order('deleted_at', { ascending: false })
    : { data: [] }

  return (
    <TasksClient
      initialTasks={tasksRes.data || []}
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
    />
  )
}

import { createClient, fetchAll } from '@/lib/supabase/server'
import ContributionsClient from './contributions-client'

export const dynamic = 'force-dynamic'

export default async function ContributionsPage() {
  const supabase = await createClient()

  const [
    tasksRes, employeesRes, groupsRes, parametersRes, toolsRes,
    paramServicesRes, toolServicesRes, groupServicesRes,
    scoresRes, clientsRes, servicesRes, assignmentsRes,
    contributorRecordsRes, taskToolRecordsRes, pricingRes,
    visibilityBillingRes, visibilityContribRes, visibilityNamesRes,
  ] = await Promise.all([
    fetchAll(supabase
      .from('tasks')
      .select('id, task_number, title, service_id, billing_amount_inr, status, task_date, client:clients(id, name), service:services(id, name)')
      .in('status', ['pending', 'in_progress', 'done', 'delivered', 'invoiced', 'paid'])
      .order('task_date', { ascending: false })
      .order('id', { ascending: true })),
    supabase.from('employees').select('id, cqid, name, performance_rating, role').eq('is_active', true).order('cqid'),
    supabase.from('contribution_groups').select('*').eq('is_active', true).order('display_order'),
    supabase.from('parameters').select('*').eq('is_active', true).order('display_order'),
    supabase.from('tools').select('*').eq('is_active', true).order('name'),
    supabase.from('parameter_services').select('parameter_id, service_id'),
    supabase.from('tool_services').select('tool_id, service_id'),
    supabase.from('group_services').select('group_id, service_id'),
    fetchAll(supabase.from('contribution_scores').select('task_id, employee_id, earnings_inr, score_percentage').order('id', { ascending: true })),
    supabase.from('clients').select('id, name').order('name'),
    supabase.from('services').select('id, name').order('name'),
    fetchAll(supabase.from('task_assignments').select('task_id, employee_id').order('task_id', { ascending: true }).order('employee_id', { ascending: true })),
    fetchAll(supabase.from('contributions').select('task_id, employee_id, value').gt('value', 0).order('id', { ascending: true })), // only meaningful contributions
    fetchAll(supabase.from('task_tools').select('task_id, tool_id').order('task_id', { ascending: true }).order('tool_id', { ascending: true })),                // which tools used per task
    supabase.from('client_service_pricing').select('client_id, service_id, commission_percentage, price, currency'), // pre-defined rates
    supabase.from('company_settings').select('value').eq('key', 'visibility_billing').maybeSingle(),
    supabase.from('company_settings').select('value').eq('key', 'visibility_contributions').maybeSingle(),
    supabase.from('company_settings').select('value').eq('key', 'visibility_employee_names').maybeSingle(),
  ])

  return (
    <ContributionsClient
      tasks={tasksRes.data || []}
      employees={employeesRes.data || []}
      groups={groupsRes.data || []}
      parameters={parametersRes.data || []}
      tools={toolsRes.data || []}
      parameterServices={paramServicesRes.data || []}
      toolServices={toolServicesRes.data || []}
      groupServices={groupServicesRes.data || []}
      scores={scoresRes.data || []}
      clients={clientsRes.data || []}
      services={servicesRes.data || []}
      taskAssignments={assignmentsRes.data || []}
      contributorRecords={contributorRecordsRes.data || []}
      taskToolRecords={taskToolRecordsRes.data || []}
      pricingMatrix={pricingRes.data || []}
      visibilitySettings={{
        billing:        (visibilityBillingRes.data?.value as string) || 'all',
        contributions:  (visibilityContribRes.data?.value as string) || 'all',
        employee_names: (visibilityNamesRes.data?.value as string) || 'all',
      }}
    />
  )
}

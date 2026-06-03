import { redirect } from 'next/navigation'
import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import {
  buildAnalysisRows,
  type RawTask, type RawScore, type RawPricing, type EmployeeColumn,
} from '@/lib/reports/contribution-analysis'
import ContributionAnalysisClient from './contribution-analysis-client'

// Scores are written whenever contributions are saved — always read fresh.
export const dynamic = 'force-dynamic'

export default async function ContributionAnalysisPage() {
  // Same wall as Reports: admin OR explicit reports.view. Fail-open pre-migration
  // (no employee record yet) so the app keeps working before perms are seeded.
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? true
  const canView = isAdmin || me?.permissions.has('reports.view') || !me
  if (me && !canView) redirect('/dashboard')

  const supabase = createAdminClient()

  const [employeesRes, clientsRes, servicesRes, pricingRes, tasksRes, scoresRes] = await Promise.all([
    // Active employees define the dynamic columns (ordered by CQID for stability).
    supabase.from('employees').select('id, cqid, name').eq('is_active', true).order('cqid'),
    supabase.from('clients').select('id, name').order('name'),
    supabase.from('services').select('id, name').order('name'),
    fetchAll(supabase.from('client_service_pricing').select('client_id, service_id, commission_percentage').order('id', { ascending: true })),
    fetchAll(
      supabase
        .from('tasks')
        .select('id, task_number, task_date, status, currency, billing_amount, billing_amount_inr, client_id, service_id')
        .order('id', { ascending: true }),
    ),
    fetchAll(
      supabase
        .from('contribution_scores')
        .select('task_id, employee_id, score_percentage, earnings_inr')
        .order('id', { ascending: true }),
    ),
  ])

  const employees: EmployeeColumn[] = (employeesRes.data || []) as EmployeeColumn[]
  const clients = (clientsRes.data || []) as { id: string; name: string }[]
  const services = (servicesRes.data || []) as { id: string; name: string }[]

  const clientName = new Map(clients.map(c => [c.id, c.name]))
  const serviceName = new Map(services.map(s => [s.id, s.name]))

  const rows = buildAnalysisRows(
    (tasksRes.data || []) as RawTask[],
    (scoresRes.data || []) as RawScore[],
    (pricingRes.data || []) as RawPricing[],
    clientName,
    serviceName,
  )

  return (
    <ContributionAnalysisClient
      rows={rows}
      employees={employees}
      clients={clients}
      services={services}
    />
  )
}

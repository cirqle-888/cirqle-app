import { notFound, redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import ProjectDetailClient from './project-detail-client'

export const dynamic = 'force-dynamic'

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? true
  const canView = isAdmin || hasPermission(me, PERMS.ADVERTISING_VIEW)
  if (me && !canView) redirect('/dashboard')

  const admin = createAdminClient()
  const { data: project, error } = await admin
    .from('ad_projects')
    .select('*, client:clients(id, name, code)')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()
  if (error || !project) notFound()

  const [metricsRes, tasksRes, notesRes, eventsRes, invoiceRes, servicesRes, pricingRes] = await Promise.all([
    admin.from('ad_daily_metrics').select('*').eq('project_id', id).order('metric_date', { ascending: false }),
    admin.from('ad_project_tasks')
      .select('task:tasks(id, task_number, title, status, billing_amount)').eq('project_id', id),
    admin.from('ad_notes').select('*, author:employees(id, cqid, name)').eq('project_id', id).order('created_at', { ascending: false }),
    admin.from('ad_events').select('*, actor:employees(id, cqid, name)').eq('project_id', id).order('created_at', { ascending: false }).limit(50),
    admin.from('invoices').select('id, invoice_number, status, total_amount').eq('ad_project_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    admin.from('services').select('id, name, pricing_type, default_price').eq('is_active', true).order('display_order'),
    project.client_id ? admin.from('client_service_pricing').select('client_id, service_id, price').eq('client_id', project.client_id).eq('is_active', true) : Promise.resolve({ data: [] }),
  ])

  const perms = {
    edit:           isAdmin || hasPermission(me, PERMS.ADVERTISING_EDIT),
    manageBudget:   isAdmin || hasPermission(me, PERMS.ADVERTISING_MANAGE_BUDGET),
    enterMetrics:   isAdmin || hasPermission(me, PERMS.ADVERTISING_ENTER_METRICS) || hasPermission(me, PERMS.ADVERTISING_EDIT),
    approveMetrics: isAdmin || hasPermission(me, PERMS.ADVERTISING_APPROVE_METRICS),
  }

  return (
    <ProjectDetailClient
      project={project}
      metrics={metricsRes.data || []}
      tasks={(tasksRes.data || []).map((r: any) => r.task).filter(Boolean)}
      notes={notesRes.data || []}
      events={eventsRes.data || []}
      invoice={(invoiceRes.data as any) || null}
      services={servicesRes.data || []}
      servicePricing={pricingRes.data || []}
      perms={perms}
    />
  )
}

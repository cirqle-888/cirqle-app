import { notFound, redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { getWalletSummary, getCompanyWalletSummary } from '@/lib/advertising/wallet'
import ProjectDetailClient from './project-detail-client'

export const dynamic = 'force-dynamic'

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
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

  const [metricsRes, tasksRes, notesRes, invoiceRes, servicesRes, pricingRes, allocRes] = await Promise.all([
    admin.from('ad_daily_metrics').select('*').eq('project_id', id).order('metric_date', { ascending: false }),
    admin.from('ad_project_tasks')
      .select('created_at, task:tasks(id, task_number, title, status, billing_amount)').eq('project_id', id).order('created_at', { ascending: true }),
    admin.from('ad_notes').select('*, author:employees(id, cqid, name)').eq('project_id', id).order('created_at', { ascending: false }),
    // ad_events fetch removed with the Notes tab's inline timeline — the
    // Timeline tab reads the universal activity feed instead.
    admin.from('invoices').select('id, invoice_number, status, total_amount').eq('ad_project_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    admin.from('services').select('id, name, pricing_type, default_price').eq('is_active', true).order('display_order'),
    project.client_id ? admin.from('client_service_pricing').select('client_id, service_id, price').eq('client_id', project.client_id).eq('is_active', true) : Promise.resolve({ data: [] }),
    // Campaign allocations = wallet ledger debits for this project
    // (best-effort — ledger may not be migrated yet).
    admin.from('ad_wallet_ledger')
      .select('id, amount, amount_inr, notes, created_at, creator:employees(id, name, cqid)')
      .eq('ad_project_id', id).eq('direction', 'debit').is('deleted_at', null)
      .order('created_at', { ascending: false }),
  ])

  // The money layer is confidential — manage_budget implies seeing it.
  const viewFinancials = isAdmin
    || hasPermission(me, PERMS.ADVERTISING_VIEW_FINANCIALS)
    || hasPermission(me, PERMS.ADVERTISING_MANAGE_BUDGET)

  const allocSupported = viewFinancials && !allocRes.error
  // Client campaigns read the client wallet; company (internal) campaigns read
  // the company wallet (client_id NULL rows — migration 20260714093000).
  const wallet = !viewFinancials
    ? null
    : project.client_id
      ? await getWalletSummary(admin, project.client_id)
      : (project as any).scope === 'company'
        ? await getCompanyWalletSummary(admin)
        : null

  const perms = {
    edit:           isAdmin || hasPermission(me, PERMS.ADVERTISING_EDIT),
    manageBudget:   isAdmin || hasPermission(me, PERMS.ADVERTISING_MANAGE_BUDGET),
    enterMetrics:   isAdmin || hasPermission(me, PERMS.ADVERTISING_ENTER_METRICS) || hasPermission(me, PERMS.ADVERTISING_EDIT),
    approveMetrics: isAdmin || hasPermission(me, PERMS.ADVERTISING_APPROVE_METRICS),
    viewFinancials,
  }

  // Server-side strip for handlers without view_financials: the service-charge
  // terms on the project row, task billing amounts, invoices, allocations and
  // client price overrides never reach the browser. Stripping here (not at
  // render) keeps them out of the RSC payload entirely.
  const safeProject = viewFinancials ? project : {
    ...project, service_charge_type: null, service_charge_value: null, tax_percent: null,
  }
  const tasks = (tasksRes.data || []).map((r: any) => r.task).filter(Boolean)
  const safeTasks = viewFinancials ? tasks : tasks.map((t: any) => ({ ...t, billing_amount: null }))

  return (
    <ProjectDetailClient
      project={safeProject}
      metrics={metricsRes.data || []}
      tasks={safeTasks}
      notes={notesRes.data || []}
      invoice={viewFinancials ? ((invoiceRes.data as any) || null) : null}
      services={viewFinancials
        ? (servicesRes.data || [])
        : (servicesRes.data || []).map((s: any) => ({ ...s, default_price: null }))}
      servicePricing={viewFinancials ? (pricingRes.data || []) : []}
      allocations={viewFinancials ? ((allocRes.data as any) || []) : []}
      wallet={wallet}
      allocSupported={allocSupported}
      perms={perms}
    />
  )
}

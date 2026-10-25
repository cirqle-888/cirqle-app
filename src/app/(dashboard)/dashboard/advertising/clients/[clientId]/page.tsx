import { notFound, redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { loadAdvertisingData } from '../../_data'
import ClientWorkspace from './client-workspace'
import { loadClientReportPreferences } from '@/lib/reporting/preferences'

export const dynamic = 'force-dynamic'

/**
 * Client workspace (plan Phase 3): one client's advertising in four tabs —
 * Overview · Campaigns · Funds & billing · Reports. Same data and the same
 * permission gating as the overview (loadAdvertisingData), filtered to the
 * client.
 */
export default async function ClientWorkspacePage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) notFound()

  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const canView = isAdmin || hasPermission(me, PERMS.ADVERTISING_VIEW)
  if (me && !canView) redirect('/dashboard')

  const viewFinancials = isAdmin
    || hasPermission(me, PERMS.ADVERTISING_VIEW_FINANCIALS)
    || hasPermission(me, PERMS.ADVERTISING_MANAGE_BUDGET)
  const viewBilling = isAdmin
    || hasPermission(me, PERMS.ADVERTISING_VIEW_BILLING)
    || hasPermission(me, PERMS.ADVERTISING_MANAGE_BUDGET)
  const viewReports = isAdmin || hasPermission(me, PERMS.ADVERTISING_VIEW_REPORTS)

  const admin = createAdminClient()
  const { data: client } = await admin.from('clients').select('id, name, code').eq('id', clientId).maybeSingle()
  if (!client) notFound()

  const [data, reports, prefs] = await Promise.all([
    loadAdvertisingData({ clientId, viewFinancials, viewBilling }),
    viewReports
      ? admin.from('ad_reports').select(
          'id, project_id, client_id, report_type, template, date_from, date_to, ' +
          'status, error_message, generation_time_ms, pdf_url, xlsx_url, csv_url, ' +
          'image_url_portrait, image_url_square, created_at, generated_at, ' +
          'project:ad_projects(id, campaign_name, platform, client:clients(id, name, code))',
        ).eq('client_id', clientId).order('created_at', { ascending: false }).limit(25)
          .then(r => (r.data as any[]) ?? [], () => [])
      : Promise.resolve([] as any[]),
    loadClientReportPreferences(admin, [clientId]),
  ])

  const perms = {
    create:         isAdmin || hasPermission(me, PERMS.ADVERTISING_CREATE),
    edit:           isAdmin || hasPermission(me, PERMS.ADVERTISING_EDIT),
    manageBudget:   isAdmin || hasPermission(me, PERMS.ADVERTISING_MANAGE_BUDGET),
    viewFinancials,
    viewBilling,
    viewReports,
  }

  return (
    <ClientWorkspace
      client={client}
      migrated={data.migrated}
      projects={data.projects}
      metricsByProject={data.metricsByProject}
      benchmarksByProject={data.benchmarksByProject}
      attention={data.attention}
      walletSupported={data.walletSupported}
      ledger={data.ledger}
      fundCandidates={data.fundCandidates}
      reports={reports}
      reportPreferences={prefs.byClient}
      reportPreferencesSupported={prefs.supported}
      perms={perms}
    />
  )
}

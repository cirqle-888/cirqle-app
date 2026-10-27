/**
 * One client's advertising workspace data — shared by the Advertising client
 * workspace and the Ads tab of the Client Marketing Hub, so both show exactly
 * the same campaigns, money and reports under the same permission gates.
 */

import { createAdminClient } from '@/lib/supabase/server'
import { hasPermission, type CurrentUser } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { loadClientReportPreferences } from '@/lib/reporting/preferences'
import { loadAdvertisingData } from '../../_data'
import { loadFundsData, sliceFundsForClient } from '../../funds/_data'

export interface ClientAdsPerms {
  create: boolean
  edit: boolean
  manageBudget: boolean
  viewFinancials: boolean
  viewBilling: boolean
  viewReports: boolean
}

export function clientAdsPerms(me: CurrentUser | null): ClientAdsPerms & { view: boolean } {
  const isAdmin = me?.isAdmin ?? false
  const viewFinancials = isAdmin
    || hasPermission(me, PERMS.ADVERTISING_VIEW_FINANCIALS)
    || hasPermission(me, PERMS.ADVERTISING_MANAGE_BUDGET)
  const viewBilling = isAdmin
    || hasPermission(me, PERMS.ADVERTISING_VIEW_BILLING)
    || hasPermission(me, PERMS.ADVERTISING_MANAGE_BUDGET)
  return {
    view:         isAdmin || hasPermission(me, PERMS.ADVERTISING_VIEW),
    create:       isAdmin || hasPermission(me, PERMS.ADVERTISING_CREATE),
    edit:         isAdmin || hasPermission(me, PERMS.ADVERTISING_EDIT),
    manageBudget: isAdmin || hasPermission(me, PERMS.ADVERTISING_MANAGE_BUDGET),
    viewFinancials,
    viewBilling,
    viewReports:  isAdmin || hasPermission(me, PERMS.ADVERTISING_VIEW_REPORTS),
  }
}

export async function loadClientAds(clientId: string, perms: ClientAdsPerms) {
  const admin = createAdminClient()
  const [data, reports, prefs] = await Promise.all([
    loadAdvertisingData({ clientId, viewFinancials: perms.viewFinancials, viewBilling: perms.viewBilling }),
    perms.viewReports
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
  // Meta ad funds (top-up, suggestion, statement) — wallet-layer, so gated.
  const adFunds = perms.viewFinancials
    ? await loadFundsData().then(d => sliceFundsForClient(d, clientId), () => null)
    : null
  return { data, reports, prefs, adFunds }
}

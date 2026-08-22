/**
 * /dashboard/advertising/reports
 *
 * Reports hub: lists all reports across all projects for the current agency.
 * Includes: Report history | Generate new | Schedules
 */

import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import ReportsClient from './reports-client'

export const dynamic = 'force-dynamic'

export default async function ReportsPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const canView = isAdmin || hasPermission(me, PERMS.ADVERTISING_VIEW)
  if (me && !canView) redirect('/dashboard')

  const admin = createAdminClient()

  // Three independent lists — fetched together rather than in series.
  const [{ data: reports }, { data: schedules }, { data: projects }] = await Promise.all([
    // Recent reports (last 50) across all projects
    admin
    .from('ad_reports')
    .select(
      'id, project_id, client_id, report_type, template, date_from, date_to, ' +
      'status, error_message, generation_time_ms, pdf_url, xlsx_url, csv_url, ' +
      'image_url_portrait, image_url_square, created_at, generated_at, ' +
      'project:ad_projects(id, campaign_name, platform, client:clients(id, name, code))'
    )
    .order('created_at', { ascending: false })
    .limit(50),
    // Active schedules
    admin
    .from('ad_report_schedules')
    .select(
      'id, project_id, client_id, frequency, report_type, template, formats, ' +
      'is_active, next_run_at, last_run_at, created_at, ' +
      'project:ad_projects(id, campaign_name, platform, client:clients(id, name, code))'
    )
    .eq('is_active', true)
    .order('next_run_at', { ascending: true })
    .limit(20),
    // Projects for the "Generate Report" dropdown
    admin
    .from('ad_projects')
    .select('id, campaign_name, platform, client_id, client:clients(id, name, code)')
    .is('deleted_at', null)
    .in('status', ['active', 'paused', 'completed'])
    .order('created_at', { ascending: false })
    .limit(100),
  ])

  const canEdit = isAdmin || hasPermission(me, PERMS.ADVERTISING_EDIT)

  return (
    <ReportsClient
      reports={(reports as any[]) ?? []}
      schedules={(schedules as any[]) ?? []}
      projects={(projects as any[]) ?? []}
      canEdit={canEdit}
    />
  )
}

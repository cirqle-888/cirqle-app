/**
 * /dashboard/advertising/reports
 *
 * Reports hub: lists all reports across all projects for the current agency.
 * Includes: Report history | Prepare report (the shared composer) | Schedules
 */

import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import ReportsClient from './reports-client'
import { loadClientReportPreferences } from '@/lib/reporting/preferences'

export const dynamic = 'force-dynamic'

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  const page = Math.max(0, Math.min(100000, Math.floor(Number(params.page) || 0)))
  const query = typeof params.q === 'string' ? params.q.trim().slice(0, 100) : ''
  const status = typeof params.status === 'string' && ['pending', 'generating', 'partial', 'ready', 'failed'].includes(params.status) ? params.status : ''
  const pageSize = 25
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const canView = isAdmin || hasPermission(me, PERMS.ADVERTISING_VIEW_REPORTS)
  if (!me || !canView) redirect('/dashboard')

  const admin = createAdminClient()

  let reportQuery = admin.from('ad_reports').select(
    'id, project_id, client_id, report_type, template, date_from, date_to, ' +
    'status, error_message, generation_time_ms, pdf_url, xlsx_url, csv_url, ' +
    'image_url_portrait, image_url_square, created_at, generated_at, ' +
    'project:ad_projects!inner(id, campaign_name, platform, client:clients(id, name, code))',
    { count: 'exact' },
  ).order('created_at', { ascending: false }).order('id', { ascending: false })
  if (query) reportQuery = reportQuery.ilike('project.campaign_name', `%${query.replace(/[%_]/g, '')}%`)
  if (status) reportQuery = reportQuery.eq('status', status)

  // Read complete selector/schedule lists in bounded pages, beyond PostgREST's
  // per-response row limit. History itself stays server-paginated.
  async function allRows(table: string, selection: string, projectsOnly = false) {
    const rows: unknown[] = []
    for (let offset = 0; ; offset += 500) {
      let q = admin.from(table).select(selection).order('id').range(offset, offset + 499)
      if (projectsOnly) q = q.is('deleted_at', null).in('status', ['active', 'paused', 'completed'])
      const { data, error } = await q
      if (error) throw new Error('Could not load reports. Please try again.')
      rows.push(...(data ?? []))
      if (!data || data.length < 500) return rows
    }
  }
  const [history, schedules, projects] = await Promise.all([
    reportQuery.range(page * pageSize, (page + 1) * pageSize - 1),
    allRows('ad_report_schedules',
      'id, project_id, client_id, frequency, report_type, template, formats, is_active, next_run_at, last_run_at, created_at, project:ad_projects(id, campaign_name, platform, client:clients(id, name, code))'),
    allRows('ad_projects', 'id, campaign_name, platform, client_id, status, archived_at, campaign_type, start_date, created_at, client:clients(id, name, code)', true),
  ])
  const prefs = await loadClientReportPreferences(admin)
  const initialClientId = typeof params.client === 'string' && /^[0-9a-f-]{36}$/i.test(params.client) ? params.client : undefined
  if (history.error) throw new Error('Could not load report history. Please try again.')

  const canEdit = isAdmin || hasPermission(me, PERMS.ADVERTISING_EDIT)

  return (
    <ReportsClient
      reports={(history.data as any[]) ?? []}
      pagination={{ page, pageSize, total: history.count ?? 0, query, status }}
      schedules={(schedules as any[]) ?? []}
      projects={(projects as any[]) ?? []}
      initialClientId={initialClientId}
      preferences={prefs.byClient}
      preferencesSupported={prefs.supported}
      canEdit={canEdit}
    />
  )
}

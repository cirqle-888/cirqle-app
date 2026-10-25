/**
 * GET  /api/advertising/reports/schedules?projectId=
 * POST /api/advertising/reports/schedules
 *
 * List and create report schedules.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requirePermission, requireReadPermission } from '@/lib/permissions/check'
import { computeNextRun } from '@/lib/reporting/scheduler-utils'
import { parseScheduleFields, resolveReportScope } from '@/lib/reporting/config'

export const dynamic = 'force-dynamic'

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const guard = await requireReadPermission('advertising.view_reports')
    if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 403 })

    const projectId = req.nextUrl.searchParams.get('projectId')
    if (!projectId) return NextResponse.json({ error: 'Missing projectId' }, { status: 400 })

    const admin = createAdminClient()
    const { data, error } = await admin
      .from('ad_report_schedules')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data ?? [])
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const guard = await requirePermission('advertising.edit')
    if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 403 })
    const body = await req.json().catch(() => null)
    if (!body || typeof body.project_id !== 'string') {
      return NextResponse.json({ error: 'Select a campaign.' }, { status: 400 })
    }

    const fields = parseScheduleFields(body)
    if (!fields.ok) return NextResponse.json({ error: fields.error }, { status: 400 })

    const admin = createAdminClient()
    // The client comes from the campaign row; a mismatching client_id is refused.
    const scope = await resolveReportScope(admin, body.project_id, body.client_id)
    if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: 400 })

    const f = fields.value
    const nextRun = computeNextRun(f.frequency, f.delivery_hour, f.delivery_timezone)

    const { data, error } = await admin
      .from('ad_report_schedules')
      .insert({
        project_id:        scope.value.projectId,
        client_id:         scope.value.clientId,
        frequency:         f.frequency,
        cron_expression:   body.cron_expression   ?? null,
        delivery_hour:     f.delivery_hour,
        delivery_timezone: f.delivery_timezone,
        report_type:       f.report_type,
        template:          f.template,
        formats:           f.formats,
        include_comparison: body.include_comparison ?? true,
        recipients:        f.recipients,
        is_active:         body.is_active          ?? true,
        next_run_at:       nextRun,
        created_by:        guard.employeeId || null,
      })
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data, { status: 201 })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

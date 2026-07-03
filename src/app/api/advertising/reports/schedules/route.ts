/**
 * GET  /api/advertising/reports/schedules?projectId=
 * POST /api/advertising/reports/schedules
 *
 * List and create report schedules.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { computeNextRun } from '@/lib/reporting/scheduler-utils'

export const dynamic = 'force-dynamic'

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const me = await loadCurrentUser().catch(() => null)
    if (!me || !hasPermission(me, 'advertising.view_reports')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

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
    const me   = await loadCurrentUser().catch(() => null)
    if (!me || !hasPermission(me, 'advertising.edit')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }
    const body = await req.json()

    if (!body.project_id) return NextResponse.json({ error: 'Missing project_id' }, { status: 400 })
    if (!body.client_id)  return NextResponse.json({ error: 'Missing client_id' }, { status: 400 })

    const nextRun = computeNextRun(body.frequency ?? 'weekly', body.delivery_hour ?? 7)

    const admin = createAdminClient()
    const { data, error } = await admin
      .from('ad_report_schedules')
      .insert({
        project_id:        body.project_id,
        client_id:         body.client_id,
        frequency:         body.frequency         ?? 'weekly',
        cron_expression:   body.cron_expression   ?? null,
        delivery_hour:     body.delivery_hour      ?? 7,
        delivery_timezone: body.delivery_timezone  ?? 'UTC',
        report_type:       body.report_type        ?? 'weekly',
        template:          body.template           ?? 'performance',
        formats:           body.formats            ?? ['pdf'],
        include_comparison: body.include_comparison ?? true,
        recipients:        body.recipients         ?? [],
        is_active:         body.is_active          ?? true,
        next_run_at:       nextRun,
        created_by:        me.employeeId || null,
      })
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data, { status: 201 })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

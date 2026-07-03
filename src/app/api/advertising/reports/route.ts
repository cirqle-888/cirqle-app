/**
 * GET /api/advertising/reports?projectId=&limit=&page=
 *
 * Lists generated reports for a project (newest first).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const me = await loadCurrentUser().catch(() => null)
    if (!me || !hasPermission(me, 'advertising.view_reports')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    const { searchParams } = req.nextUrl
    const projectId = searchParams.get('projectId')
    const limit     = Math.min(Number(searchParams.get('limit') ?? 20), 100)
    const page      = Math.max(Number(searchParams.get('page') ?? 0), 0)

    if (!projectId) return NextResponse.json({ error: 'Missing projectId' }, { status: 400 })

    const admin = createAdminClient()
    const from  = page * limit
    const to    = from + limit - 1

    const { data, error, count } = await admin
      .from('ad_reports')
      .select(
        'id, project_id, client_id, report_type, template, date_from, date_to, ' +
        'comparison_from, comparison_to, status, error_message, generation_time_ms, ' +
        'pdf_url, xlsx_url, csv_url, image_url_portrait, image_url_square, ' +
        'generated_by, schedule_id, created_at, generated_at',
        { count: 'exact' },
      )
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ data, total: count ?? 0, page, limit })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

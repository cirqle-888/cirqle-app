/**
 * GET /api/advertising/reports/[id]
 *
 * Returns a single report record (without render_data blob to keep
 * response small; use /download for file URLs).
 *
 * Also tracks the 'viewed' analytics event.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { deleteReportStorageAndRow } from '@/lib/reporting/delete-report'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const admin   = createAdminClient()
    const me      = await loadCurrentUser().catch(() => null)

    const { data, error } = await admin
      .from('ad_reports')
      .select(
        'id, project_id, client_id, report_type, template, date_from, date_to, ' +
        'comparison_from, comparison_to, status, error_message, generation_time_ms, ' +
        'pdf_url, xlsx_url, csv_url, image_url_portrait, image_url_square, ' +
        'ai_narrative, generated_by, schedule_id, created_at, generated_at'
      )
      .eq('id', id)
      .maybeSingle()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data)  return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Track viewed event (fire-and-forget)
    void admin.from('ad_report_analytics').insert({
      report_id: id,
      event:     'viewed',
      user_id:   (me as any)?.id ?? null,
    }).then(null, () => {})

    return NextResponse.json(data)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

/**
 * DELETE /api/advertising/reports/[id]
 *
 * Permanently removes a generated report (storage files + DB row). Requires
 * advertising edit permission (or admin).
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const me = await loadCurrentUser().catch(() => null)
    if (!me) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!me.isAdmin && !hasPermission(me, PERMS.ADVERTISING_EDIT)) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    }

    const admin = createAdminClient()
    const { error: lookupErr, data: report } = await admin
      .from('ad_reports').select('id').eq('id', id).maybeSingle()
    if (lookupErr) return NextResponse.json({ error: lookupErr.message }, { status: 500 })
    if (!report)   return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const result = await deleteReportStorageAndRow(admin, id)
    if (result.error) return NextResponse.json({ error: result.error }, { status: 500 })

    return NextResponse.json({ ok: true, filesRemoved: result.filesRemoved })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

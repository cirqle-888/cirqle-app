/**
 * GET /api/advertising/reports/[id]/download?format=pdf|xlsx|csv|image_portrait|image_square
 *
 * Returns a fresh signed URL for the requested format.
 * Also tracks the 'downloaded' analytics event.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const format  = req.nextUrl.searchParams.get('format') ?? 'pdf'
    const admin   = createAdminClient()
    const me      = await loadCurrentUser().catch(() => null)

    const { data, error } = await admin
      .from('ad_reports')
      .select('id, pdf_url, xlsx_url, csv_url, image_url_portrait, image_url_square, status')
      .eq('id', id)
      .maybeSingle()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data)  return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (data.status !== 'ready') return NextResponse.json({ error: 'Report not ready' }, { status: 409 })

    const urlMap: Record<string, string | null> = {
      pdf:            data.pdf_url,
      xlsx:           data.xlsx_url,
      csv:            data.csv_url,
      image_portrait: data.image_url_portrait,
      image_square:   data.image_url_square,
    }

    const url = urlMap[format]
    if (!url) return NextResponse.json({ error: `Format '${format}' not generated for this report` }, { status: 404 })

    // Track downloaded event
    void admin.from('ad_report_analytics').insert({
      report_id: id,
      event:     'downloaded',
      format,
      user_id:   (me as any)?.id ?? null,
    }).then(null, () => {})

    return NextResponse.json({ url, format })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

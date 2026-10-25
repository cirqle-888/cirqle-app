/**
 * GET /api/advertising/reports/[id]/download?format=pdf|xlsx|csv|image_portrait|image_square[&redirect=1]
 *
 * Returns a fresh signed URL for the requested format (or, with redirect=1,
 * redirects to it so it can be used directly as a link).
 * Also tracks the 'downloaded' analytics event.
 *
 * The URL saved on the report was signed for 7 days and used to be handed
 * back unchanged, so every report older than a week failed to download. Now
 * access is checked on every request, the storage key is recovered from the
 * saved URL (validated to be this report's own object), and a 10-minute URL
 * is signed for this one download.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireReadPermission } from '@/lib/permissions/check'
import { signDownloadUrl, storageKeyFromStoredUrl } from '@/lib/reporting/delivery-engine'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const format  = req.nextUrl.searchParams.get('format') ?? 'pdf'
    const redirect = req.nextUrl.searchParams.get('redirect') === '1'
    const guard   = await requireReadPermission('advertising.view_reports')
    if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 403 })

    const admin = createAdminClient()
    const { data, error } = await admin
      .from('ad_reports')
      .select('id, pdf_url, xlsx_url, csv_url, image_url_portrait, image_url_square, status, export_results, image_bundle_url')
      .eq('id', id)
      .maybeSingle()

    if (error) return NextResponse.json({ error: 'Could not load the report.' }, { status: 500 })
    if (!data)  return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!['ready', 'partial'].includes(data.status)) return NextResponse.json({ error: 'Report not ready' }, { status: 409 })

    const urlMap: Record<string, string | null> = {
      image_bundle: data.image_bundle_url,
      pdf:            data.pdf_url,
      xlsx:           data.xlsx_url,
      csv:            data.csv_url,
      image_portrait: data.image_url_portrait,
      image_square:   data.image_url_square,
    }

    if (!(format in urlMap)) return NextResponse.json({ error: 'Unsupported format' }, { status: 400 })
    const stored = urlMap[format]
    if (!stored) return NextResponse.json({ error: `Format '${format}' not generated for this report` }, { status: 404 })

    const exports = Array.isArray(data.export_results) ? data.export_results : []
    const savedKey = exports.find((item: { format?: string }) => item.format === format)?.storageKey
    const validKey = typeof savedKey === 'string' && savedKey.startsWith(`reports/${data.id}/`)
      && !savedKey.includes('..') && !savedKey.includes(String.fromCharCode(92))
    const key = validKey ? savedKey : storageKeyFromStoredUrl(stored, data.id)
    if (!key) return NextResponse.json({ error: 'This file cannot be located. Generate the report again.' }, { status: 410 })

    let url: string
    try {
      url = await signDownloadUrl(key)
    } catch {
      return NextResponse.json({ error: 'This file is no longer stored. Generate the report again.' }, { status: 410 })
    }

    // Track downloaded event
    void admin.from('ad_report_analytics').insert({
      report_id: id,
      event:     'downloaded',
      format,
      user_id:   guard.employeeId || null,
    }).then(null, () => {})

    if (redirect) return NextResponse.redirect(url, { status: 302, headers: NO_STORE })
    return NextResponse.json({ url, format }, { headers: NO_STORE })
  } catch {
    return NextResponse.json({ error: 'Download failed. Please try again.' }, { status: 500 })
  }
}

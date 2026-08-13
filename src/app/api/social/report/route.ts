import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { generateSocialReportHtml } from '@/lib/integrations/meta/social-report'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Branded social & marketing report as HTML.
 * GET /api/social/report?clientId=<uuid>&days=30[&download=1]
 * Renders in a new tab; print-to-PDF for a PDF copy.
 */
export async function GET(req: NextRequest) {
  const me = await loadCurrentUser().catch(() => null)
  if (!me || !(me.isAdmin || hasPermission(me, [PERMS.SOCIAL_VIEW_INSIGHTS, PERMS.ADVERTISING_VIEW_REPORTS]))) {
    return new NextResponse('Unauthorized', { status: 401 })
  }
  const url = new URL(req.url)
  const clientId = url.searchParams.get('clientId')
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30))
  if (!clientId) return new NextResponse('Missing clientId', { status: 400 })

  try {
    const admin = createAdminClient()
    const { html, clientName } = await generateSocialReportHtml(admin, clientId, days)
    const headers: Record<string, string> = { 'Content-Type': 'text/html; charset=utf-8' }
    if (url.searchParams.get('download')) {
      const safe = clientName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
      headers['Content-Disposition'] = `attachment; filename="${safe}-social-report.html"`
    }
    return new NextResponse(html, { status: 200, headers })
  } catch (err: any) {
    console.error('[social/report]', err)
    return new NextResponse(`Report generation failed: ${err?.message}`, { status: 500 })
  }
}

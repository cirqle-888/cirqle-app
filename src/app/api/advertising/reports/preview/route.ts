import { NextRequest, NextResponse } from 'next/server'
import { requireReadPermission } from '@/lib/permissions/check'
import { createAdminClient } from '@/lib/supabase/server'
import { buildRenderData } from '@/lib/reporting/render-engine'
import { parseReportRequest, resolveScopeFor } from '@/lib/reporting/config'
import { savePreviewDraft } from '@/lib/reporting/save-preview-draft'
import type { ReportConfig } from '@/lib/reporting/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Same parser as /generate, so the preview and the export are built from an
// identical config (sections included). Recipients are irrelevant to a
// preview and are dropped — nothing is sent from here.
export async function POST(req: NextRequest) {
  try {
    const guard = await requireReadPermission('advertising.view_reports')
    if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 403 })

    const body = await req.json().catch(() => null)
    const parsed = parseReportRequest(body)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const scope = await resolveScopeFor(createAdminClient(), parsed.value, body?.clientId)
    if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: 400 })

    const config: ReportConfig = {
      ...parsed.value,
      clientId:    scope.value.clientId,
      generatedBy: guard.employeeId || undefined,
      recipients:  [],
    }

    const renderData = await buildRenderData(config)
    if (body?.saveDraft === true) {
      const saved = await savePreviewDraft(config, renderData)
      if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: saved.status })
      const draft = saved.draft
      return NextResponse.json({ ...renderData, snapshotId: draft.id }, { headers: { 'Cache-Control': 'private, no-store' } })
    }
    return NextResponse.json(renderData, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (err) {
    console.error('[API /reports/preview]', err)
    return NextResponse.json({ error: 'Preview failed. Please try again.' }, { status: 500 })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { buildRenderData } from '@/lib/reporting/render-engine'
import type { ReportConfig } from '@/lib/reporting/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  try {
    const me = await loadCurrentUser().catch(() => null)
    if (!me || !hasPermission(me, 'advertising.view_reports')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    const body = await req.json() as Partial<ReportConfig>

    if (!body.projectId)  return NextResponse.json({ error: 'Missing projectId' }, { status: 400 })
    if (!body.clientId)   return NextResponse.json({ error: 'Missing clientId' }, { status: 400 })
    if (!body.dateFrom)   return NextResponse.json({ error: 'Missing dateFrom' }, { status: 400 })
    if (!body.dateTo)     return NextResponse.json({ error: 'Missing dateTo' }, { status: 400 })

    const config: ReportConfig = {
      projectId:      body.projectId,
      clientId:       body.clientId,
      reportType:     body.reportType     ?? 'custom',
      template:       body.template       ?? 'performance',
      dateFrom:       body.dateFrom,
      dateTo:         body.dateTo,
      comparisonFrom: body.comparisonFrom,
      comparisonTo:   body.comparisonTo,
      formats:        body.formats?.length ? body.formats : ['pdf'],
      generatedBy:    me.employeeId || undefined,
      recipients:     body.recipients     ?? [],
      sections:       body.sections,
    }

    const renderData = await buildRenderData(config)
    return NextResponse.json(renderData)
  } catch (err: any) {
    console.error('[API /reports/preview]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

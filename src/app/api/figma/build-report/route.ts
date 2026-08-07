import { NextRequest, NextResponse } from 'next/server'
import { FIGMA_CORS_HEADERS as CORS_HEADERS, figmaOptions, verifyFigmaAuth } from '../_lib/auth'

/**
 * POST /api/figma/build-report — the plugin reports a finished flyer build.
 *
 * The offer save (../campaign) already created ONE task per campaign with a
 * `[figma:cmp:<id>]` marker and auto-filled the product/edit contribution
 * counts. This route completes the picture with what only the BUILD knows:
 * how many pages and how many creatives (cards) were actually produced, per
 * employee. Values are SET, not incremented — designers rebuild the same
 * flyer many times, and ten rebuilds of a 2-page flyer are still 2 pages.
 *
 * Best-effort like the task creation: parameters are matched by name against
 * the workspace's own contribution setup ("Pages", "Creatives"/"Designs"),
 * and anything missing is skipped silently.
 */

export const dynamic = 'force-dynamic'

export const OPTIONS = figmaOptions

export async function POST(req: NextRequest) {
  try {
    const auth = await verifyFigmaAuth(req)
    if (!auth.ok) return auth.response
    const admin = auth.admin

    const body = (await req.json().catch(() => null)) as {
      campaignId?: string
      createdBy?: { id?: string | null; cqid?: string | null }
      pages?: number
      cards?: number
    } | null
    const campaignId = (body?.campaignId || '').trim()
    const employeeId = body?.createdBy?.id || null
    const pages = Math.max(0, Math.round(Number(body?.pages) || 0))
    const cards = Math.max(0, Math.round(Number(body?.cards) || 0))
    if (!campaignId || !employeeId || (!pages && !cards)) {
      // Nothing attributable — fine, the build itself already succeeded.
      return NextResponse.json({ ok: true, recorded: false }, { headers: CORS_HEADERS })
    }

    const { data: taskRow } = await admin
      .from('tasks')
      .select('id, task_number')
      .ilike('description', `%[figma:cmp:${campaignId}]%`)
      .is('deleted_at', null)
      .maybeSingle()
    const taskId = (taskRow as { id?: string } | null)?.id
    if (!taskId) return NextResponse.json({ ok: true, recorded: false }, { headers: CORS_HEADERS })

    const { data: paramRows } = await admin.from('parameters').select('id, name, input_type')
    const params = (paramRows as { id: string; name: string | null; input_type: string | null }[] | null) || []
    const flat = (s: string | null) => String(s || '').toLowerCase().replace(/[^a-z]/g, '')
    const findParam = (test: (n: string) => boolean) =>
      params.find(p => (p.input_type || 'count') === 'count' && test(flat(p.name)))?.id || null
    const pagesParam = findParam(n => n === 'pages' || n === 'page' || n === 'pagesdone' || n === 'flyerpages')
    const creativeParam = findParam(n => n.includes('creative') || n === 'designs' || n === 'cards')

    const setValue = async (parameterId: string | null, value: number) => {
      if (!parameterId || value <= 0) return
      const { data: row } = await admin
        .from('contributions')
        .select('value')
        .eq('task_id', taskId)
        .eq('employee_id', employeeId)
        .eq('parameter_id', parameterId)
        .maybeSingle()
      if (row) {
        await admin.from('contributions').update({ value })
          .eq('task_id', taskId).eq('employee_id', employeeId).eq('parameter_id', parameterId)
      } else {
        await admin.from('contributions').insert({
          task_id: taskId, employee_id: employeeId, parameter_id: parameterId, value,
        })
      }
    }

    await setValue(pagesParam, pages)
    await setValue(creativeParam, cards)

    return NextResponse.json(
      { ok: true, recorded: true, taskNumber: (taskRow as { task_number?: number } | null)?.task_number ?? null },
      { headers: CORS_HEADERS },
    )
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Report failed.' },
      { status: 500, headers: CORS_HEADERS },
    )
  }
}

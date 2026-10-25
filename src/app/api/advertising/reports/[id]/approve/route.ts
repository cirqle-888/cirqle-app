import { NextResponse } from 'next/server'
import { requirePermission } from '@/lib/permissions/check'
import { createAdminClient } from '@/lib/supabase/server'
import { snapshotProblem } from '@/lib/reporting/snapshot'
import type { RenderData } from '@/lib/reporting/types'
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission('advertising.edit')
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 403 })
  const { id } = await params
  const admin = createAdminClient()
  const { data: row } = await admin.from('ad_reports').select('status, render_data, review_status').eq('id', id).maybeSingle()
  if (!row || row.status !== 'ready' || !row.render_data || row.review_status === 'superseded') return NextResponse.json({ error: 'Only a complete current report can be approved.' }, { status: 409 })
  const problem = snapshotProblem(row.render_data as RenderData)
  if (problem) return NextResponse.json({ error: problem }, { status: 409 })
  const { error } = await admin.from('ad_reports').update({ review_status: 'approved', approved_by: guard.employeeId || null, approved_at: new Date().toISOString() }).eq('id', id).eq('status', 'ready').eq('review_status', 'unreviewed')
  return NextResponse.json(error ? { error: 'Could not approve report.' } : { ok: true }, { status: error ? 500 : 200 })
}

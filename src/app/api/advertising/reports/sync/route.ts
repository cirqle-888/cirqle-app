import { NextResponse } from 'next/server'
import { requirePermission } from '@/lib/permissions/check'
import { parseReportRequest, resolveScopeFor } from '@/lib/reporting/config'
import { createAdminClient } from '@/lib/supabase/server'
import { syncBeforeReport } from '@/lib/reporting/sync-before-report'
export const maxDuration = 60
export async function POST(req: Request) {
  const guard = await requirePermission('advertising.edit')
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 403 })
  const body = await req.json().catch(() => null)
  const parsed = parseReportRequest(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const scope = await resolveScopeFor(createAdminClient(), parsed.value, body?.clientId)
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: 400 })
  try {
    await syncBeforeReport({ ...parsed.value, clientId: scope.value.clientId }, crypto.randomUUID())
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Sync could not complete. Check the connection and sync log; the report has not been generated.' }, { status: 502 })
  }
}

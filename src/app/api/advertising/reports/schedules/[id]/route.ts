/**
 * PATCH  /api/advertising/reports/schedules/[id]  — update schedule
 * DELETE /api/advertising/reports/schedules/[id]  — deactivate schedule
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/permissions/check'
import { computeNextRun } from '@/lib/reporting/scheduler-utils'
import { parseScheduleFields } from '@/lib/reporting/config'

export const dynamic = 'force-dynamic'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const guard = await requirePermission('advertising.edit')
    if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 403 })

    const { id } = await params
    const body   = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
    const admin  = createAdminClient()

    const fields = parseScheduleFields(body, true)
    if (!fields.ok) return NextResponse.json({ error: fields.error }, { status: 400 })
    const updates: Record<string, any> = { ...fields.value }
    for (const key of ['cron_expression', 'include_comparison', 'is_active']) {
      if (key in body) updates[key] = body[key]
    }

    // Recompute next_run if anything that decides it changed
    if ('frequency' in updates || 'delivery_hour' in updates || 'delivery_timezone' in updates) {
      const { data: existing } = await admin.from('ad_report_schedules').select('frequency, delivery_hour, delivery_timezone').eq('id', id).maybeSingle()
      const freq = updates.frequency ?? existing?.frequency ?? 'weekly'
      const hour = updates.delivery_hour ?? existing?.delivery_hour ?? 7
      const tz   = updates.delivery_timezone ?? existing?.delivery_timezone ?? 'UTC'
      updates.next_run_at = computeNextRun(freq, hour, tz)
    }

    const { data, error } = await admin
      .from('ad_report_schedules')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const guard = await requirePermission('advertising.edit')
    if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 403 })

    const { id } = await params
    const admin  = createAdminClient()

    // Deactivate rather than hard-delete (preserve history)
    const { error } = await admin
      .from('ad_report_schedules')
      .update({ is_active: false })
      .eq('id', id)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

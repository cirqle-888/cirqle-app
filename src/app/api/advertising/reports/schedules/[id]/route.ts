/**
 * PATCH  /api/advertising/reports/schedules/[id]  — update schedule
 * DELETE /api/advertising/reports/schedules/[id]  — deactivate schedule
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { computeNextRun } from '@/lib/reporting/scheduler-utils'

export const dynamic = 'force-dynamic'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body   = await req.json()
    const admin  = createAdminClient()

    const updates: Record<string, any> = {}
    const allowed = [
      'frequency', 'cron_expression', 'delivery_hour', 'delivery_timezone',
      'report_type', 'template', 'formats', 'include_comparison', 'recipients', 'is_active',
    ]
    for (const key of allowed) {
      if (key in body) updates[key] = body[key]
    }

    // Recompute next_run if frequency or hour changed
    if ('frequency' in updates || 'delivery_hour' in updates) {
      const { data: existing } = await admin.from('ad_report_schedules').select('frequency, delivery_hour').eq('id', id).maybeSingle()
      const freq = updates.frequency ?? existing?.frequency ?? 'weekly'
      const hour = updates.delivery_hour ?? existing?.delivery_hour ?? 7
      updates.next_run_at = computeNextRun(freq, hour)
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

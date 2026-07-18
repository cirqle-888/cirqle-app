import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { logCronRun } from '@/lib/cron/log'

/**
 * Auto-archive finalised offer campaigns so old weekly offers age out of the
 * Requests inbox while staying in the database — searchable and restorable,
 * NEVER deleted. (Permanent deletion stays a manual admin-only action.)
 *
 * Archives campaigns where status='finalised' and completed_at is older than the
 * retention window. Retention defaults to 90 days; override via company_settings
 * key `offer_archive_retention_days` (a number of days, or 'never'/'0' to disable).
 *
 * Auth: same shared-secret pattern as the other crons — `Authorization: Bearer
 * <CRON_SECRET>`. Vercel Cron sends this automatically. Schedule in vercel.json.
 *
 *   GET /api/cron/archive-offers
 */

function authorized(req: NextRequest): boolean {
  const token = process.env.CRON_SECRET
  if (!token) return false // fail closed — never run unauthenticated
  return (req.headers.get('authorization') || '') === `Bearer ${token}`
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()

  const { data: settingRow } = await admin
    .from('company_settings').select('value').eq('key', 'offer_archive_retention_days').maybeSingle()
  const raw = (settingRow?.value || '90').trim().toLowerCase()

  if (raw === 'never' || raw === '0') {
    await logCronRun(admin, 'archive-offers', true, { archived: 0, note: 'retention disabled' })
    return NextResponse.json({ ok: true, archived: 0, note: 'retention disabled' })
  }

  const retentionDays = Math.max(1, parseInt(raw, 10) || 90)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - retentionDays)
  const cutoffIso = cutoff.toISOString()
  const now = new Date().toISOString()

  const { data: archived, error } = await admin
    .from('offer_campaigns')
    .update({ status: 'archived', archived_at: now, updated_at: now })
    .eq('status', 'finalised')
    .not('completed_at', 'is', null)
    .lt('completed_at', cutoffIso)
    .select('id')

  if (error) {
    await logCronRun(admin, 'archive-offers', false, undefined, error.message)
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  const count = archived?.length || 0
  await logCronRun(admin, 'archive-offers', true, { archived: count, retentionDays })
  return NextResponse.json({ ok: true, archived: count, retentionDays })
}

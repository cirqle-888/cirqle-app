import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { createNotification } from '@/lib/notifications/create'
import { logCronRun } from '@/lib/cron/log'

/**
 * Workspace reminders cron — fires a notification (which also web-pushes) for
 * any personal-workspace item whose remind_at has passed and hasn't fired yet.
 * Marks reminded_at so each reminder fires exactly once.
 *
 *   GET /api/cron/workspace-reminders
 *
 * Auth: shared CRON_SECRET bearer, same as the other crons. Schedule every
 * ~15 min (or hourly) so reminders land close to their time.
 */

function authorized(req: NextRequest): boolean {
  const token = process.env.CRON_SECRET
  if (!token) return false
  return (req.headers.get('authorization') || '') === `Bearer ${token}`
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const nowIso = new Date().toISOString()

  const { data: due, error } = await admin
    .from('workspace_items')
    .select('id, employee_id, title')
    .lte('remind_at', nowIso)
    .is('reminded_at', null)
    .not('remind_at', 'is', null)
    .eq('is_done', false)
    .limit(200)
  if (error) {
    // Table missing (021 not applied) or query error — log and exit cleanly.
    await logCronRun(admin, 'workspace-reminders', false, undefined, error.message)
    return NextResponse.json({ ok: false, error: error.message }, { status: 200 })
  }

  let fired = 0
  for (const item of due ?? []) {
    await createNotification({
      employeeId: item.employee_id,
      type: 'workspace_reminder',
      title: `⏰ Reminder: ${item.title}`,
      link: '/dashboard/workspace',
      sourceKey: `workspace_reminder:${item.id}`,
    })
    await admin.from('workspace_items').update({ reminded_at: nowIso }).eq('id', item.id)
    fired++
  }

  await logCronRun(admin, 'workspace-reminders', true, { fired })
  return NextResponse.json({ ok: true, fired })
}

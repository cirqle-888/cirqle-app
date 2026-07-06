import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createNotification, notifyAdmins } from '@/lib/notifications/create'
import { logCronRun } from '@/lib/cron/log'

/**
 * Daily interview reminder cron — notifies the assigned interviewer (or all
 * admins if none is assigned) about interviews scheduled in the next 24-48h.
 * Same shared-secret auth pattern as every other cron in this app.
 *
 *   GET /api/cron/interview-reminders
 *
 * Runs once daily (Vercel Hobby only supports daily-or-slower cron schedules).
 * Idempotent via application_interviews.reminder_sent_at — a reminder is sent
 * exactly once per interview, regardless of how many times this runs.
 */

function authorized(req: NextRequest): boolean {
  const token = process.env.CRON_SECRET
  if (!token) return false
  const header = req.headers.get('authorization') || ''
  return header === `Bearer ${token}`
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const now = new Date()
  const windowEnd = new Date(now.getTime() + 48 * 60 * 60 * 1000)

  const { data: interviews, error } = await admin
    .from('application_interviews')
    .select('id, application_id, scheduled_at, interviewer_id, meeting_link, application:application_id(full_name, reference_number)')
    .eq('status', 'scheduled')
    .is('reminder_sent_at', null)
    .gte('scheduled_at', now.toISOString())
    .lte('scheduled_at', windowEnd.toISOString())

  if (error) {
    await logCronRun(admin, 'interview-reminders', false, undefined, error.message)
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  type InterviewRow = {
    id: string; application_id: string; scheduled_at: string
    interviewer_id: string | null; meeting_link: string | null
    application: { full_name: string; reference_number: string } | { full_name: string; reference_number: string }[] | null
  }

  let notified = 0
  for (const row of (interviews ?? []) as InterviewRow[]) {
    const app = Array.isArray(row.application) ? row.application[0] : row.application
    const when = new Date(row.scheduled_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    const title = `Interview reminder — ${app?.full_name ?? 'candidate'}`
    const message = `${when}${row.meeting_link ? ' · ' + row.meeting_link : ''}`
    const link = `/dashboard/recruitment/applications/${row.application_id}`
    const sourceKey = `interview_reminder:${row.id}`

    if (row.interviewer_id) {
      void createNotification({ employeeId: row.interviewer_id, type: 'interview_reminder', title, message, link, sourceKey })
    } else {
      void notifyAdmins({ type: 'interview_reminder', title, message, link, sourceKey })
    }
    await admin.from('application_interviews').update({ reminder_sent_at: new Date().toISOString() }).eq('id', row.id)
    notified++
  }

  await logCronRun(admin, 'interview-reminders', true, { notified })
  return NextResponse.json({ ok: true, notified })
}

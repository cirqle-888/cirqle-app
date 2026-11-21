import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { logCronRun } from '@/lib/cron/log'
import { todayISO } from '@/lib/utils/local-date'
import { autopilotOn } from '@/lib/autopilot/switches'
import { loadAutopilotSettings, runAutopilot } from '@/lib/autopilot/run'

/**
 * The autopilot (07:00 IST): the daily jobs that do work by themselves, each
 * behind its own switch in Settings → Company → Automations. See
 * lib/autopilot/run.ts for the order and lib/autopilot/* for each job.
 *
 *   GET /api/cron/autopilot
 *
 * Auth: same shared-secret pattern as the other crons. Safe to re-run: every
 * job is idempotent and every notification carries an idempotency key.
 */
export const maxDuration = 300

function authorized(req: NextRequest): boolean {
  const token = process.env.CRON_SECRET
  if (!token) return false
  return (req.headers.get('authorization') || '') === `Bearer ${token}`
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  const today = todayISO()
  const settings = await loadAutopilotSettings(admin)
  const { summary, problems } = await runAutopilot(admin, today, (key) => autopilotOn(settings, key))
  const ok = problems.length === 0
  await logCronRun(admin, 'autopilot', ok, { today, ...summary }, ok ? undefined : problems.join('; ').slice(0, 500))
  return NextResponse.json({ ok, today, ...summary, ...(ok ? {} : { errors: problems }) }, { status: ok ? 200 : 500 })
}

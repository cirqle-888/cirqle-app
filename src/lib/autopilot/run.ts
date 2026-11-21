/**
 * The autopilot's daily run, in order. Each job is behind its own switch and
 * its own try/catch, so one failing job never stops the others.
 *
 * Cheap, time-critical jobs go first (posts due today reach designers before
 * the slow AI draft starts), the AI draft last: it can take a few minutes.
 */
import type { Admin } from '@/lib/mcp/shared'
import type { AutopilotKey } from './switches'
import { draftNextMonth, sendDuePosts } from './social'
import { payCheckJob } from './pay-check'
import { assignWaitingRequests } from './assign'
import { billingCheckJob } from './billing'
import { markPostedJob } from './posted'

export async function loadAutopilotSettings(admin: Admin): Promise<Record<string, string>> {
  const { data } = await admin.from('company_settings').select('key, value').like('key', 'autopilot_%')
  return Object.fromEntries(((data || []) as { key: string; value: string | null }[]).map(r => [r.key, r.value ?? '']))
}

type Job = { key: AutopilotKey; name: string; run: (admin: Admin, today: string) => Promise<unknown> }

const JOBS: Job[] = [
  { key: 'autopilot_send_planned_posts', name: 'sendPosts', run: sendDuePosts },
  // Right after sending: today's new requests reach a designer's My Work this morning.
  { key: 'autopilot_assign_requests', name: 'assignRequests', run: (admin, today) => assignWaitingRequests(admin, today) },
  // Before the pay and billing checks, so the tasks it makes are already counted there.
  { key: 'autopilot_mark_posted', name: 'markPosted', run: markPostedJob },
  { key: 'autopilot_contribution_check', name: 'payCheck', run: payCheckJob },
  { key: 'autopilot_billing', name: 'billing', run: billingCheckJob },
  { key: 'autopilot_monthly_drafts', name: 'monthDraft', run: (admin, today) => draftNextMonth(admin, today) },
]

export async function runAutopilot(admin: Admin, today: string, on: (key: AutopilotKey) => boolean) {
  const summary: Record<string, unknown> = {}
  const problems: string[] = []
  for (const job of JOBS) {
    if (!on(job.key)) { summary[job.name] = 'off'; continue }
    try {
      const r = await job.run(admin, today) as { ok?: boolean; error?: string }
      summary[job.name] = r
      if (r && r.ok === false) problems.push(`${job.name}: ${r.error}`)
    } catch (e) {
      problems.push(`${job.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { summary, problems }
}

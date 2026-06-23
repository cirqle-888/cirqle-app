/**
 * Cron run logger — every scheduled job calls this once, right before
 * returning its response, so the Business Health Center can show whether
 * each automation actually ran (and when it last succeeded/failed).
 *
 * Deliberately AWAITED (not fire-and-forget like lib/activity/log.ts) —
 * cron routes are short-lived serverless invocations, so a detached promise
 * could be killed before it lands. Still never throws: a logging failure
 * must not fail the cron's actual job.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export async function logCronRun(
  admin: SupabaseClient,
  cronName: string,
  ok: boolean,
  summary?: Record<string, unknown>,
  error?: string,
): Promise<void> {
  try {
    await admin.from('cron_runs').insert({
      cron_name: cronName,
      ok,
      summary: summary ?? null,
      error: error ?? null,
    })
  } catch (err) {
    console.warn('logCronRun failed:', err)
  }
}

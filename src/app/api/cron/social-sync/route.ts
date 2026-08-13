import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { syncSocialAccount } from '@/lib/integrations/meta/insights'
import { backfillFormLeads, syncLeadForms } from '@/lib/integrations/meta/leads'
import { evaluateMetaAlerts } from '@/lib/integrations/meta/alerts'
import { enqueueJob } from '@/lib/jobs/engine'
import { logCronRun } from '@/lib/cron/log'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Daily social sync — insights + media for every connected social account,
 * plus lead-form registry + lead backfill for Facebook Pages (the webhook is
 * the real-time path; this backfill covers missed deliveries — Meta only
 * retains leads for 90 days).
 *
 * Processes inline within the time budget; anything left over is enqueued as
 * system_jobs so process-jobs finishes the tail.
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const admin = createAdminClient()
  const startedAt = Date.now()
  const budgetMs = 240_000 // leave headroom under maxDuration

  let synced = 0
  let deferred = 0
  let leadsCreated = 0
  const errors: string[] = []

  try {
    const { data: accounts, error } = await admin
      .from('social_accounts')
      .select('id, platform, insights_enabled, status, last_synced_at')
      .neq('status', 'disconnected')
      .order('last_synced_at', { ascending: true, nullsFirst: true })

    if (error) throw error

    for (const account of accounts ?? []) {
      if (!account.insights_enabled) continue
      if (Date.now() - startedAt > budgetMs) {
        await enqueueJob({
          job_type: 'social_sync_account',
          payload: { account_id: account.id },
        })
        deferred++
        continue
      }
      try {
        const result = await syncSocialAccount(admin, account.id)
        synced++
        if (result.errors.length) errors.push(`${account.id}: ${result.errors[0]}`)

        // Lead backfill only makes sense on Pages (lead forms live on Pages).
        if (account.platform === 'facebook_page' && Date.now() - startedAt < budgetMs) {
          try {
            await syncLeadForms(admin, account.id)
            const { data: forms } = await admin
              .from('lead_forms')
              .select('external_form_id')
              .eq('social_account_id', account.id)
            for (const form of forms ?? []) {
              const res = await backfillFormLeads(admin, account.id, form.external_form_id)
              leadsCreated += res.created
            }
          } catch (leadErr: any) {
            errors.push(`${account.id} leads: ${leadErr?.message}`)
          }
        }
      } catch (err: any) {
        errors.push(`${account.id}: ${err?.message}`)
      }
    }

    // Performance alerts (high CPL, lead/reach drops, spend spikes, stale sync).
    let alerts = { evaluated: 0, triggered: 0 }
    try { alerts = await evaluateMetaAlerts(admin) } catch (e: any) { errors.push(`alerts: ${e?.message}`) }

    const summary = { synced, deferred, leadsCreated, alerts, errors: errors.slice(0, 10) }
    await logCronRun(admin, 'social-sync', errors.length === 0, summary)
    return NextResponse.json({ ok: true, ...summary })
  } catch (err: any) {
    await logCronRun(admin, 'social-sync', false, { synced, deferred }, err?.message)
    return NextResponse.json({ error: err?.message }, { status: 500 })
  }
}

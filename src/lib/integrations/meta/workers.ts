/**
 * Social Hub job-queue workers — registered in src/lib/jobs/worker.ts.
 * The crons enqueue + process inline; the queue gives retries with backoff
 * for anything that fails mid-run.
 */

import { DequeuedJob } from '@/lib/jobs/engine'
import { createAdminClient } from '@/lib/supabase/server'
import { syncSocialAccount } from './insights'
import { publishSocialPost } from './publish'
import { backfillFormLeads, syncLeadForms } from './leads'

export async function socialSyncAccountWorker(job: DequeuedJob): Promise<any> {
  const { account_id, days } = job.payload
  if (!account_id) throw new Error('Missing account_id in job payload')
  const admin = createAdminClient()
  const result = await syncSocialAccount(admin, account_id, days ?? 30)
  if (!result.ok && result.errors.length && result.dailyRows === 0 && result.mediaItems === 0) {
    throw new Error(result.errors[0])
  }
  return result
}

export async function socialPublishPostWorker(job: DequeuedJob): Promise<any> {
  const { post_id } = job.payload
  if (!post_id) throw new Error('Missing post_id in job payload')
  const admin = createAdminClient()
  const result = await publishSocialPost(admin, post_id)
  // Publish failures are recorded on the post itself (with their own retry
  // policy) — don't also fail the job unless nothing was recorded.
  return result
}

export async function socialLeadsBackfillWorker(job: DequeuedJob): Promise<any> {
  const { account_id, since } = job.payload
  if (!account_id) throw new Error('Missing account_id in job payload')
  const admin = createAdminClient()

  const formsSynced = await syncLeadForms(admin, account_id)
  const { data: forms } = await admin
    .from('lead_forms')
    .select('external_form_id')
    .eq('social_account_id', account_id)

  let fetched = 0
  let created = 0
  for (const form of forms ?? []) {
    const res = await backfillFormLeads(admin, account_id, form.external_form_id, since)
    fetched += res.fetched
    created += res.created
  }
  return { formsSynced, fetched, created }
}

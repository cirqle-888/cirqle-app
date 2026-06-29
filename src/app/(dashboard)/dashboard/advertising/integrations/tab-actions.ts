'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/auth/enforce'
import { PERMS } from '@/lib/permissions/keys'
import { enqueueJob } from '@/lib/jobs/engine'

export async function fetchSyncLogs(projectId: string) {
  const guard = await requirePermission(PERMS.ADVERTISING_VIEW)
  if (!guard.ok) throw new Error(guard.error)
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('ad_sync_logs')
    .select('*')
    .eq('project_id', projectId)
    .order('sync_date', { ascending: false })
    .limit(20)

  if (error) throw error
  return data
}

export async function triggerManualSync(projectId: string) {
  const guard = await requirePermission(PERMS.ADVERTISING_ENTER_METRICS)
  if (!guard.ok) throw new Error(guard.error)
  const admin = createAdminClient()

  await admin.from('ad_projects').update({ sync_status: 'queued' }).eq('id', projectId)

  await enqueueJob({
    job_type: 'advertising_sync_project',
    payload: { project_id: projectId },
    priority: 'high',
  })

  return { success: true }
}

export async function saveCampaignMapping(projectId: string, adAccountId: string, externalCampaignId: string) {
  const guard = await requirePermission(PERMS.ADVERTISING_ENTER_METRICS)
  if (!guard.ok) throw new Error(guard.error)
  const admin = createAdminClient()
  const { error } = await admin
    .from('ad_projects')
    .update({
      ad_account_id: adAccountId,
      external_campaign_id: externalCampaignId,
      provider_metadata: { campaign_id: externalCampaignId }
    })
    .eq('id', projectId)

  if (error) throw error
  return { success: true }
}

export async function fetchAdAccounts(connectionId: string) {
  const guard = await requirePermission(PERMS.ADVERTISING_VIEW)
  if (!guard.ok) throw new Error(guard.error)
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('ad_accounts')
    .select('id, name, account_id, currency, is_active')
    .eq('connection_id', connectionId)
    .order('name')

  if (error) throw error
  return data
}

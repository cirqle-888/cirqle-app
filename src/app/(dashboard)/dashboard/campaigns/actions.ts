'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { enforceAuth } from '@/lib/auth/enforce'
import { syncCampaignToSheet } from '@/lib/google-sheets/sync'
import { revalidatePath } from 'next/cache'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

export async function acknowledgeLogs(
  campaignId: string,
  logIds: string[],
): Promise<ActionResult> {
  const { employee } = await enforceAuth()
  if (!logIds.length) return { ok: true }

  const admin = createAdminClient()
  const { error } = await admin.from('offer_change_logs')
    .update({
      acknowledged: true,
      acknowledged_by: employee.id,
      acknowledged_at: new Date().toISOString(),
    })
    .in('id', logIds)
    .eq('campaign_id', campaignId)

  if (error) return { ok: false, error: 'Could not acknowledge logs.' }
  revalidatePath('/dashboard/campaigns')
  return { ok: true }
}

export async function finaliseCampaign(campaignId: string): Promise<ActionResult> {
  await enforceAuth()
  const admin = createAdminClient()
  const { error } = await admin.from('offer_campaigns')
    .update({ status: 'finalised', updated_at: new Date().toISOString() })
    .eq('id', campaignId)
  if (error) return { ok: false, error: 'Could not finalise.' }
  revalidatePath('/dashboard/campaigns')
  return { ok: true }
}

export async function archiveCampaign(campaignId: string): Promise<ActionResult> {
  await enforceAuth()
  const admin = createAdminClient()
  const { error } = await admin.from('offer_campaigns')
    .update({ status: 'archived', updated_at: new Date().toISOString() })
    .eq('id', campaignId)
  if (error) return { ok: false, error: 'Could not archive.' }
  revalidatePath('/dashboard/campaigns')
  return { ok: true }
}

export async function resyncSheet(campaignId: string, clientId: string): Promise<ActionResult> {
  await enforceAuth()
  const admin = createAdminClient()
  const result = await syncCampaignToSheet(admin, campaignId, clientId)
  if (!result.ok) {
    await admin.from('offer_campaigns')
      .update({ sheet_sync_error: result.error || 'Sync failed' })
      .eq('id', campaignId)
    return { ok: false, error: result.error }
  }
  revalidatePath('/dashboard/campaigns')
  return { ok: true }
}

export async function generateOfferLink(clientId: string): Promise<ActionResult<{ token: string }>> {
  await enforceAuth()
  const admin = createAdminClient()
  const { data } = await admin.from('clients')
    .select('offer_intake_token').eq('id', clientId).maybeSingle()
  if (!data?.offer_intake_token) return { ok: false, error: 'No intake token for this client.' }
  return { ok: true, data: { token: data.offer_intake_token } }
}

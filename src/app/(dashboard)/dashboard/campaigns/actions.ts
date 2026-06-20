'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin, resolveCurrentEmployeeId } from '@/lib/auth/enforce'
import { syncCampaignToSheet } from '@/lib/google-sheets/sync'
import { revalidatePath } from 'next/cache'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

export async function acknowledgeLogs(
  campaignId: string,
  logIds: string[],
): Promise<ActionResult> {
  const employeeId = await resolveCurrentEmployeeId()
  if (!employeeId) return { ok: false, error: 'Not signed in.' }
  if (!logIds.length) return { ok: true }

  const admin = createAdminClient()
  const { error } = await admin.from('offer_change_logs')
    .update({
      acknowledged: true,
      acknowledged_by: employeeId,
      acknowledged_at: new Date().toISOString(),
    })
    .in('id', logIds)
    .eq('campaign_id', campaignId)

  if (error) return { ok: false, error: 'Could not acknowledge logs.' }
  revalidatePath('/dashboard/campaigns')
  return { ok: true }
}

export async function finaliseCampaign(campaignId: string): Promise<ActionResult> {
  const guard = await requireAdmin()
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('offer_campaigns')
    .update({ status: 'finalised', updated_at: new Date().toISOString() })
    .eq('id', campaignId)
  if (error) return { ok: false, error: 'Could not finalise.' }
  revalidatePath('/dashboard/campaigns')
  return { ok: true }
}

export async function archiveCampaign(campaignId: string): Promise<ActionResult> {
  const guard = await requireAdmin()
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('offer_campaigns')
    .update({ status: 'archived', updated_at: new Date().toISOString() })
    .eq('id', campaignId)
  if (error) return { ok: false, error: 'Could not archive.' }
  revalidatePath('/dashboard/campaigns')
  return { ok: true }
}

export async function resyncSheet(campaignId: string, clientId: string): Promise<ActionResult> {
  const employeeId = await resolveCurrentEmployeeId()
  if (!employeeId) return { ok: false, error: 'Not signed in.' }
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
  const employeeId = await resolveCurrentEmployeeId()
  if (!employeeId) return { ok: false, error: 'Not signed in.' }
  const admin = createAdminClient()
  const { data } = await admin.from('clients')
    .select('offer_intake_token').eq('id', clientId).maybeSingle()
  if (!data?.offer_intake_token) return { ok: false, error: 'No intake token for this client.' }
  return { ok: true, data: { token: data.offer_intake_token } }
}

'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin, resolveCurrentEmployeeId } from '@/lib/permissions/check'
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
  const now = new Date().toISOString()

  // completed_at is what the auto-archive job ages against, and it must record
  // the FIRST finalisation — so read it and preserve any existing value rather
  // than overwriting on a re-finalise. One write, and its error is surfaced;
  // the previous two-step version returned ok:true even when the second write
  // (the one that actually flipped the status) failed.
  const { data: existing, error: readErr } = await admin.from('offer_campaigns')
    .select('completed_at').eq('id', campaignId).maybeSingle()
  if (readErr || !existing) return { ok: false, error: 'Campaign not found.' }

  const { error } = await admin.from('offer_campaigns')
    .update({ status: 'finalised', updated_at: now, completed_at: existing.completed_at ?? now })
    .eq('id', campaignId)
  if (error) return { ok: false, error: 'Could not finalise.' }
  revalidatePath('/dashboard/campaigns')
  return { ok: true }
}

export async function archiveCampaign(campaignId: string): Promise<ActionResult> {
  const guard = await requireAdmin()
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const now = new Date().toISOString()

  // Archiving straight from 'active' is a legitimate staff override, but it
  // skips the finalise step that normally stamps completed_at — and a NULL
  // completed_at on an archived row is a hole in the lifecycle (the retention
  // cron filters on it). Backfill it here so every archived campaign carries a
  // completion time regardless of the path it took.
  const { data: existing, error: readErr } = await admin.from('offer_campaigns')
    .select('completed_at').eq('id', campaignId).maybeSingle()
  if (readErr || !existing) return { ok: false, error: 'Campaign not found.' }

  const { error } = await admin.from('offer_campaigns')
    .update({
      status: 'archived',
      updated_at: now,
      archived_at: now,
      completed_at: existing.completed_at ?? now,
    })
    .eq('id', campaignId)
  if (error) return { ok: false, error: 'Could not archive.' }
  revalidatePath('/dashboard/campaigns')
  return { ok: true }
}

/**
 * Permanently delete a campaign and everything hanging off it.
 *
 * Archive is the normal way to retire a campaign — it keeps the products,
 * versions and history. This is for the other case: a draft built to try
 * something out, which should never have existed and should not sit in the
 * archive forever pretending to be a record of work.
 *
 * The row is the only thing deleted here because the schema does the rest:
 * offer_products, offer_change_logs and offer_campaign_revisions all declare
 * `on delete cascade` on campaign_id, and offer_product_badges cascades from
 * the products. Deleting the children by hand would risk a partial delete if
 * one statement failed halfway.
 *
 * Admin-only, like finalise and archive — and enforced HERE rather than by
 * hiding the button, because a Server Function is reachable by direct POST.
 *
 * Returns what was destroyed so the caller can say so plainly afterwards.
 */
export async function deleteCampaign(campaignId: string): Promise<ActionResult<{
  title: string | null
  clientName: string | null
  products: number
  logs: number
}>> {
  const guard = await requireAdmin()
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()

  // Read the shape of what is about to go, before it goes. This is also the
  // existence check: a missing campaign must not report a successful delete.
  const { data: existing, error: readErr } = await admin.from('offer_campaigns')
    .select('id, title, client:clients(name)')
    .eq('id', campaignId)
    .maybeSingle()
  if (readErr || !existing) return { ok: false, error: 'Campaign not found.' }

  const [{ count: products }, { count: logs }] = await Promise.all([
    admin.from('offer_products').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId),
    admin.from('offer_change_logs').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId),
  ])

  const { error } = await admin.from('offer_campaigns').delete().eq('id', campaignId)
  if (error) return { ok: false, error: 'Could not delete the campaign.' }

  revalidatePath('/dashboard/campaigns')
  revalidatePath('/dashboard/requests')
  return {
    ok: true,
    data: {
      title: existing.title ?? null,
      clientName: (existing as { client?: { name?: string } | null }).client?.name ?? null,
      products: products ?? 0,
      logs: logs ?? 0,
    },
  }
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

/**
 * Hands back the client's offer intake token. That token IS an unauthenticated
 * capability URL — anyone holding it can read and rewrite that client's offers
 * without signing in — so this is admin-only, matching finalise/archive rather
 * than the weaker signed-in-employee check it used to carry.
 */
export async function generateOfferLink(clientId: string): Promise<ActionResult<{ token: string }>> {
  const guard = await requireAdmin()
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { data } = await admin.from('clients')
    .select('offer_intake_token').eq('id', clientId).maybeSingle()
  if (!data?.offer_intake_token) return { ok: false, error: 'No intake token for this client.' }
  return { ok: true, data: { token: data.offer_intake_token } }
}

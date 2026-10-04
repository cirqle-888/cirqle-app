'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin, resolveCurrentEmployeeId, requirePermission, loadCurrentUser } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logCampaignEvent } from '@/lib/offer-events'
import { saveCampaign, type CampaignInput, type ProductInput } from '@/lib/offers/save-campaign'
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

// ── Moved from the retired Offer Prepare page (Oct 2026) ──────────────────────
// The Requests inbox's campaign card still uses these. Sheet re-sync and the
// client's offer-intake link went with the old flow; offers now arrive from
// Offer Studio through /api/figma/campaign.

/**
 * Hand a sheet-imported campaign over to Cirqle so it can be edited normally.
 *
 * Deliberately explicit: after this the campaign no longer tracks the client's
 * sheet, and a later pull will refuse to touch it rather than overwrite the
 * edits.
 */
export async function convertSheetCampaign(campaignId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.OFFER_PREPARE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('offer_campaigns')
    .update({ source: 'cirqle', updated_at: new Date().toISOString() })
    .eq('id', campaignId)
    .eq('source', 'sheet_import')
    .select('id')
    .maybeSingle()

  if (error || !data) return { ok: false, error: 'Could not convert this offer (it may already be a Cirqle offer).' }

  await admin.from('offer_change_logs').insert({
    campaign_id: campaignId,
    log_type: 'client_note',
    note: 'Converted from a sheet import to a Cirqle offer — it no longer tracks the client’s sheet.',
  }).then(undefined, () => {})

  revalidatePath('/dashboard/campaigns')
  return { ok: true }
}

// ── Version history (feature_offer_revisions; admin-only) ────────────────────

export interface RevisionMeta {
  id: string
  revision_no: number
  actor_kind: string
  note: string | null
  created_at: string
  product_count: number
}

export async function listCampaignRevisions(
  campaignId: string,
): Promise<ActionResult<{ revisions: RevisionMeta[] }>> {
  const me = await loadCurrentUser().catch(() => null)
  if (!me?.isAdmin) return { ok: false, error: 'Admins only.' }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('offer_campaign_revisions')
    .select('id, revision_no, actor_kind, note, created_at, snapshot')
    .eq('campaign_id', campaignId)
    .order('revision_no', { ascending: false })
    .limit(30)
  if (error) return { ok: false, error: error.message }

  type Row = { id: string; revision_no: number; actor_kind: string; note: string | null; created_at: string; snapshot: { products?: unknown[] } | null }
  return {
    ok: true,
    data: {
      revisions: ((data as Row[] | null) || []).map(r => ({
        id: r.id,
        revision_no: r.revision_no,
        actor_kind: r.actor_kind,
        note: r.note,
        created_at: r.created_at,
        product_count: Array.isArray(r.snapshot?.products) ? r.snapshot!.products!.length : 0,
      })),
    },
  }
}

/**
 * Restore a previous revision — ALWAYS reversible:
 *  1. snapshot the CURRENT campaign state as a new revision
 *     (actor 'restore', "Backup before restoring revision N"), then
 *  2. replay the selected snapshot through saveCampaign, so change logs,
 *     catalog mirroring, sheet sync — and the restored-state revision —
 *     all fire exactly as a normal save would.
 * The pre-restore state is therefore always the revision immediately before
 * the restore, with zero extra user interaction.
 */
export async function restoreCampaignRevision(
  campaignId: string,
  revisionId: string,
): Promise<ActionResult> {
  const me = await loadCurrentUser().catch(() => null)
  if (!me?.isAdmin) return { ok: false, error: 'Admins only.' }

  const admin = createAdminClient()

  // Restoring onto a design-locked campaign would fight the designer —
  // unlock first (the card offers Unlock right next to Versions).
  {
    const { data: lockRow } = await admin
      .from('offer_campaigns')
      .select('design_locked_at')
      .eq('id', campaignId)
      .maybeSingle()
    if ((lockRow as { design_locked_at?: string | null } | null)?.design_locked_at) {
      return { ok: false, error: 'This offer is marked as designed — unlock it first, then restore.' }
    }
  }

  const { data: revRow } = await admin
    .from('offer_campaign_revisions')
    .select('id, revision_no, snapshot')
    .eq('id', revisionId)
    .eq('campaign_id', campaignId)
    .maybeSingle()
  const revision = revRow as { id: string; revision_no: number; snapshot: CampaignInput } | null
  if (!revision?.snapshot?.products) return { ok: false, error: 'Revision not found.' }

  const { data: campRow } = await admin
    .from('offer_campaigns')
    .select('id, client_id, title, date_type, offer_date, offer_date_from, offer_date_to, products:offer_products(*, badges:offer_product_badges(badge_id, custom_label, color, display_order))')
    .eq('id', campaignId)
    .maybeSingle()
  type ProdRow = {
    id: string; catalog_id: string | null; group_id: string | null; name: string
    weight: string | null; image_url: string | null; offer_type: ProductInput['offer_type']
    price: number | null; mrp: number | null; offer_text: string | null
    page: number | null; display_order: number | null
    badges: { badge_id: string | null; custom_label: string | null; color: string | null; display_order: number | null }[] | null
  }
  const camp = campRow as {
    id: string; client_id: string; title: string | null; date_type: 'single' | 'range'
    offer_date: string | null; offer_date_from: string | null; offer_date_to: string | null
    products: ProdRow[] | null
  } | null
  if (!camp) return { ok: false, error: 'Campaign not found.' }

  const { data: clientRow } = await admin
    .from('clients')
    .select('offer_intake_token')
    .eq('id', camp.client_id)
    .maybeSingle()
  const token = (clientRow as { offer_intake_token?: string | null } | null)?.offer_intake_token
  if (!token) return { ok: false, error: 'This client has no intake token — cannot restore.' }

  // 1. Automatic backup of the CURRENT state.
  const { data: lastRev } = await admin
    .from('offer_campaign_revisions')
    .select('revision_no')
    .eq('campaign_id', campaignId)
    .order('revision_no', { ascending: false })
    .limit(1)
    .maybeSingle()
  const backupNo = (((lastRev as { revision_no?: number } | null)?.revision_no) ?? 0) + 1
  const currentSnapshot: CampaignInput = {
    title: camp.title ?? undefined,
    date_type: camp.date_type || 'single',
    offer_date: camp.offer_date ?? undefined,
    offer_date_from: camp.offer_date_from ?? undefined,
    offer_date_to: camp.offer_date_to ?? undefined,
    products: (camp.products || [])
      .slice()
      .sort((a, b) => (a.page || 1) - (b.page || 1) || (a.display_order || 0) - (b.display_order || 0))
      .map((p, i) => ({
        catalog_id: p.catalog_id || undefined,
        group_id: p.group_id ?? null,
        name: p.name,
        weight: p.weight || undefined,
        image_url: p.image_url || undefined,
        offer_type: p.offer_type || 'price',
        price: p.price ?? null,
        mrp: p.mrp ?? null,
        offer_text: p.offer_text || undefined,
        badges: (p.badges || [])
          .slice()
          .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
          .map(b => ({ badge_id: b.badge_id, custom_label: b.custom_label, color: b.color || 'amber' })),
        page: p.page || 1,
        display_order: i,
      })),
  }
  const { error: backupErr } = await admin.from('offer_campaign_revisions').insert({
    campaign_id: campaignId,
    revision_no: backupNo,
    snapshot: currentSnapshot,
    actor_kind: 'restore',
    actor_id: me.employeeId,
    note: `Backup before restoring revision ${revision.revision_no}`,
  })
  if (backupErr) return { ok: false, error: `Could not back up the current state (${backupErr.message}) — restore aborted.` }

  // 2. Replay the selected snapshot through the normal save path.
  const result = await saveCampaign(token, revision.snapshot, campaignId, { actor: 'staff' })
  if (!result.ok) return { ok: false, error: result.error || 'Restore failed.' }

  void logCampaignEvent(admin, campaignId, `Revision ${revision.revision_no} restored by admin ${me.cqid || ''} (backup saved as revision ${backupNo}).`.replace('  ', ' '))
  revalidatePath('/dashboard/requests')
  return { ok: true }
}

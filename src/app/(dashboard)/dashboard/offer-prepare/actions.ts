'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission, loadCurrentUser } from '@/lib/permissions/check'
import { logCampaignEvent } from '@/lib/offer-events'
import { PERMS } from '@/lib/permissions/keys'
import { extractSheetId } from '@/lib/google-sheets/routing'
import { fetchSheetTabCsv, parseSheetCsv, type PulledRow } from '@/lib/google-sheets/pull'
import { saveCampaign, type CampaignInput, type ProductInput } from '@/app/intake/offer/[token]/actions'
import { revalidatePath } from 'next/cache'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

/**
 * Import a sheet-managed client's own Google Sheet into a campaign snapshot.
 *
 * Strictly one-way. The client's master sheet feeds their designer sheets
 * through IMPORTRANGE and a photo automation, so Cirqle reads it and never
 * writes to it; the resulting campaign is marked source='sheet_import' and is
 * read-only in the editor until someone explicitly converts it.
 *
 * Each offer category (group) names the tab it reads from, so a client with
 * "Groceries" and "Vegetables" tabs lands as one campaign split across two
 * groups — which is exactly how their two Figma files consume it.
 */
export async function pullFromClientSheet(
  clientId: string,
): Promise<ActionResult<{ campaignId: string; imported: number }>> {
  const guard = await requirePermission(PERMS.OFFER_PREPARE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()

  const { data: client } = await admin
    .from('clients')
    .select('id, name, offer_flow_mode, offer_master_sheet_url, offer_master_sheet_id')
    .eq('id', clientId)
    .maybeSingle()
  if (!client) return { ok: false, error: 'Client not found.' }

  const sheetId = client.offer_master_sheet_id || extractSheetId(client.offer_master_sheet_url)
  if (!sheetId) {
    return { ok: false, error: `No master Google Sheet is linked for ${client.name}. Add it in Offer Intake settings.` }
  }

  const { data: groupRows } = await admin
    .from('client_offer_groups')
    .select('id, name, master_tab_name')
    .eq('client_id', clientId)
    .eq('is_active', true)
    .is('parent_id', null)
    .order('display_order')

  // With no groups configured, read the sheet's first tab into the default
  // (ungrouped) bucket — the same shape a single-category client already has.
  const groups = (groupRows || []).length
    ? (groupRows as { id: string; name: string; master_tab_name: string | null }[])
    : [{ id: null as unknown as string, name: 'Offers', master_tab_name: null }]

  // ── Read every tab first, so a failure part-way leaves nothing half-written
  const byGroup: { groupId: string | null; name: string; rows: PulledRow[] }[] = []
  for (const group of groups) {
    let csv: string
    try {
      csv = await fetchSheetTabCsv(sheetId, group.master_tab_name)
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error'
      return { ok: false, error: `Could not read the “${group.master_tab_name || group.name}” tab: ${detail}` }
    }
    const rows = parseSheetCsv(csv)
    if (!rows.length) {
      return { ok: false, error: `No products found in the “${group.master_tab_name || group.name}” tab. It needs a header row with a product/item column.` }
    }
    byGroup.push({ groupId: group.id ?? null, name: group.name, rows })
  }

  const now = new Date().toISOString()

  // ── Find or create the campaign to hold this snapshot
  const { data: active } = await admin
    .from('offer_campaigns')
    .select('id, source')
    .eq('client_id', clientId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  // A staff member's in-progress Cirqle offer must never be silently finalised
  // by an import. Refuse and let them decide, rather than reusing saveCampaign's
  // "finalise everything active" invariant, which is right for a new week's
  // offer but wrong here.
  if (active && active.source !== 'sheet_import') {
    return {
      ok: false,
      error: `${client.name} has an active Cirqle offer in progress. Finalise or cancel it before pulling from the sheet.`,
    }
  }

  let campaignId = active?.id as string | undefined

  if (!campaignId) {
    const { data: created, error: createErr } = await admin
      .from('offer_campaigns')
      .insert({
        client_id: clientId,
        date_type: 'single',
        offer_date: now.slice(0, 10),
        source: 'sheet_import',
      })
      .select('id')
      .single()
    if (createErr || !created) return { ok: false, error: 'Could not create the offer snapshot.' }
    campaignId = created.id
  }

  // ── Replace the products wholesale.
  // A pull is a mirror of the sheet, not a merge: a row deleted upstream must
  // disappear here too. Change-log entries record the shape of the update so
  // staff can still see what moved week to week.
  const { data: previous } = await admin
    .from('offer_products')
    .select('id, name, price')
    .eq('campaign_id', campaignId)

  const { error: wipeErr } = await admin.from('offer_products').delete().eq('campaign_id', campaignId)
  if (wipeErr) return { ok: false, error: 'Could not refresh the offer snapshot.' }

  let order = 0
  const payload = byGroup.flatMap(group =>
    group.rows.map(row => ({
      campaign_id: campaignId,
      group_id: group.groupId,
      name: row.name,
      weight: row.weight,
      price: row.price,
      mrp: row.mrp,
      offer_type: 'price',
      page: 1,
      display_order: order++,
      updated_at: now,
    })),
  )

  const { error: insertErr } = await admin.from('offer_products').insert(payload)
  if (insertErr) return { ok: false, error: 'Could not write the imported products.' }

  await admin.from('offer_campaigns')
    .update({ updated_at: now, source: 'sheet_import' })
    .eq('id', campaignId)

  const summary = byGroup.map(g => `${g.name}: ${g.rows.length}`).join(', ')
  await admin.from('offer_change_logs').insert({
    campaign_id: campaignId,
    log_type: 'client_note',
    note: `Imported from the client's Google Sheet (${summary}). Previously ${previous?.length ?? 0} products.`,
  }).then(undefined, () => {})

  // Stamp only the groups that actually have a tab of their own.
  const realGroupIds = byGroup.map(g => g.groupId).filter(Boolean) as string[]
  if (realGroupIds.length) {
    await admin.from('client_offer_groups').update({ last_pulled_at: now }).in('id', realGroupIds)
  }

  revalidatePath('/dashboard/offer-prepare')
  revalidatePath('/dashboard/requests')
  return { ok: true, data: { campaignId: campaignId!, imported: payload.length } }
}

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
  revalidatePath('/dashboard/offer-prepare')
  return { ok: true }
}

/**
 * Admin unlock for a design-locked campaign ("Mark as Designed" past its
 * self-undo window). Clears the lock and leaves a timeline entry; the
 * unlocking admin is identified by CQID only (privacy rule).
 */
export async function unlockCampaignDesign(campaignId: string): Promise<ActionResult> {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) return { ok: false, error: 'Not signed in.' }
  if (!me.isAdmin) return { ok: false, error: 'Only an admin can unlock a designed offer.' }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('offer_campaigns')
    .update({ design_locked_at: null, design_locked_by: null })
    .eq('id', campaignId)
    .not('design_locked_at', 'is', null)
    .select('id')
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: true } // already unlocked — nothing to do

  const cqid = (me as { cqid?: string | null }).cqid || null
  void logCampaignEvent(admin, campaignId, `Design lock removed by admin${cqid ? ` ${cqid}` : ''} — the offer is editable again.`)

  revalidatePath('/dashboard/requests')
  revalidatePath('/dashboard/offer-prepare')
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

'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/auth/enforce'
import { PERMS } from '@/lib/permissions/keys'
import { extractSheetId } from '@/lib/google-sheets/routing'
import { fetchSheetTabCsv, parseSheetCsv, type PulledRow } from '@/lib/google-sheets/pull'
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

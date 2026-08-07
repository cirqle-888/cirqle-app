'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { syncCampaignToSheet } from '@/lib/google-sheets/sync'
import { safePublicFetch, BlockedHostError } from '@/lib/safe-fetch'
import { aiParseOfferProducts, type ParsedOfferProduct } from '@/lib/ai/offer-capture'
import { getMergedClientCatalog, mirrorProductToGlobalCatalog } from '@/lib/offer-catalog'
import { logCampaignEvent } from '@/lib/offer-events'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

// ── Token resolution ──────────────────────────────────────────────────────────

async function resolveOfferToken(token: string) {
  if (!token || token.length < 16) return null
  try {
    const admin = createAdminClient()
    const base = 'id, name, offer_sheet_webhook_url, offer_intake_token'
    // `region` decides which shared products this client is offered. Retried
    // without it so a deploy landing before migration 20260722060000 still
    // opens the offer form instead of showing every client an invalid link.
    const withRegion = await admin
      .from('clients').select(`${base}, region`)
      .eq('offer_intake_token', token).eq('is_active', true).maybeSingle()
    if (!withRegion.error) return withRegion.data || null

    const { data } = await admin
      .from('clients')
      .select(base)
      .eq('offer_intake_token', token)
      .eq('is_active', true)
      .maybeSingle()
    return data || null
  } catch { return null }
}

// ── Load campaign data for client ─────────────────────────────────────────────

export interface OfferGroupOption {
  id: string
  name: string
  display_order: number
}

/**
 * A client's configured offer categories, newest schema first.
 *
 * Swallows a missing table so a code deploy landing before the migration is
 * applied simply shows the pre-categories editor rather than erroring.
 */
async function loadGroupOptions(
  admin: ReturnType<typeof createAdminClient>,
  clientId: string,
): Promise<OfferGroupOption[]> {
  try {
    const { data, error } = await admin
      .from('client_offer_groups')
      .select('id, name, display_order')
      .eq('client_id', clientId)
      .eq('is_active', true)
      .is('parent_id', null)
      .order('display_order')
    if (error) return []
    return (data || []) as OfferGroupOption[]
  } catch {
    return []
  }
}

export async function getOfferPageData(token: string): Promise<ActionResult<{
  client: { id: string; name: string }
  campaign: any | null
  catalog: any[]
  badges: any[]
  groups: OfferGroupOption[]
  sheetManaged: boolean
  designLocked: boolean
  logoUrl: string | null
  logoDarkUrl: string | null
}>> {
  const client = await resolveOfferToken(token)
  if (!client) return { ok: false, error: 'This link is no longer valid.' }

  const admin = createAdminClient()

  const [campaignRes, badgesRes, logoRes, logoDarkRes, groups, catalogWithImages] = await Promise.all([
    // Most recent active campaign for this client
    admin.from('offer_campaigns')
      .select('*, products:offer_products(*, badges:offer_product_badges(id, badge_id, custom_label, color, display_order, badge:offer_badges(label, color)))')
      .eq('client_id', client.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin.from('offer_badges')
      .select('*')
      .eq('is_active', true)
      .order('display_order'),
    admin.from('company_settings').select('value').eq('key', 'logo_url').maybeSingle(),
    admin.from('company_settings').select('value').eq('key', 'logo_url_dark').maybeSingle(),
    loadGroupOptions(admin, client.id),
    // Own catalog + region-scoped shared library + image history — the ONE
    // shared implementation (also behind /api/figma/catalog). See
    // src/lib/offer-catalog.ts for the merge rules.
    getMergedClientCatalog(admin, client),
  ])

  return {
    ok: true,
    data: {
      client: { id: client.id, name: client.name },
      campaign: campaignRes.data || null,
      catalog: catalogWithImages,
      badges: badgesRes.data || [],
      groups,
      // Snapshots of a client-owned sheet are read-only here: the next pull
      // would overwrite anything typed, so the editor disables saving.
      sheetManaged: campaignRes.data?.source === 'sheet_import',
      // Designer pressed "Mark as Designed" in Cirqle Studio — client/staff
      // edits are refused until an admin unlocks (or the designer self-undoes
      // within the window). Absent pre-migration → simply false.
      designLocked: !!campaignRes.data?.design_locked_at,
      logoUrl: logoRes.data?.value || null,
      logoDarkUrl: logoDarkRes.data?.value || null,
    },
  }
}

// ── Save / update campaign ────────────────────────────────────────────────────

export interface ProductBadgeInput {
  badge_id?: string | null    // predefined offer_badges.id, or...
  custom_label?: string | null // ...a free-text label when badge_id is absent
  color: string
}

export interface ProductInput {
  id?: string           // existing offer_products.id (if updating)
  catalog_id?: string   // link back to catalog
  group_id?: string | null // which offer category (flyer stream) this belongs to; null = default
  name: string
  weight?: string
  image_url?: string
  offer_type: 'price' | 'percent' | 'bogo' | 'other'
  price?: number | null
  mrp?: number | null
  offer_text?: string
  badges?: ProductBadgeInput[]
  page?: number          // which page of a multi-page offer this product belongs to (1-based)
  display_order: number
}

export interface CampaignInput {
  title?: string
  date_type: 'single' | 'range'
  offer_date?: string
  offer_date_from?: string
  offer_date_to?: string
  client_note?: string
  products: ProductInput[]
}

/**
 * A save failure that can actually be diagnosed.
 *
 * The six DB steps inside saveCampaign each used to return the same blind
 * "Could not save the offer. Please try again." and log nothing — so an
 * intermittent failure on a 22-product list (~130 sequential round-trips) left
 * no trace of WHICH row or WHICH step broke, or what Postgres actually said.
 *
 * This logs the real error server-side with context, and returns a message
 * that still reassures the client but names the step for staff reading it back.
 */
function saveFailed(
  step: string,
  err: { message?: string; code?: string; details?: string } | null,
  ctx?: { product?: string; index?: number; total?: number },
): ActionResult<never> {
  const where = ctx?.product ? ` [${ctx.index}/${ctx.total}: ${ctx.product}]` : ''
  console.error(
    `[saveCampaign] ${step} failed${where}: ${err?.code || ''} ${err?.message || 'unknown'}` +
    (err?.details ? ` — ${err.details}` : ''),
  )
  return {
    ok: false,
    error: `Could not save the offer (step: ${step}). Please try again — if it keeps happening, tell the Cirqle team which product it stopped on.`,
  }
}

export async function saveCampaign(
  token: string,
  input: CampaignInput,
  campaignId?: string,
  /** Who is saving — decides whether a design-locked campaign refuses the
   * write ('figma' passes; 'client'/'staff' are refused). Defaults to
   * 'client', the public entrance. */
  opts?: { actor?: 'client' | 'staff' | 'figma' },
): Promise<ActionResult<{ campaignId: string; productIds: (string | null)[] }>> {
  const client = await resolveOfferToken(token)
  if (!client) return { ok: false, error: 'This link is no longer valid.' }

  const admin = createAdminClient()
  const now = new Date().toISOString()

  // Predefined badge labels, for resolving badge_id → display text in the
  // change log (custom badges already carry their own label).
  const { data: badgeRowsForLabels } = await admin.from('offer_badges').select('id, label')
  const badgeLabelMap = new Map((badgeRowsForLabels || []).map((b: any) => [b.id, b.label]))

  // ── Upsert campaign header ────────────────────────────────────────────────
  let campaign: any
  let previousCampaign: any = null
  if (campaignId) {
    // Verify ownership
    const { data: existing } = await admin.from('offer_campaigns')
      .select('id, client_id, title, date_type, offer_date, offer_date_from, offer_date_to, source')
      .eq('id', campaignId).maybeSingle()
    if (!existing || existing.client_id !== client.id)
      return { ok: false, error: 'Campaign not found.' }
    // A sheet_import campaign mirrors a sheet the client maintains themselves.
    // Accepting edits here would look like they saved, then silently lose them
    // on the next pull — so refuse and point at the conversion instead.
    if (existing.source === 'sheet_import') {
      return { ok: false, error: 'This offer is managed from the client’s own Google Sheet, so it can’t be edited here. Convert it to a Cirqle offer first if you need to change it in Cirqle.' }
    }
    // Design lock: after "Mark as Designed" only the Figma side may save
    // (designer touch-ups); client/staff edits are refused so they can't
    // silently diverge from the artwork. Queried separately + tolerantly so a
    // deploy landing before the design-lock migration still saves normally.
    if (opts?.actor !== 'figma') {
      const { data: lockRow } = await admin
        .from('offer_campaigns')
        .select('design_locked_at')
        .eq('id', campaignId)
        .maybeSingle()
      if ((lockRow as { design_locked_at?: string | null } | null)?.design_locked_at) {
        return { ok: false, error: 'This offer is with the designer now, so it can’t be changed here. Contact the Cirqle team if something must change.' }
      }
    }
    previousCampaign = existing

    const { data, error } = await admin.from('offer_campaigns')
      .update({
        title: input.title?.trim() || null,
        date_type: input.date_type,
        offer_date: input.date_type === 'single' ? input.offer_date || null : null,
        offer_date_from: input.date_type === 'range' ? input.offer_date_from || null : null,
        offer_date_to: input.date_type === 'range' ? input.offer_date_to || null : null,
        updated_at: now,
      })
      .eq('id', campaignId)
      .select('*').single()
    if (error || !data) return { ok: false, error: 'Could not update campaign.' }
    campaign = data
  } else {
    // One active campaign per client: finalise ALL of the client's currently
    // active campaigns BEFORE creating the new one, so the new weekly offer
    // becomes the sole active offer. Doing it first (rather than excluding the
    // new id afterwards) means there's never a moment with two active rows, and
    // it also cleans up any pre-existing extra actives. If this fails we abort
    // rather than risk a second active campaign — the invariant is the point.
    // completed_at is stamped only where still null (preserves an earlier
    // completion time). (A DB partial-unique index isn't used because existing
    // data may already have multiple actives, which would fail the migration.)
    const { error: finErr } = await admin.from('offer_campaigns')
      .update({ status: 'finalised', completed_at: now })
      .eq('client_id', client.id)
      .eq('status', 'active')
      .is('completed_at', null)
    if (finErr) return { ok: false, error: 'Could not close the previous offer. Please try again.' }
    // Anomaly guard: any active row that somehow already carried a completed_at.
    await admin.from('offer_campaigns')
      .update({ status: 'finalised' })
      .eq('client_id', client.id)
      .eq('status', 'active')

    const { data, error } = await admin.from('offer_campaigns')
      .insert({
        client_id: client.id,
        title: input.title?.trim() || null,
        date_type: input.date_type,
        offer_date: input.date_type === 'single' ? input.offer_date || null : null,
        offer_date_from: input.date_type === 'range' ? input.offer_date_from || null : null,
        offer_date_to: input.date_type === 'range' ? input.offer_date_to || null : null,
      })
      .select('*').single()
    if (error || !data) return { ok: false, error: 'Could not create campaign.' }
    campaign = data
  }

  // ── Load previous products for diff ──────────────────────────────────────
  const { data: prevProducts } = await admin.from('offer_products')
    .select('*, _badges:offer_product_badges(badge_id, custom_label, badge:offer_badges(label))')
    .eq('campaign_id', campaign.id)
  const prevMap = new Map((prevProducts || []).map((p: any) => [
    p.id,
    { ...p, _badgeLabels: badgeLabelsOf(p._badges) },
  ]))
  const newIds = new Set(input.products.filter(p => p.id).map(p => p.id!))

  // ── Delete removed products ───────────────────────────────────────────────
  const removedProducts = (prevProducts || []).filter((p: any) => !newIds.has(p.id))
  for (const p of removedProducts) {
    const { error: delErr } = await admin.from('offer_products').delete().eq('id', p.id)
    if (delErr) return saveFailed('delete-removed', delErr, { product: p.name })
    await admin.from('offer_change_logs').insert({
      campaign_id: campaign.id,
      log_type: 'product_removed',
      product_name: p.name,
      product_id: p.id,
    })
  }

  // ── Upsert current products + diff log ───────────────────────────────────
  const changeLogs: any[] = []
  // The row id each input product ended up with, positionally aligned with
  // input.products. Returned to the client so the NEXT save can address these
  // rows by id — without it every re-save looked like "all products removed,
  // all products re-added", churning ids and filling the change log (the thing
  // staff read to see what the client actually altered) with pure noise.
  const productIds: (string | null)[] = []

  // offer_products.catalog_id has a FK to client_product_catalog. Since the
  // picker started also offering SHARED catalog products (product_catalog),
  // a picked shared product arrives with a product_catalog id here — a value
  // that is NOT a client_product_catalog row, so the insert blew up with a
  // 23503 FK violation and failed the whole save (only when the offer happened
  // to include a matched shared product, which is why it looked intermittent).
  //
  // Resolve it once, up front: keep catalog_id only where it is a real
  // client_product_catalog row for THIS client; null the rest. The by-name
  // sync below then creates/links the client's own row, so nothing is lost.
  const candidateCatalogIds = [...new Set(
    input.products.map(p => p.catalog_id).filter((v): v is string => !!v),
  )]
  const validClientCatalogIds = new Set<string>()
  if (candidateCatalogIds.length) {
    const { data: ownRows } = await admin
      .from('client_product_catalog')
      .select('id')
      .eq('client_id', client.id)
      .in('id', candidateCatalogIds)
    for (const r of ownRows || []) validClientCatalogIds.add((r as { id: string }).id)
  }

  for (let pIdx = 0; pIdx < input.products.length; pIdx++) {
    const p = input.products[pIdx]
    const pctx = { product: p.name, index: pIdx + 1, total: input.products.length }
    const safeCatalogId = p.catalog_id && validClientCatalogIds.has(p.catalog_id) ? p.catalog_id : null
    const payload = {
      campaign_id: campaign.id,
      catalog_id: safeCatalogId,
      group_id: p.group_id || null,
      name: p.name.trim(),
      weight: p.weight?.trim() || null,
      image_url: p.image_url || null,
      offer_type: p.offer_type,
      price: p.price ?? null,
      mrp: p.mrp ?? null,
      offer_text: p.offer_text?.trim() || null,
      page: p.page && p.page > 0 ? p.page : 1,
      display_order: p.display_order,
      updated_at: now,
    }

    let productId = p.id

    if (p.id && prevMap.has(p.id)) {
      // Update existing — diff every meaningful field
      const prev = prevMap.get(p.id)
      const { error: updErr } = await admin.from('offer_products').update(payload).eq('id', p.id)
      // Previously discarded — a failed update returned ok:true and the editor
      // showed "Saved ✓" over data that never reached the database.
      if (updErr) return saveFailed('update-product', updErr, pctx)

      const DIFF_FIELDS: [string, string][] = [
        ['name', 'Product name'],
        ['weight', 'Weight'],
        ['offer_type', 'Offer type'],
        ['price', 'Price'],
        ['mrp', 'MRP'],
        ['offer_text', 'Offer text'],
        ['page', 'Page'],
        ['group_id', 'Category'],
      ]
      for (const [field, label] of DIFF_FIELDS) {
        const oldVal = String(prev[field] ?? '')
        const newVal = String((payload as any)[field] ?? '')
        if (oldVal !== newVal) {
          changeLogs.push({
            campaign_id: campaign.id,
            log_type: 'product_changed',
            product_id: p.id,
            product_name: p.name,
            field: label,
            old_value: oldVal || null,
            new_value: newVal || null,
          })
        }
      }

      const badgeDiff = diffBadgeLabels(prev._badgeLabels, p.badges, badgeLabelMap)
      if (badgeDiff) {
        changeLogs.push({
          campaign_id: campaign.id, log_type: 'product_changed', product_id: p.id,
          product_name: p.name, field: 'Badges', old_value: badgeDiff.old, new_value: badgeDiff.new,
        })
      }
    } else {
      // New product
      const { data: newProd, error: insErr } = await admin.from('offer_products')
        .insert(payload).select('id').single()
      if (insErr || !newProd?.id) return saveFailed('insert-product', insErr, pctx)
      productId = newProd.id
      changeLogs.push({
        campaign_id: campaign.id,
        log_type: 'product_added',
        product_id: productId || null,
        product_name: p.name,
        new_value: offerSummary(p),
      })


    }

    // Sync to client's local past product catalog
    if (p.name) {
      let catId = p.catalog_id
      let existingCatRow = null

      if (catId) {
        const { data } = await admin.from('client_product_catalog').select('id, image_url').eq('id', catId).maybeSingle()
        existingCatRow = data
      }

      // Falls through when catalog_id was absent, and ALSO when it pointed at a
      // shared-catalog product rather than one of this client's own rows — the
      // picker now offers both. Without the name check that case would insert a
      // duplicate every time the client reused a shared product.
      if (!existingCatRow) {
        const { data } = await admin.from('client_product_catalog').select('id, image_url').eq('client_id', client.id).eq('name', p.name).maybeSingle()
        existingCatRow = data
        catId = data?.id
      }

      if (!existingCatRow) {
        await admin.from('client_product_catalog').insert({
          client_id: client.id,
          name: p.name.trim(),
          weight: p.weight?.trim() || null,
          image_url: p.image_url || null,
        })
      } else if (p.image_url && !existingCatRow.image_url) {
        // Safe patch: only update local client catalog if missing image
        await admin.from('client_product_catalog')
          .update({ image_url: p.image_url })
          .eq('id', existingCatRow.id)
      }
    }

    // Sync multi-badge join rows (replace-all is simplest and matches the
    // small per-product badge count).
    if (productId) {
      const { error: badgeDelErr } = await admin.from('offer_product_badges').delete().eq('product_id', productId)
      if (badgeDelErr) return saveFailed('clear-badges', badgeDelErr, pctx)
      const badgeRows = (p.badges || []).map((b, i) => ({
        product_id: productId,
        badge_id: b.badge_id || null,
        custom_label: b.badge_id ? null : (b.custom_label?.trim() || null),
        color: b.color || 'amber',
        display_order: i,
      })).filter(b => b.badge_id || b.custom_label)
      if (badgeRows.length) {
        const { error: badgeInsErr } = await admin.from('offer_product_badges').insert(badgeRows)
        if (badgeInsErr) return saveFailed('insert-badges', badgeInsErr, pctx)
      }
    }

    // Mirror into the global Product Catalog (/dashboard/catalog) so client-
    // submitted products — and every image they ever attach to a product — are
    // visible there too, not just in this client's own "pick from past
    // products" picker. Dedup by name (case-insensitive) since product_catalog
    // is shared across all clients; client_product_assignments tracks which
    // clients use which global product; product_catalog_images accumulates
    // image history (newest = primary). Runs on every save (new or existing
    // product) so re-uploading a photo on a known product still gets recorded.
    // Best-effort — never blocks the client's save.
    void mirrorProductToGlobalCatalog(admin, client.id, p.name.trim(), p.weight?.trim() || null, p.image_url || null)
      .catch(() => {})

    productIds.push(productId ?? null)
  }

  // Header diff (title / dates)
  if (previousCampaign) {
      const headerFields: [string, string, any, any][] = [
        ['title', 'Offer title', previousCampaign.title, input.title],
        ['date_type', 'Date type', previousCampaign.date_type, input.date_type],
        ['offer_date', 'Offer date', previousCampaign.offer_date, input.offer_date],
        ['offer_date_from', 'Date from', previousCampaign.offer_date_from, input.offer_date_from],
        ['offer_date_to', 'Date to', previousCampaign.offer_date_to, input.offer_date_to],
      ]
      for (const [field, label, oldV, newV] of headerFields) {
        if (String(oldV ?? '') !== String(newV ?? '')) {
          changeLogs.push({
            campaign_id: campaign.id,
            log_type: 'header_changed',
            field: label,
            old_value: oldV ?? null,
            new_value: newV ?? null,
          })
        }
      }
  }

  // Client note
  if (input.client_note?.trim()) {
    changeLogs.push({
      campaign_id: campaign.id,
      log_type: 'client_note',
      note: input.client_note.trim().slice(0, 1000),
    })
  }

  if (changeLogs.length > 0) {
    await admin.from('offer_change_logs').insert(changeLogs)
  }

  // ── Version history (feature_offer_revisions, ships dark) ─────────────────
  // A self-contained snapshot per MEANINGFUL save: creates always, updates
  // only when the change-log diff found product changes (no-op saves add no
  // revision). Best-effort — a revision hiccup never fails the save.
  try {
    const { isFeatureEnabled } = await import('@/lib/feature-flags')
    const productChanges = changeLogs.some(l => String(l.log_type).startsWith('product_'))
    if ((!campaignId || productChanges) && await isFeatureEnabled(admin, 'feature_offer_revisions', false)) {
      const { data: lastRev } = await admin
        .from('offer_campaign_revisions')
        .select('revision_no')
        .eq('campaign_id', campaign.id)
        .order('revision_no', { ascending: false })
        .limit(1)
        .maybeSingle()
      const nextNo = (((lastRev as { revision_no?: number } | null)?.revision_no) ?? 0) + 1
      await admin.from('offer_campaign_revisions').insert({
        campaign_id: campaign.id,
        revision_no: nextNo,
        snapshot: {
          title: input.title ?? null,
          date_type: input.date_type,
          offer_date: input.offer_date ?? null,
          offer_date_from: input.offer_date_from ?? null,
          offer_date_to: input.offer_date_to ?? null,
          products: input.products,
        },
        actor_kind: opts?.actor === 'figma' ? 'figma' : opts?.actor === 'staff' ? 'staff' : 'client',
        note: null,
      })
      // Retention: keep the newest 30 revisions per campaign.
      const { data: oldRevs } = await admin
        .from('offer_campaign_revisions')
        .select('id')
        .eq('campaign_id', campaign.id)
        .order('revision_no', { ascending: false })
        .range(30, 200)
      const oldIds = ((oldRevs as { id: string }[] | null) || []).map(r => r.id)
      if (oldIds.length) await admin.from('offer_campaign_revisions').delete().in('id', oldIds)
    }
  } catch { /* revisions are a safety net, never a gate */ }

  // ── Sync to Google Sheets (fire and forget — don't block client save) ────
  void syncCampaignToSheet(admin, campaign.id, client.id).catch(() => {})

  // Timeline event (tracking/support; figma saves log their own richer note
  // in /api/figma/campaign). Best-effort, never blocks the save.
  if (opts?.actor !== 'figma') {
    void logCampaignEvent(
      admin,
      campaign.id,
      `Offer ${campaignId ? 'updated' : 'submitted'} by ${opts?.actor === 'staff' ? 'staff' : 'the client'} — ${input.products.length} product${input.products.length === 1 ? '' : 's'}.`,
    )
  }

  return { ok: true, data: { campaignId: campaign.id, productIds } }
}

// ── Upload product image ──────────────────────────────────────────────────────

export async function getImageUploadUrl(
  token: string,
  filename: string,
  contentType: string,
): Promise<ActionResult<{ uploadUrl: string; publicUrl: string; path: string }>> {
  const client = await resolveOfferToken(token)
  if (!client) return { ok: false, error: 'Invalid link.' }

  // The bucket is public, so both the declared type and the extension are
  // attacker-controlled inputs that decide how a browser renders whatever gets
  // uploaded. Allow only real image types, and derive the extension from the
  // type rather than from the supplied filename — a "photo.html" or
  // "photo.svg" served from our own origin is a stored-XSS vector, not a photo.
  const EXT_BY_TYPE: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
    // iPhone photos routinely arrive as HEIC/HEIF rather than JPEG.
    'image/heic': 'heic',
    'image/heif': 'heif',
  }
  const ALLOWED_EXTS = new Set(Object.values(EXT_BY_TYPE).concat('jpeg'))

  // Browsers occasionally hand over a File with an empty type (some Android
  // pickers, some drag-and-drop sources), so fall back to the filename
  // extension — but only when it is one we recognise.
  const declaredType = contentType.toLowerCase().split(';')[0].trim()
  const filenameExt = (filename.split('.').pop() || '').toLowerCase()
  const ext = EXT_BY_TYPE[declaredType] ?? (ALLOWED_EXTS.has(filenameExt) ? filenameExt : undefined)
  if (!ext) {
    return { ok: false, error: 'Only JPG, PNG, WebP, GIF, AVIF or HEIC images can be uploaded.' }
  }
  const path = `${client.id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`

  const admin = createAdminClient()
  const { data, error } = await admin.storage
    .from('product-images')
    .createSignedUploadUrl(path)

  if (error || !data) return { ok: false, error: 'Could not prepare upload.' }

  const { data: pub } = admin.storage.from('product-images').getPublicUrl(path)

  return {
    ok: true,
    data: {
      uploadUrl: data.signedUrl,
      publicUrl: pub.publicUrl,
      path,
    },
  }
}

/**
 * Fetch an external product image server-side and hand it to the browser as
 * base64. Needed by the in-browser background remover: pasted image links
 * (manufacturer sites, CDNs) almost never send CORS headers, so the browser
 * can't read their pixels directly. Token-gated like every intake action.
 */
export async function fetchExternalImage(
  token: string,
  url: string,
): Promise<ActionResult<{ base64: string; contentType: string }>> {
  const client = await resolveOfferToken(token)
  if (!client) return { ok: false, error: 'Invalid link.' }

  let parsed: URL
  try { parsed = new URL(url) } catch { return { ok: false, error: 'Not a valid image URL.' } }

  try {
    const res = await safePublicFetch(parsed)
    if (!res.ok) return { ok: false, error: `Could not load the image (HTTP ${res.status}).` }
    const contentType = res.headers.get('content-type') || ''
    if (!contentType.startsWith('image/')) {
      return { ok: false, error: 'That link is not a direct image (it returned a web page). Open the image itself and copy its URL.' }
    }
    const buf = await res.arrayBuffer()
    if (buf.byteLength > 8 * 1024 * 1024) {
      return { ok: false, error: 'Image is too large (max 8MB).' }
    }
    return { ok: true, data: { base64: Buffer.from(buf).toString('base64'), contentType } }
  } catch (err: any) {
    if (err instanceof BlockedHostError) return { ok: false, error: 'That URL is not reachable.' }
    return { ok: false, error: err?.name === 'TimeoutError' ? 'Image download timed out.' : 'Could not download the image.' }
  }
}

// ── Bulk paste (AI) ─────────────────────────────────────────────────────────

/**
 * Parse a pasted product list into structured rows. Pure parsing — does NOT
 * touch the campaign/products tables. The client adds the returned rows to
 * its local form state for the customer to review/edit before "Update offer
 * list" actually saves anything.
 */
export async function aiParseProductList(
  token: string,
  text: string,
  hint?: string,
): Promise<ActionResult<{ products: ParsedOfferProduct[] }>> {
  const client = await resolveOfferToken(token)
  if (!client) return { ok: false, error: 'Invalid link.' }
  if (!text.trim()) return { ok: false, error: 'Paste a product list first.' }

  try {
    const result = await aiParseOfferProducts(text, hint)
    if (!result.products.length) return { ok: false, error: 'No products found in that text.' }
    return { ok: true, data: result }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'AI parsing failed.' }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function offerSummary(p: ProductInput): string {
  if (p.offer_type === 'price') return p.price ? `₹${p.price}${p.mrp ? ` (MRP ₹${p.mrp})` : ''}` : ''
  if (p.offer_type === 'percent') return p.offer_text || ''
  if (p.offer_type === 'bogo') return 'Buy 1 Get 1'
  return p.offer_text || ''
}

/** Sorted display labels for a product's existing offer_product_badges join rows. */
function badgeLabelsOf(rows: any[] | null | undefined): string[] {
  return (rows || [])
    .map((r: any) => (Array.isArray(r.badge) ? r.badge[0] : r.badge)?.label || r.custom_label)
    .filter(Boolean)
    .sort()
}

/** Compares a product's previous badge labels against the incoming badge input. */
function diffBadgeLabels(
  oldLabels: string[] | undefined,
  newBadges: ProductBadgeInput[] | undefined,
  badgeLabelMap: Map<string, string>,
): { old: string; new: string } | null {
  const newLabels = (newBadges || [])
    .map(b => (b.badge_id ? badgeLabelMap.get(b.badge_id) : b.custom_label) || '')
    .filter(Boolean)
    .sort()
  const oldStr = (oldLabels || []).join(', ')
  const newStr = newLabels.join(', ')
  return oldStr !== newStr ? { old: oldStr, new: newStr } : null
}


export async function cancelCampaign(token: string, campaignId: string): Promise<ActionResult> {
  const client = await resolveOfferToken(token)
  if (!client) return { ok: false, error: 'This link is no longer valid.' }

  const admin = createAdminClient()

  // Design-locked offers can't be cancelled from the intake side either —
  // the designer is mid-work on them. Tolerant of the pre-migration schema.
  {
    const { data: lockRow } = await admin
      .from('offer_campaigns')
      .select('design_locked_at')
      .eq('id', campaignId)
      .maybeSingle()
    if ((lockRow as { design_locked_at?: string | null } | null)?.design_locked_at) {
      return { ok: false, error: 'This offer is with the designer now, so it can’t be cancelled here. Contact the Cirqle team.' }
    }
  }

  const { data, error } = await admin
    .from('offer_campaigns')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', campaignId)
    .eq('client_id', client.id)
    .eq('status', 'active')
    // Sheet-managed snapshots are owned by the client's own sheet, not by this
    // editor; cancelling one here would just be undone by the next pull.
    .eq('source', 'cirqle')
    .select('id')
    .maybeSingle()
  if (error || !data) return { ok: false, error: 'Could not cancel this offer request.' }

  // Every other mutation in this file writes to offer_change_logs; a client
  // cancelling their whole request is the single most important thing for
  // staff to see, so it gets an entry too. Best-effort: the cancel already
  // succeeded and must not be reported as failed if only the log write does.
  await admin.from('offer_change_logs').insert({
    campaign_id: campaignId,
    log_type: 'client_note',
    note: 'Client cancelled this offer request and started over.',
  }).then(undefined, () => {})

  return { ok: true }
}

// ── Start from last week (clone previous campaign products) ─────────────────────

/**
 * Return the products of this client's most recent *completed* offer campaign
 * (finalised or archived) as fresh ProductInput rows the coordinator can drop
 * into a new week and just re-price. Prices are blanked (they change weekly);
 * ids are dropped (they insert as new rows); name/weight/image/offer type/MRP/
 * badges/page all carry over. Cancelled campaigns are ignored — they're junk.
 * This does NOT touch the database; the client reviews the rows and saves as usual.
 */
export async function cloneLastCampaign(
  token: string,
): Promise<ActionResult<{ products: ProductInput[] }>> {
  const client = await resolveOfferToken(token)
  if (!client) return { ok: false, error: 'This link is no longer valid.' }

  const admin = createAdminClient()
  const { data: prev } = await admin
    .from('offer_campaigns')
    .select(`
      id,
      products:offer_products(
        name, weight, image_url, offer_type, mrp, page, display_order, catalog_id, group_id,
        badges:offer_product_badges(badge_id, custom_label, color, display_order)
      )
    `)
    .eq('client_id', client.id)
    .in('status', ['finalised', 'archived'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  type ClonedBadge = { badge_id: string | null; custom_label: string | null; color: string | null; display_order: number | null }
  type ClonedRow = {
    name: string
    weight: string | null
    image_url: string | null
    offer_type: ProductInput['offer_type']
    mrp: number | null
    page: number | null
    display_order: number | null
    catalog_id: string | null
    group_id: string | null
    badges: ClonedBadge[] | null
  }
  const prevProducts = (prev?.products ?? []) as unknown as ClonedRow[]
  if (!prevProducts.length) return { ok: false, error: 'No previous offer to copy yet.' }

  const products: ProductInput[] = prevProducts
    .slice()
    .sort((a, b) => (a.page || 1) - (b.page || 1) || (a.display_order || 0) - (b.display_order || 0))
    .map((p, i) => ({
      catalog_id: p.catalog_id || undefined,
      group_id: p.group_id || null,   // keep each product in its own flyer stream
      name: p.name,
      weight: p.weight || undefined,
      image_url: p.image_url || undefined,
      offer_type: p.offer_type || 'price',
      price: null,               // fresh price each week
      mrp: p.mrp ?? null,
      offer_text: undefined,
      badges: (p.badges ?? [])
        .slice()
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
        .map(b => ({
          badge_id: b.badge_id || null,
          custom_label: b.badge_id ? null : (b.custom_label || null),
          color: b.color || 'amber',
        })),
      page: p.page || 1,
      display_order: i,
    }))

  return { ok: true, data: { products } }
}

// ── Google Sheet sync status / manual resync (token-gated, for the editor) ──────

/**
 * Report the campaign's Google Sheet sync state so the editor can show
 * "Syncing / Synced / Sync failed" after a save. Timestamps are compared
 * against each other (both DB-sourced) so the result is clock-skew safe.
 */
export async function getCampaignSyncStatus(
  token: string,
  campaignId: string,
): Promise<ActionResult<{ syncedAt: string | null; syncError: string | null; updatedAt: string | null }>> {
  const client = await resolveOfferToken(token)
  if (!client) return { ok: false, error: 'This link is no longer valid.' }

  const admin = createAdminClient()
  const { data } = await admin
    .from('offer_campaigns')
    .select('id, client_id, sheet_last_synced_at, sheet_sync_error, updated_at')
    .eq('id', campaignId)
    .eq('client_id', client.id)
    .maybeSingle()
  if (!data) return { ok: false, error: 'Campaign not found.' }
  return {
    ok: true,
    data: {
      syncedAt: data.sheet_last_synced_at || null,
      syncError: data.sheet_sync_error || null,
      updatedAt: data.updated_at || null,
    },
  }
}

/** Re-run the Google Sheet sync for a campaign the caller's token owns. */
export async function resyncOfferSheet(token: string, campaignId: string): Promise<ActionResult> {
  const client = await resolveOfferToken(token)
  if (!client) return { ok: false, error: 'This link is no longer valid.' }

  const admin = createAdminClient()
  const { data: campaign } = await admin
    .from('offer_campaigns')
    .select('id, client_id')
    .eq('id', campaignId)
    .eq('client_id', client.id)
    .maybeSingle()
  if (!campaign) return { ok: false, error: 'Campaign not found.' }

  const result = await syncCampaignToSheet(admin, campaignId, client.id)
  if (!result.ok) return { ok: false, error: result.error || 'Sync failed.' }
  return { ok: true }
}

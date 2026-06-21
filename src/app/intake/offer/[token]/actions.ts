'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { syncCampaignToSheet } from '@/lib/google-sheets/sync'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

// ── Token resolution ──────────────────────────────────────────────────────────

async function resolveOfferToken(token: string) {
  if (!token || token.length < 16) return null
  try {
    const admin = createAdminClient()
    const { data } = await admin
      .from('clients')
      .select('id, name, offer_sheet_webhook_url, offer_intake_token')
      .eq('offer_intake_token', token)
      .eq('is_active', true)
      .maybeSingle()
    return data || null
  } catch { return null }
}

// ── Load campaign data for client ─────────────────────────────────────────────

export async function getOfferPageData(token: string): Promise<ActionResult<{
  client: { id: string; name: string }
  campaign: any | null
  catalog: any[]
  badges: any[]
  logoUrl: string | null
  logoDarkUrl: string | null
}>> {
  const client = await resolveOfferToken(token)
  if (!client) return { ok: false, error: 'This link is no longer valid.' }

  const admin = createAdminClient()

  const [campaignRes, catalogRes, badgesRes, logoRes, logoDarkRes] = await Promise.all([
    // Most recent active campaign for this client
    admin.from('offer_campaigns')
      .select('*, products:offer_products(*, badges:offer_product_badges(id, badge_id, custom_label, color, display_order, badge:offer_badges(label, color)))')
      .eq('client_id', client.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin.from('client_product_catalog')
      .select('*')
      .eq('client_id', client.id)
      .eq('is_active', true)
      .order('name'),
    admin.from('offer_badges')
      .select('*')
      .eq('is_active', true)
      .order('display_order'),
    admin.from('company_settings').select('value').eq('key', 'logo_url').maybeSingle(),
    admin.from('company_settings').select('value').eq('key', 'logo_url_dark').maybeSingle(),
  ])

  // Attach each catalog item's image HISTORY (newest first) from the global
  // Product Catalog, matched by name (same dedup key mirrorProductToGlobalCatalog
  // uses) — lets the client pick among past photos instead of just the latest.
  const catalog = catalogRes.data || []
  let catalogWithImages = catalog
  if (catalog.length) {
    const { data: globalProducts } = await admin
      .from('product_catalog')
      .select('id, name, images:product_catalog_images(id, url, is_primary, created_at)')
      .in('name', catalog.map((c: any) => c.name.trim()))
    const byName = new Map((globalProducts || []).map((g: any) => [g.name.trim().toLowerCase(), g]))
    catalogWithImages = catalog.map((c: any) => {
      const g = byName.get(c.name.trim().toLowerCase())
      const images = (g?.images || []).slice().sort((a: any, b: any) => (b.created_at || '').localeCompare(a.created_at || ''))
      return { ...c, images }
    })
  }

  return {
    ok: true,
    data: {
      client: { id: client.id, name: client.name },
      campaign: campaignRes.data || null,
      catalog: catalogWithImages,
      badges: badgesRes.data || [],
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

export async function saveCampaign(
  token: string,
  input: CampaignInput,
  campaignId?: string,
): Promise<ActionResult<{ campaignId: string }>> {
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
  if (campaignId) {
    // Verify ownership
    const { data: existing } = await admin.from('offer_campaigns')
      .select('id, client_id').eq('id', campaignId).maybeSingle()
    if (!existing || existing.client_id !== client.id)
      return { ok: false, error: 'Campaign not found.' }

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
    await admin.from('offer_products').delete().eq('id', p.id)
    await admin.from('offer_change_logs').insert({
      campaign_id: campaign.id,
      log_type: 'product_removed',
      product_name: p.name,
      product_id: p.id,
    })
  }

  // ── Upsert current products + diff log ───────────────────────────────────
  const changeLogs: any[] = []

  for (const p of input.products) {
    const payload = {
      campaign_id: campaign.id,
      catalog_id: p.catalog_id || null,
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
      await admin.from('offer_products').update(payload).eq('id', p.id)

      const DIFF_FIELDS: [string, string][] = [
        ['name', 'Product name'],
        ['weight', 'Weight'],
        ['offer_type', 'Offer type'],
        ['price', 'Price'],
        ['mrp', 'MRP'],
        ['offer_text', 'Offer text'],
        ['page', 'Page'],
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
      const { data: newProd } = await admin.from('offer_products')
        .insert(payload).select('id').single()
      productId = newProd?.id
      changeLogs.push({
        campaign_id: campaign.id,
        log_type: 'product_added',
        product_id: productId || null,
        product_name: p.name,
        new_value: offerSummary(p),
      })

      // Add to catalog if not already there
      if (!p.catalog_id && p.name) {
        const { data: existing } = await admin.from('client_product_catalog')
          .select('id').eq('client_id', client.id).eq('name', p.name).maybeSingle()
        if (!existing) {
          await admin.from('client_product_catalog').insert({
            client_id: client.id,
            name: p.name.trim(),
            weight: p.weight?.trim() || null,
            image_url: p.image_url || null,
          })
        }
      }
    }

    // Sync multi-badge join rows (replace-all is simplest and matches the
    // small per-product badge count).
    if (productId) {
      await admin.from('offer_product_badges').delete().eq('product_id', productId)
      const badgeRows = (p.badges || []).map((b, i) => ({
        product_id: productId,
        badge_id: b.badge_id || null,
        custom_label: b.badge_id ? null : (b.custom_label?.trim() || null),
        color: b.color || 'amber',
        display_order: i,
      })).filter(b => b.badge_id || b.custom_label)
      if (badgeRows.length) await admin.from('offer_product_badges').insert(badgeRows)
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
  }

  // Header diff (title / dates)
  if (campaignId) {
    const { data: prevCampaign } = await admin.from('offer_campaigns')
      .select('title, date_type, offer_date, offer_date_from, offer_date_to')
      .eq('id', campaignId).single()
    if (prevCampaign) {
      const headerFields: [string, string, any, any][] = [
        ['title', 'Offer title', prevCampaign.title, input.title],
        ['date_type', 'Date type', prevCampaign.date_type, input.date_type],
        ['offer_date', 'Offer date', prevCampaign.offer_date, input.offer_date],
        ['offer_date_from', 'Date from', prevCampaign.offer_date_from, input.offer_date_from],
        ['offer_date_to', 'Date to', prevCampaign.offer_date_to, input.offer_date_to],
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

  // ── Sync to Google Sheets (fire and forget — don't block client save) ────
  void syncCampaignToSheet(admin, campaign.id, client.id).catch(() => {})

  return { ok: true, data: { campaignId: campaign.id } }
}

// ── Upload product image ──────────────────────────────────────────────────────

export async function getImageUploadUrl(
  token: string,
  filename: string,
  contentType: string,
): Promise<ActionResult<{ uploadUrl: string; publicUrl: string; path: string }>> {
  const client = await resolveOfferToken(token)
  if (!client) return { ok: false, error: 'Invalid link.' }

  const ext = filename.split('.').pop() || 'jpg'
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

/** Find-or-create the global product_catalog row for this name, assign it to
 * the client, and — if a new image URL was submitted — record it in the
 * image history (newest upload becomes primary). See the call site for why
 * this mirror exists. */
async function mirrorProductToGlobalCatalog(
  admin: ReturnType<typeof createAdminClient>,
  clientId: string,
  name: string,
  weight: string | null,
  imageUrl: string | null,
): Promise<void> {
  if (!name) return

  const { data: existing } = await admin
    .from('product_catalog')
    .select('id, image_url')
    .ilike('name', name)
    .maybeSingle()

  let productId = existing?.id as string | undefined

  if (!productId) {
    const { data: created } = await admin
      .from('product_catalog')
      .insert({ name, weight, image_url: imageUrl })
      .select('id')
      .single()
    productId = created?.id
  }

  if (!productId) return

  if (imageUrl) {
    const { data: alreadyRecorded } = await admin
      .from('product_catalog_images')
      .select('id').eq('product_id', productId).eq('url', imageUrl).maybeSingle()
    if (!alreadyRecorded) {
      // New photo for this product — it becomes the primary (newest = primary).
      await admin.from('product_catalog_images').update({ is_primary: false }).eq('product_id', productId).eq('is_primary', true)
      await admin.from('product_catalog_images').insert({
        product_id: productId, version: 'original', url: imageUrl, source: 'upload', is_primary: true,
      })
      await admin.from('product_catalog').update({ image_url: imageUrl }).eq('id', productId)
    }
  }

  await admin
    .from('client_product_assignments')
    .upsert({ client_id: clientId, product_id: productId, is_active: true }, { onConflict: 'client_id,product_id' })
}

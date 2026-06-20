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
      .select('*, products:offer_products(*, badge:offer_badges(id, label, color))')
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

  return {
    ok: true,
    data: {
      client: { id: client.id, name: client.name },
      campaign: campaignRes.data || null,
      catalog: catalogRes.data || [],
      badges: badgesRes.data || [],
      logoUrl: logoRes.data?.value || null,
      logoDarkUrl: logoDarkRes.data?.value || null,
    },
  }
}

// ── Save / update campaign ────────────────────────────────────────────────────

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
  badge_id?: string | null
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
    .select('*').eq('campaign_id', campaign.id)
  const prevMap = new Map((prevProducts || []).map((p: any) => [p.id, p]))
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
      badge_id: p.badge_id || null,
      display_order: p.display_order,
      updated_at: now,
    }

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
        ['badge_id', 'Badge'],
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
    } else {
      // New product
      const { data: newProd } = await admin.from('offer_products')
        .insert(payload).select('id').single()
      changeLogs.push({
        campaign_id: campaign.id,
        log_type: 'product_added',
        product_id: newProd?.id || null,
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

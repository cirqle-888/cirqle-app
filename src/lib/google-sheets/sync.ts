/**
 * Google Sheets sync — Apps Script Webhook approach
 *
 * No Google Cloud Console, no Service Account, no billing, no org policy issues.
 *
 * Each client's Google Sheet has a small Apps Script deployed as a Web App.
 * Cirqle App POSTs JSON to that URL and the script writes the rows.
 *
 * Setup per client (2 min):
 *   1. Open client's Google Sheet
 *   2. Extensions → Apps Script → paste the script from GOOGLE_SHEETS_SETUP.md
 *   3. Deploy → New deployment → Web App → Execute as: Me → Who has access: Anyone → Deploy
 *   4. Copy the Web App URL → paste into client record in Cirqle App (offer_sheet_webhook_url)
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { notifyAdmins } from '@/lib/notifications/create'

interface SyncResult { ok: boolean; error?: string; sheetUrl?: string }

function formatDate(campaign: {
  date_type: string
  offer_date?: string | null
  offer_date_from?: string | null
  offer_date_to?: string | null
}): string {
  if (campaign.date_type === 'single' && campaign.offer_date) {
    return new Date(campaign.offer_date + 'T00:00:00').toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric',
    })
  }
  if (campaign.date_type === 'range') {
    const fmt = (d?: string | null) => d
      ? new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      : ''
    const from = fmt(campaign.offer_date_from)
    const to = fmt(campaign.offer_date_to)
    return [from, to].filter(Boolean).join(' – ')
  }
  return ''
}

function splitPrice(price?: number | null): [string, string] {
  if (!price) return ['', '']
  const parts = price.toFixed(2).split('.')
  return [parts[0], parts[1] === '00' ? '' : parts[1]]
}

export async function syncCampaignToSheet(
  admin: SupabaseClient,
  campaignId: string,
  clientId: string,
): Promise<SyncResult> {

  // 1. Load client webhook URL
  const { data: client } = await admin
    .from('clients')
    .select('offer_sheet_webhook_url, name')
    .eq('id', clientId)
    .maybeSingle()

  // 2. Load campaign + products (sheet_sync_error included so we can tell a
  // BRAND NEW failure apart from "still broken since last sync attempt" —
  // only notify admins on that transition, not on every retry).
  const { data: campaign } = await admin
    .from('offer_campaigns')
    .select(`
      id, title, date_type, offer_date, offer_date_from, offer_date_to, sheet_sync_error,
      products:offer_products(
        name, weight, price, mrp, offer_type, offer_text,
        badges:offer_product_badges(custom_label, badge:offer_badges(label)),
        image_url, display_order, page
      )
    `)
    .eq('id', campaignId)
    .maybeSingle()

  if (!campaign) return { ok: false, error: 'Campaign not found.' }
  const wasHealthy = !campaign.sheet_sync_error

  function notifyNewFailure(errMsg: string) {
    if (!wasHealthy) return // already broken — don't re-notify on every retry
    void notifyAdmins({
      type: 'offer_sync_failed',
      title: `Sheet sync failed — ${client?.name || 'client'}`,
      message: errMsg,
      link: '/dashboard/requests',
      sourceKey: `offer_sync_failed:${campaignId}:${new Date().toISOString().slice(0, 10)}`,
    })
  }

  if (!client?.offer_sheet_webhook_url) {
    const errMsg = 'No Google Sheet webhook configured for this client.'
    await admin.from('offer_campaigns')
      .update({ sheet_sync_error: errMsg })
      .eq('id', campaignId)
    notifyNewFailure(errMsg)
    return { ok: false, error: 'No sheet webhook URL configured.' }
  }

  const offerDate = formatDate(campaign)
  const products = (campaign.products as any[] || [])
    .sort((a: any, b: any) => a.display_order - b.display_order)

  // 3. Build rows
  const rows = products.map((p: any) => {
    const [price1, price2] = splitPrice(p.price)
    let offerText = p.offer_text || ''
    if (p.offer_type === 'bogo') offerText = 'Buy 1 Get 1'
    const badgeLabels = ((p.badges || []) as any[])
      .map(b => b.custom_label || (Array.isArray(b.badge) ? b.badge[0] : b.badge)?.label)
      .filter(Boolean)
      .join(', ')
    return [
      p.name || '',
      price1,
      price2,
      p.mrp ? String(p.mrp) : '',
      offerText,
      badgeLabels,
      p.image_url || '',
      offerDate,
      String(p.page || 1),
    ]
  })

  // 4. POST to Apps Script Web App
  const payload = {
    offerTitle: campaign.title || '',
    offerDate,
    headers: ['Product', 'Price 1', 'Price 2', 'MRP', 'Offer Text', 'Badge', 'Image URL', 'Offer Date', 'Page'],
    rows,
  }

  try {
    const res = await fetch(client.offer_sheet_webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const errMsg = `Sheet sync failed (HTTP ${res.status}): ${body.slice(0, 200)}`
      await admin.from('offer_campaigns')
        .update({ sheet_sync_error: errMsg })
        .eq('id', campaignId)
      notifyNewFailure(errMsg)
      return { ok: false, error: errMsg }
    }

    let returnedSheetUrl: string | undefined
    try {
      const responseData = await res.json()
      if (responseData?.sheetUrl) {
        returnedSheetUrl = responseData.sheetUrl
        await admin.from('clients')
          .update({ offer_sheet_url: responseData.sheetUrl })
          .eq('id', clientId)
      }
    } catch (e) {
      // Ignore parse errors if the response isn't JSON
    }

    // 5. Update sync timestamp
    await admin.from('offer_campaigns')
      .update({ sheet_last_synced_at: new Date().toISOString(), sheet_sync_error: null })
      .eq('id', campaignId)

    return { ok: true, sheetUrl: returnedSheetUrl }

  } catch (err: any) {
    const errMsg = err?.name === 'TimeoutError'
      ? 'Sheet sync timed out. Check the Apps Script URL is correct.'
      : `Sheet sync error: ${err?.message || 'Unknown error'}`
    await admin.from('offer_campaigns')
      .update({ sheet_sync_error: errMsg })
      .eq('id', campaignId)
    notifyNewFailure(errMsg)
    return { ok: false, error: errMsg }
  }
}

/**
 * Google Sheets sync — Apps Script Webhook approach
 *
 * No Google Cloud Console, no Service Account, no billing, no org policy issues.
 *
 * TWO deployment models, resolved per campaign:
 *
 *  1. Shared script (recommended, default). ONE standalone Apps Script Web App
 *     is deployed once for the whole workspace; its URL + a shared secret live
 *     in company_settings (`offer_sheet_webhook_url`, `offer_sheet_secret`).
 *     Each client just pastes their Google Sheet LINK (clients.offer_sheet_url).
 *     We send the spreadsheetId (parsed from that link) + the secret, and the
 *     one script writes into that sheet via openById. Adding a client = paste a
 *     link; no per-client Apps Script deploy.
 *
 *  2. Legacy per-client script (still supported). A script bound to that one
 *     client's sheet, its Web App URL stored in clients.offer_sheet_webhook_url.
 *     Takes precedence when set, so existing setups keep working untouched.
 *
 * See GOOGLE_SHEETS_SETUP.md for the one-time shared-script deploy.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { notifyAdmins } from '@/lib/notifications/create'
import { OFFER_SHEET_HEADERS, buildOfferSheetRows } from '@/lib/offer-sheet'

/**
 * How long to wait for the client's Apps Script to answer.
 *
 * Apps Script routinely needs 10-20s on a cold start plus the sheet write, so
 * the original 15s tripped on healthy-but-slow scripts and fired a recurring
 * "sync failed" notification for a setup that was actually fine. The automatic
 * sync is fire-and-forget (offer-intake save path), so a longer ceiling costs
 * the user nothing; the manual "Sync now" actions are deliberate and can wait.
 */
const SHEET_SYNC_TIMEOUT_MS = 45_000

interface SyncResult { ok: boolean; error?: string; sheetUrl?: string }

/**
 * Pull the spreadsheet ID out of a Google Sheets link (or accept a raw ID).
 * `https://docs.google.com/spreadsheets/d/<ID>/edit#gid=0` → `<ID>`.
 */
export function extractSheetId(url: string | null | undefined): string | null {
  if (!url) return null
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)
  if (m) return m[1]
  const trimmed = url.trim()
  return /^[a-zA-Z0-9_-]{30,}$/.test(trimmed) ? trimmed : null
}

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

export async function syncCampaignToSheet(
  admin: SupabaseClient,
  campaignId: string,
  clientId: string,
): Promise<SyncResult> {

  // 1. Load client sheet destination (per-client override URL + the Sheet link)
  const { data: client } = await admin
    .from('clients')
    .select('offer_sheet_webhook_url, offer_sheet_url, name')
    .eq('id', clientId)
    .maybeSingle()

  // Workspace-wide shared-script config (one deploy for all clients).
  const { data: settingsRows } = await admin
    .from('company_settings')
    .select('key, value')
    .in('key', ['offer_sheet_webhook_url', 'offer_sheet_secret'])
  const settings = Object.fromEntries((settingsRows || []).map((r: any) => [r.key, r.value]))
  const globalWebhook = (settings['offer_sheet_webhook_url'] || '').trim()
  const sharedSecret = (settings['offer_sheet_secret'] || '').trim()

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

  // Resolve where this campaign's rows go. Legacy per-client webhook wins when
  // present (that script is bound to the client's own sheet). Otherwise use the
  // shared script + the client's Sheet link.
  let targetUrl: string
  let routePayload: Record<string, unknown> = {}
  if (client?.offer_sheet_webhook_url) {
    targetUrl = client.offer_sheet_webhook_url
  } else if (globalWebhook && client?.offer_sheet_url) {
    const spreadsheetId = extractSheetId(client.offer_sheet_url)
    if (!spreadsheetId) {
      const errMsg = 'The client Sheet link is not a valid Google Sheets URL.'
      await admin.from('offer_campaigns').update({ sheet_sync_error: errMsg }).eq('id', campaignId)
      notifyNewFailure(errMsg)
      return { ok: false, error: errMsg }
    }
    targetUrl = globalWebhook
    routePayload = { spreadsheetId, secret: sharedSecret }
  } else {
    const errMsg = globalWebhook
      ? 'No Google Sheet linked for this client. Paste the client’s Google Sheet link in Offer Intake settings.'
      : 'Google Sheet sync is not set up yet. Connect the shared script in Offer Intake settings.'
    await admin.from('offer_campaigns')
      .update({ sheet_sync_error: errMsg })
      .eq('id', campaignId)
    notifyNewFailure(errMsg)
    return { ok: false, error: errMsg }
  }

  const offerDate = formatDate(campaign)
  // 3. Build the stable Figma/Sheets data contract. The offer editor's
  // “Copy table” button imports this same helper, so pasted and synced output
  // always have identical columns.
  const rows = buildOfferSheetRows({
    clientName: client?.name,
    offerTitle: campaign.title,
    offerDate,
    products: (campaign.products as any[] || []),
  })

  // 4. POST to the Apps Script Web App. `routePayload` carries the spreadsheetId
  // + shared secret for the shared-script model; it's empty for legacy bound
  // scripts (which already know their own sheet).
  const payload = {
    offerTitle: campaign.title || '',
    offerDate,
    headers: OFFER_SHEET_HEADERS,
    rows,
    ...routePayload,
  }

  // Mark this attempt in progress: clear any error left over from a PREVIOUS
  // failed sync so an in-flight re-sync isn't shown as failed (both the offer
  // editor's status poll and the campaign card read sheet_sync_error). wasHealthy
  // was captured above, so the healthy→broken notify throttle stays intact.
  if (!wasHealthy) {
    await admin.from('offer_campaigns').update({ sheet_sync_error: null }).eq('id', campaignId)
  }

  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SHEET_SYNC_TIMEOUT_MS),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // Google answers blocked/broken Apps Script deployments with an HTML
      // sign-in or error page — raw markup is useless to staff, so translate
      // the common cases into an actionable message.
      const isHtml = /^\s*<!doctype|^\s*<html/i.test(body)
      const errMsg = res.status === 401 || res.status === 403
        ? `Google blocked the sheet webhook (HTTP ${res.status}). Open the client's sheet → Extensions → Apps Script → Deploy → Manage deployments → set "Who has access" to "Anyone" and re-deploy; if the URL changed, update it in Cirqle's Offer Intake settings.`
        : res.status === 404
          ? 'Sheet webhook not found (HTTP 404) — the Apps Script deployment was removed or the URL is wrong. Re-deploy and update the URL in Offer Intake settings.'
          : `Sheet sync failed (HTTP ${res.status}): ${isHtml ? 'Google returned an error page instead of the Apps Script response.' : body.slice(0, 200)}`
      await admin.from('offer_campaigns')
        .update({ sheet_sync_error: errMsg })
        .eq('id', campaignId)
      notifyNewFailure(errMsg)
      return { ok: false, error: errMsg }
    }

    let returnedSheetUrl: string | undefined
    try {
      const responseData = await res.json()
      // The Apps Script reports back which sheet it wrote to, and we persist it
      // so staff get a working link. But the webhook is deployed "Anyone", so
      // this response is untrusted input: without validation a broken or
      // hostile script could write any string here and permanently redirect
      // this client's sheet link. Only accept a real Google Sheets URL.
      const candidate = typeof responseData?.sheetUrl === 'string' ? responseData.sheetUrl.trim() : ''
      if (candidate) {
        const isGoogleSheetUrl =
          /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9_-]+/.test(candidate) &&
          extractSheetId(candidate) !== null
        if (isGoogleSheetUrl) {
          returnedSheetUrl = candidate
          await admin.from('clients')
            .update({ offer_sheet_url: candidate })
            .eq('id', clientId)
        }
        // A non-conforming value is ignored rather than failing the sync — the
        // rows already landed in the sheet; only the bookkeeping link is skipped.
      }
    } catch {
      // Ignore parse errors if the response isn't JSON
    }

    // 5. Update sync timestamp
    await admin.from('offer_campaigns')
      .update({ sheet_last_synced_at: new Date().toISOString(), sheet_sync_error: null })
      .eq('id', campaignId)

    return { ok: true, sheetUrl: returnedSheetUrl }

  } catch (err: any) {
    // A WRONG url does not time out — Google answers it with 404/403, handled
    // above with its own message. Reaching here means the script accepted the
    // request and simply did not finish in time (cold start, or a long write
    // on a big offer list), so point at that instead of sending staff to
    // re-check a URL that is almost certainly fine.
    const errMsg = err?.name === 'TimeoutError'
      ? `Sheet sync timed out after ${Math.round(SHEET_SYNC_TIMEOUT_MS / 1000)}s — the Apps Script did not finish. Usually a slow/cold script or a very long offer list; open the sheet's Apps Script → Executions to see if it is still running, then re-sync.`
      : `Sheet sync error: ${err?.message || 'Unknown error'}`
    await admin.from('offer_campaigns')
      .update({ sheet_sync_error: errMsg })
      .eq('id', campaignId)
    notifyNewFailure(errMsg)
    return { ok: false, error: errMsg }
  }
}

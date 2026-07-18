'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin, resolveCurrentEmployeeId } from '@/lib/auth/enforce'
import { syncCampaignToSheet, extractSheetId } from '@/lib/google-sheets/sync'
import { revalidatePath } from 'next/cache'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

// ── Shared-script (workspace-wide) sheet-sync config ─────────────────────────
// One Apps Script Web App serves every client; its URL + a shared secret live
// in company_settings. Per-client setup is then just the client's Sheet link.

export async function getGlobalSheetConfig(): Promise<ActionResult<{ webhookUrl: string; secret: string; configured: boolean }>> {
  const _guard = await requireAdmin(); if (!_guard.ok) return { ok: false, error: _guard.error }
  const admin = createAdminClient()
  const { data } = await admin
    .from('company_settings')
    .select('key, value')
    .in('key', ['offer_sheet_webhook_url', 'offer_sheet_secret'])
  const map = Object.fromEntries((data || []).map((r: any) => [r.key, r.value]))
  const webhookUrl = (map['offer_sheet_webhook_url'] || '').trim()
  const secret = (map['offer_sheet_secret'] || '').trim()
  return { ok: true, data: { webhookUrl, secret, configured: !!webhookUrl } }
}

export async function saveGlobalWebhookUrl(url: string): Promise<ActionResult<{ secret: string }>> {
  const _guard = await requireAdmin(); if (!_guard.ok) return { ok: false, error: _guard.error }
  const trimmed = url.trim()
  if (trimmed && !trimmed.startsWith('https://script.google.com/macros/s/')) {
    return { ok: false, error: 'URL must be a Google Apps Script Web App URL (starts with https://script.google.com/macros/s/)' }
  }
  const admin = createAdminClient()

  // Ensure a shared secret exists the first time the workspace connects, so the
  // one public endpoint can reject any POST that doesn't carry it.
  const { data: existing } = await admin
    .from('company_settings').select('value').eq('key', 'offer_sheet_secret').maybeSingle()
  let secret = (existing?.value || '').trim()
  if (!secret) {
    secret = crypto.randomUUID().replace(/-/g, '')
    await admin.from('company_settings').upsert({ key: 'offer_sheet_secret', value: secret }, { onConflict: 'key' })
  }

  const { error } = await admin.from('company_settings')
    .upsert({ key: 'offer_sheet_webhook_url', value: trimmed }, { onConflict: 'key' })
  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard/apps/offer-intake')
  return { ok: true, data: { secret } }
}

export async function regenerateSheetSecret(): Promise<ActionResult<{ secret: string }>> {
  const _guard = await requireAdmin(); if (!_guard.ok) return { ok: false, error: _guard.error }
  const admin = createAdminClient()
  const secret = crypto.randomUUID().replace(/-/g, '')
  const { error } = await admin.from('company_settings')
    .upsert({ key: 'offer_sheet_secret', value: secret }, { onConflict: 'key' })
  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard/apps/offer-intake')
  return { ok: true, data: { secret } }
}

// ── Load all clients with offer fields ───────────────────────────────────────

export async function getOfferClients(): Promise<ActionResult<{ clients: any[] }>> {
  const _guard = await requireAdmin(); if (!_guard.ok) return { ok: false, error: _guard.error }
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('clients')
    .select('id, name, code, is_active, offer_intake_token, offer_sheet_webhook_url, offer_sheet_url')
    .eq('is_active', true)
    .order('name')
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: { clients: data || [] } }
}

// ── Save / update offer sheet URL ────────────────────────────────────────────

export async function saveOfferSheetUrl(
  clientId: string,
  url: string,
): Promise<ActionResult> {
  const _guard = await requireAdmin(); if (!_guard.ok) return { ok: false, error: _guard.error }
  const admin = createAdminClient()
  const trimmed = url.trim()

  // Reject anything we can't extract a spreadsheet ID from — otherwise the sync
  // would fail later with a confusing error. Empty clears the link.
  if (trimmed && !extractSheetId(trimmed)) {
    return { ok: false, error: 'That doesn’t look like a Google Sheet link. Open the sheet and copy the URL from your browser (it contains /spreadsheets/d/…).' }
  }

  const { error } = await admin
    .from('clients')
    .update({ offer_sheet_url: trimmed || null })
    .eq('id', clientId)

  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard/apps/offer-intake')
  return { ok: true }
}

// ── Save / update webhook URL ────────────────────────────────────────────────

export async function saveWebhookUrl(
  clientId: string,
  webhookUrl: string,
): Promise<ActionResult> {
  const _guard = await requireAdmin(); if (!_guard.ok) return { ok: false, error: _guard.error }
  const admin = createAdminClient()
  const url = webhookUrl.trim()

  if (url && !url.startsWith('https://script.google.com/macros/s/')) {
    return { ok: false, error: 'URL must be a Google Apps Script Web App URL (starts with https://script.google.com/macros/s/)' }
  }

  const { error } = await admin
    .from('clients')
    .update({ offer_sheet_webhook_url: url || null })
    .eq('id', clientId)

  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard/apps/offer-intake')
  return { ok: true }
}

// ── Reset / regenerate offer intake token ────────────────────────────────────

export async function resetOfferToken(clientId: string): Promise<ActionResult<{ token: string }>> {
  const _guard = await requireAdmin(); if (!_guard.ok) return { ok: false, error: _guard.error }
  const admin = createAdminClient()

  // Generate a new random token
  const newToken = crypto.randomUUID().replace(/-/g, '')

  const { error } = await admin
    .from('clients')
    .update({ offer_intake_token: newToken })
    .eq('id', clientId)

  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard/apps/offer-intake')
  return { ok: true, data: { token: newToken } }
}

// ── Test sheet sync (uses most recent active campaign) ───────────────────────

export async function testSheetSync(clientId: string): Promise<ActionResult<{ message: string; sheetUrl?: string }>> {
  const _guard = await requireAdmin(); if (!_guard.ok) return { ok: false, error: _guard.error }
  const admin = createAdminClient()

  // Find the most recent active campaign for this client
  const { data: campaign } = await admin
    .from('offer_campaigns')
    .select('id')
    .eq('client_id', clientId)
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!campaign) {
    return {
      ok: false,
      error: 'No active campaign found for this client. Have them submit their offer list first.',
    }
  }

  const result = await syncCampaignToSheet(admin, campaign.id, clientId)
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, data: { message: 'Sheet synced successfully ✓', sheetUrl: result.sheetUrl } }
}

// NOTE: there is no toggleOfferFlyerService action any more. Offer-intake
// access is service-driven — a client has it when one of their assigned
// services has intake_kind = 'offer_intake' (see lib/services/intake-server.ts).
// The legacy clients.has_offer_flyer_service column is still honoured as a
// read-only override for pre-service-model clients, but nothing writes it.

// ── Ensure offer token exists (generate if missing) ──────────────────────────

export async function ensureOfferToken(clientId: string): Promise<ActionResult<{ token: string }>> {
  const _guard = await requireAdmin(); if (!_guard.ok) return { ok: false, error: _guard.error }
  const admin = createAdminClient()

  const { data: client } = await admin
    .from('clients')
    .select('offer_intake_token')
    .eq('id', clientId)
    .maybeSingle()

  if (client?.offer_intake_token) {
    return { ok: true, data: { token: client.offer_intake_token } }
  }

  // Generate a new one
  const newToken = crypto.randomUUID().replace(/-/g, '')
  const { error } = await admin
    .from('clients')
    .update({ offer_intake_token: newToken })
    .eq('id', clientId)

  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard/apps/offer-intake')
  return { ok: true, data: { token: newToken } }
}

'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { selectWithOptionalColumns } from '@/lib/offer-columns'
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
  const data = await selectWithOptionalColumns<any[]>(
    'id, name, code, is_active, offer_intake_token, offer_sheet_webhook_url, offer_sheet_url',
    ['offer_flow_mode', 'offer_master_sheet_url'],
    cols => admin.from('clients').select(cols).eq('is_active', true).order('name'),
  )
  return { ok: true, data: { clients: data || [] } }
}

// ── Offer categories (groups) ────────────────────────────────────────────────

export interface OfferGroupRow {
  id: string
  client_id: string
  name: string
  slug: string
  sheet_url: string | null
  sheet_tab_name: string | null
  master_tab_name: string | null
  apps_script_url: string | null
  integrations: { figma?: { file_url?: string } } | null
  display_order: number
  is_active: boolean
  last_pulled_at: string | null
}

/**
 * Categories for every client, keyed by client id.
 *
 * Returns an empty map if the table isn't there yet so the settings page keeps
 * working on a deploy that landed before the migration was applied.
 */
export async function getOfferGroups(): Promise<ActionResult<{ byClient: Record<string, OfferGroupRow[]> }>> {
  const _guard = await requireAdmin(); if (!_guard.ok) return { ok: false, error: _guard.error }
  const admin = createAdminClient()
  try {
    const { data, error } = await admin
      .from('client_offer_groups')
      .select('id, client_id, name, slug, sheet_url, sheet_tab_name, master_tab_name, apps_script_url, integrations, display_order, is_active, last_pulled_at')
      .is('parent_id', null)
      .order('display_order')
    if (error) return { ok: true, data: { byClient: {} } }
    const byClient: Record<string, OfferGroupRow[]> = {}
    for (const row of (data || []) as OfferGroupRow[]) {
      ;(byClient[row.client_id] ||= []).push(row)
    }
    return { ok: true, data: { byClient } }
  } catch {
    return { ok: true, data: { byClient: {} } }
  }
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'category'
}

export async function upsertOfferGroup(input: {
  id?: string
  clientId: string
  name: string
  sheetUrl?: string
  sheetTabName?: string
  masterTabName?: string
  appsScriptUrl?: string
  figmaUrl?: string
  isActive?: boolean
}): Promise<ActionResult<{ id: string }>> {
  const _guard = await requireAdmin(); if (!_guard.ok) return { ok: false, error: _guard.error }
  const admin = createAdminClient()

  const name = input.name.trim()
  if (!name) return { ok: false, error: 'Give the category a name.' }

  const sheetUrl = (input.sheetUrl || '').trim()
  // Validate once here rather than letting every sync re-parse it and fail late.
  const sheetId = sheetUrl ? extractSheetId(sheetUrl) : null
  if (sheetUrl && !sheetId) {
    return { ok: false, error: 'That doesn’t look like a Google Sheet link. Open the sheet and copy the URL from your browser (it contains /spreadsheets/d/…).' }
  }

  const figmaUrl = (input.figmaUrl || '').trim()
  const payload = {
    client_id: input.clientId,
    name,
    slug: slugify(name),
    sheet_url: sheetUrl || null,
    sheet_id: sheetId,
    sheet_tab_name: (input.sheetTabName || '').trim() || null,
    master_tab_name: (input.masterTabName || '').trim() || null,
    apps_script_url: (input.appsScriptUrl || '').trim() || null,
    // Figma (and any future tool) lives in jsonb so adding one needs no migration.
    integrations: figmaUrl ? { figma: { file_url: figmaUrl } } : {},
    is_active: input.isActive ?? true,
    updated_at: new Date().toISOString(),
  }

  if (input.id) {
    const { error } = await admin.from('client_offer_groups').update(payload).eq('id', input.id)
    if (error) return { ok: false, error: error.message }
    revalidatePath('/dashboard/apps/offer-intake')
    return { ok: true, data: { id: input.id } }
  }

  const { data: existingCount } = await admin
    .from('client_offer_groups')
    .select('id')
    .eq('client_id', input.clientId)
  const { data, error } = await admin
    .from('client_offer_groups')
    .insert({ ...payload, display_order: (existingCount || []).length })
    .select('id')
    .single()
  if (error || !data) {
    return { ok: false, error: error?.code === '23505' ? 'That client already has a category with this name.' : (error?.message || 'Could not create the category.') }
  }
  revalidatePath('/dashboard/apps/offer-intake')
  return { ok: true, data: { id: data.id } }
}

export async function deleteOfferGroup(id: string): Promise<ActionResult> {
  const _guard = await requireAdmin(); if (!_guard.ok) return { ok: false, error: _guard.error }
  const admin = createAdminClient()
  // offer_products.group_id is ON DELETE SET NULL, so past campaigns keep their
  // products — they just fall back to the default bucket.
  const { error } = await admin.from('client_offer_groups').delete().eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard/apps/offer-intake')
  return { ok: true }
}

// ── Flow mode + master sheet (pull-mode clients) ─────────────────────────────

export async function saveClientFlowMode(
  clientId: string,
  mode: 'push' | 'pull' | 'manual',
): Promise<ActionResult> {
  const _guard = await requireAdmin(); if (!_guard.ok) return { ok: false, error: _guard.error }
  if (!['push', 'pull', 'manual'].includes(mode)) return { ok: false, error: 'Unknown flow mode.' }
  const admin = createAdminClient()
  const { error } = await admin.from('clients').update({ offer_flow_mode: mode }).eq('id', clientId)
  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard/apps/offer-intake')
  revalidatePath('/dashboard/offer-prepare')
  return { ok: true }
}

/**
 * The client's main Figma file.
 *
 * Categories carry their own Figma link, but most clients have no categories —
 * they get one flyer from one file — so the link belongs on the client too.
 * Stored in the `integrations` jsonb rather than its own column so adding
 * Canva, Drive or anything else later needs no migration.
 */
export async function saveClientFigmaUrl(clientId: string, url: string): Promise<ActionResult> {
  const _guard = await requireAdmin(); if (!_guard.ok) return { ok: false, error: _guard.error }
  const admin = createAdminClient()
  const trimmed = url.trim()

  if (trimmed && !/^https?:\/\/(www\.)?figma\.com\//i.test(trimmed)) {
    return { ok: false, error: 'That doesn’t look like a Figma link. Open the file and copy the URL from your browser (it starts with figma.com/design/…).' }
  }

  // Merge rather than replace: this column is shared with any other integration.
  const { data: existing } = await admin
    .from('clients').select('integrations').eq('id', clientId).maybeSingle()
  const current = (existing?.integrations as Record<string, unknown>) || {}
  const next = { ...current }
  if (trimmed) next.figma = { file_url: trimmed }
  else delete next.figma

  const { error } = await admin.from('clients').update({ integrations: next }).eq('id', clientId)
  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard/apps/offer-intake')
  revalidatePath('/dashboard/offer-prepare')
  return { ok: true }
}

export async function saveMasterSheetUrl(clientId: string, url: string): Promise<ActionResult> {
  const _guard = await requireAdmin(); if (!_guard.ok) return { ok: false, error: _guard.error }
  const admin = createAdminClient()
  const trimmed = url.trim()
  const sheetId = trimmed ? extractSheetId(trimmed) : null
  if (trimmed && !sheetId) {
    return { ok: false, error: 'That doesn’t look like a Google Sheet link. Open the sheet and copy the URL from your browser (it contains /spreadsheets/d/…).' }
  }
  const { error } = await admin
    .from('clients')
    .update({ offer_master_sheet_url: trimmed || null, offer_master_sheet_id: sheetId })
    .eq('id', clientId)
  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard/apps/offer-intake')
  return { ok: true }
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

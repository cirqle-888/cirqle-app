'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin, resolveCurrentEmployeeId } from '@/lib/auth/enforce'
import { syncCampaignToSheet } from '@/lib/google-sheets/sync'
import { revalidatePath } from 'next/cache'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

// ── Load all clients with offer fields ───────────────────────────────────────

export async function getOfferClients(): Promise<ActionResult<{ clients: any[] }>> {
  const _guard = await requireAdmin(); if (!_guard.ok) return { ok: false, error: _guard.error }
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('clients')
    .select('id, name, code, is_active, offer_intake_token, offer_sheet_webhook_url')
    .eq('is_active', true)
    .order('name')
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: { clients: data || [] } }
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
  revalidatePath('/dashboard/settings/offer-intake')
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
  revalidatePath('/dashboard/settings/offer-intake')
  return { ok: true, data: { token: newToken } }
}

// ── Test sheet sync (uses most recent active campaign) ───────────────────────

export async function testSheetSync(clientId: string): Promise<ActionResult<{ message: string }>> {
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
  return { ok: true, data: { message: 'Sheet synced successfully ✓' } }
}

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
  revalidatePath('/dashboard/settings/offer-intake')
  return { ok: true, data: { token: newToken } }
}

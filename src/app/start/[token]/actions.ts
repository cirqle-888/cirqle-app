'use server'

/**
 * Client Hub — a single public link (clients.hub_token) that resolves to a
 * landing page listing every intake app a client's assigned services enable
 * (Standard Request, Offer Intake, future modules). Public, token-gated, no
 * employee session — mirrors the trust model of the offer-intake page's own
 * actions.ts (the unguessable token IS the auth), NOT the permission-gated
 * actions in apps/standard-request/actions.ts, which require a logged-in
 * admin and would reject this anonymous context.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { getClientIntakeKinds } from '@/lib/services/intake-server'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

async function resolveHubToken(token: string) {
  if (!token || token.length < 10) return null
  try {
    const admin = createAdminClient()
    const { data } = await admin
      .from('clients')
      .select('id, name, offer_intake_token')
      .eq('hub_token', token)
      .eq('is_active', true)
      .maybeSingle()
    return data || null
  } catch { return null }
}

/** Same friendly-token shape as apps/standard-request/actions.ts — duplicated
 * intentionally rather than imported, since that module's functions are
 * permission-gated for the admin dashboard and shouldn't be reachable from a
 * public, unauthenticated route. */
function friendlyToken(prefix: string | null | undefined): string {
  const slug = (prefix || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12)
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  const rand = Array.from(bytes, b => (b % 36).toString(36)).join('')
  return slug ? `${slug}-${rand}` : rand
}

export async function getClientHubData(token: string): Promise<ActionResult<{
  client: { id: string; name: string }
  kinds: string[]
  requestToken: string | null
  offerToken: string | null
  logoUrl: string | null
}>> {
  const client = await resolveHubToken(token)
  if (!client) return { ok: false, error: 'This link is no longer valid.' }

  const admin = createAdminClient()
  const kinds = await getClientIntakeKinds(client.id)

  let requestToken: string | null = null
  if (kinds.includes('request_portal')) {
    const { data: existing } = await admin
      .from('intake_links')
      .select('token')
      .eq('client_id', client.id)
      .eq('type', 'client')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (existing?.token) {
      requestToken = existing.token
    } else {
      // First time this client's hub has been opened with the request-portal
      // service enabled — provision the link on demand so an admin never has
      // to do a manual setup step before sharing the hub link.
      const { data: created } = await admin
        .from('intake_links')
        .insert({ token: friendlyToken(client.name), type: 'client', client_id: client.id, label: 'Client Hub' })
        .select('token')
        .single()
      requestToken = created?.token || null
    }
  }

  const offerToken = kinds.includes('offer_intake') ? client.offer_intake_token : null

  const [logoRes, logoDarkRes] = await Promise.all([
    admin.from('company_settings').select('value').eq('key', 'logo_url').maybeSingle(),
    admin.from('company_settings').select('value').eq('key', 'logo_url_dark').maybeSingle(),
  ])

  return {
    ok: true,
    data: {
      client: { id: client.id, name: client.name },
      kinds,
      requestToken,
      offerToken,
      logoUrl: (logoDarkRes.data?.value as string) || (logoRes.data?.value as string) || null,
    },
  }
}

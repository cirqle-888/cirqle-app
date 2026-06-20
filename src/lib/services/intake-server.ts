/**
 * Service-based intake routing — SERVER-ONLY derivation.
 *
 * Imports the admin client, so this file must only be imported from server
 * components / server actions, never from a client component. Client-safe
 * constants + pure helpers live in `intake.ts`.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { deriveIntakeKinds } from './intake'

/**
 * The intake forms a client can access, derived from the (active) services
 * assigned to them in client_service_pricing. Source of truth for client
 * capabilities — no separate client-module table.
 */
export async function getClientIntakeKinds(clientId: string): Promise<string[]> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('client_service_pricing')
    .select('service:services(intake_kind)')
    .eq('client_id', clientId)
    .eq('is_active', true)
  const rows = (data || []).map((r: any) => (Array.isArray(r.service) ? r.service[0] : r.service) || {})
  return deriveIntakeKinds(rows)
}

/**
 * Map of client_id → distinct intake kinds, for ALL clients in one query.
 * Use this on list pages (e.g. Offer Intake settings) instead of N per-client
 * calls.
 */
export async function getIntakeKindsByClient(): Promise<Map<string, string[]>> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('client_service_pricing')
    .select('client_id, service:services(intake_kind)')
    .eq('is_active', true)
  const byClient = new Map<string, Set<string>>()
  for (const r of (data || []) as any[]) {
    const svc = Array.isArray(r.service) ? r.service[0] : r.service
    const kind = svc?.intake_kind
    if (!kind || kind === 'none') continue
    if (!byClient.has(r.client_id)) byClient.set(r.client_id, new Set())
    byClient.get(r.client_id)!.add(kind)
  }
  return new Map([...byClient.entries()].map(([id, set]) => [id, [...set]]))
}

/** True when the client has at least one service whose intake_kind = 'offer_intake'. */
export async function clientHasOfferIntake(clientId: string): Promise<boolean> {
  return (await getClientIntakeKinds(clientId)).includes('offer_intake')
}

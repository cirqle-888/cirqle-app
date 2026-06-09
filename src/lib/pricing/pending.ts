import type { SupabaseClient } from '@supabase/supabase-js'

export interface PendingPricing {
  clients: { id: string; name: string }[]
  services: { id: string; name: string }[]
  total: number
}

/**
 * Clients/services flagged `pricing_pending` (created by a non-pricing user,
 * awaiting commercial details). Defensive: if the column doesn't exist yet
 * (migration not applied) it returns empty instead of throwing, so pages keep
 * rendering pre-migration.
 */
export async function getPendingPricing(admin: SupabaseClient): Promise<PendingPricing> {
  try {
    const [c, s] = await Promise.all([
      admin.from('clients').select('id, name').eq('pricing_pending', true).eq('is_active', true).order('name'),
      admin.from('services').select('id, name').eq('pricing_pending', true).eq('is_active', true).order('name'),
    ])
    if (c.error || s.error) return { clients: [], services: [], total: 0 }
    const clients = (c.data ?? []) as { id: string; name: string }[]
    const services = (s.data ?? []) as { id: string; name: string }[]
    return { clients, services, total: clients.length + services.length }
  } catch {
    return { clients: [], services: [], total: 0 }
  }
}

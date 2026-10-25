/**
 * How fresh a campaign's data is — one wording for every screen.
 */

import { STALE_SYNC_HOURS } from './attention'

export interface FreshnessInput {
  sync_enabled?: boolean | null
  ad_account_id?: string | null
  sync_status?: string | null
  last_sync_at?: string | null
  last_sync_error?: string | null
}

/** "Synced 3h ago" / "Never synced" / "Sync failed" / "Manual data". */
export function syncFreshness(p: FreshnessInput, now: Date = new Date()): { text: string; stale: boolean } {
  if (!p.sync_enabled || !p.ad_account_id) return { text: 'Manual data', stale: false }
  if (p.sync_status === 'error' || p.last_sync_error) return { text: 'Sync failed', stale: true }
  if (!p.last_sync_at) return { text: 'Never synced', stale: true }
  const h = (now.getTime() - new Date(p.last_sync_at).getTime()) / 3_600_000
  const text = h < 1 ? 'Synced just now' : h < 24 ? `Synced ${Math.floor(h)}h ago` : `Synced ${Math.floor(h / 24)}d ago`
  return { text, stale: h > STALE_SYNC_HOURS }
}

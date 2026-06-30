/**
 * Campaign discovery — lists every campaign in a shared ad account and records
 * it in `ad_campaigns` as the discovery + mapping registry.
 *
 * Mapping safety: this NEVER writes the mapping columns
 * (`mapping_status`, `client_id`, `project_id`, `campaign_type`). New campaigns
 * insert with the DB default `mapping_status='unmapped'`; existing campaigns get
 * only their provider-side fields refreshed — so a manual mapping is never
 * overwritten and freshly-created Meta campaigns surface as Unmapped.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getProvider } from '@/lib/advertising/providers'

export interface DiscoveryResult {
  discovered: number
  created: number
  updated: number
  error?: string
}

/**
 * Discover all campaigns in one ad account and upsert them into ad_campaigns.
 * Never throws — returns `{ error }` so cron loops can continue to the next
 * account. `trigger` is recorded on the ad_sync_logs row.
 */
export async function discoverAccountCampaigns(
  admin: SupabaseClient,
  accountId: string,
  trigger: 'manual' | 'scheduled' | 'initial' = 'manual',
): Promise<DiscoveryResult> {
  const startedAt = new Date().toISOString()

  // 1. Load the account + its connection token.
  const { data: account, error: accErr } = await admin
    .from('ad_accounts')
    .select(`
      id, provider, account_id, connection_id, client_id,
      connection:provider_connections ( access_token, status )
    `)
    .eq('id', accountId)
    .maybeSingle()

  if (accErr)   return { discovered: 0, created: 0, updated: 0, error: accErr.message }
  if (!account) return { discovered: 0, created: 0, updated: 0, error: 'Ad account not found' }

  const connection = Array.isArray(account.connection) ? account.connection[0] : account.connection
  const token = connection?.access_token
  if (!token || connection?.status !== 'active') {
    return { discovered: 0, created: 0, updated: 0, error: 'No active connection / access token' }
  }

  // 2. Pull all campaigns from the provider.
  let discovered
  try {
    const provider = getProvider(account.provider)
    discovered = await provider.searchCampaigns(account.account_id, token, '')
  } catch (err: any) {
    await logSync(admin, account, trigger, startedAt, 'error', 0, err?.message)
    return { discovered: 0, created: 0, updated: 0, error: err?.message || 'Discovery failed' }
  }

  if (discovered.length === 0) {
    await logSync(admin, account, trigger, startedAt, 'success', 0)
    return { discovered: 0, created: 0, updated: 0 }
  }

  // 3. Which campaigns are already known? (to report created vs updated and to
  //    keep mappings intact — we only ever touch provider-side columns).
  const { data: existingRows } = await admin
    .from('ad_campaigns')
    .select('external_campaign_id')
    .eq('ad_account_id', account.id)
  const known = new Set((existingRows ?? []).map(r => r.external_campaign_id))

  const seenAt = new Date().toISOString()
  const payload = discovered.map(c => ({
    ad_account_id:        account.id,
    connection_id:        account.connection_id,
    provider:             account.provider,
    external_campaign_id: c.campaign_id,
    name:                 c.name,
    objective:            c.objective ?? null,
    status:               c.effective_status ?? c.status ?? null,
    raw:                  c as any,
    last_seen_at:         seenAt,
    // Deliberately NOT setting mapping_status/client_id/project_id/campaign_type.
  }))

  // 4. Single upsert. Omitted mapping columns => defaults on insert, untouched
  //    on conflict-update.
  const { error: upErr } = await admin
    .from('ad_campaigns')
    .upsert(payload, { onConflict: 'ad_account_id,external_campaign_id' })

  if (upErr) {
    await logSync(admin, account, trigger, startedAt, 'error', 0, upErr.message)
    return { discovered: discovered.length, created: 0, updated: 0, error: upErr.message }
  }

  const created = discovered.filter(c => !known.has(c.campaign_id)).length
  const updated = discovered.length - created
  await logSync(admin, account, trigger, startedAt, 'success', discovered.length)

  return { discovered: discovered.length, created, updated }
}

async function logSync(
  admin: SupabaseClient,
  account: { provider: string; client_id: string | null },
  trigger: string,
  startedAt: string,
  status: 'success' | 'error',
  records: number,
  errorMessage?: string,
) {
  const finishedAt = new Date().toISOString()
  await admin.from('ad_sync_logs').insert({
    provider:        account.provider,
    client_id:       account.client_id,
    status,
    started_at:      startedAt,
    finished_at:     finishedAt,
    duration_ms:     new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
    records_imported: records,
    error_message:   errorMessage ?? null,
    trigger_source:  trigger,
  }).then(null, () => {})
}

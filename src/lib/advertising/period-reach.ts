/**
 * Unique reach for a campaign over a whole period, fetched from the provider.
 *
 * Summing daily reach counts a person reached on two days twice, so the
 * report used to show the sum as "Reach" — overstating the audience on any
 * multi-day report. The provider computes de-duplicated reach for a range;
 * this asks it. Anything that prevents an answer (no connection, expired
 * token, unsupported provider, API error) returns `available: false` with a
 * reason, and the report then labels the daily sum honestly instead.
 *
 * The figure is stored in the report snapshot, so a generated report keeps
 * the value it was built with.
 */

import { createAdminClient } from '@/lib/supabase/server'
import { getProvider } from '@/lib/advertising/providers'
import { decryptToken } from '@/lib/integrations/tokens'

export type PeriodReach =
  | { available: true; value: number; frequency?: number; source: string; fetchedAt: string }
  | { available: false; reason: string }

export async function fetchPeriodReach(
  projectId: string,
  dateFrom: string,
  dateTo: string,
): Promise<PeriodReach> {
  try {
    const admin = createAdminClient()
    const { data: project } = await admin
      .from('ad_projects')
      .select(`
        id, provider_metadata,
        ad_account:ad_accounts (
          provider, account_id,
          connection:provider_connections ( access_token, status )
        )
      `)
      .eq('id', projectId)
      .maybeSingle()

    const account = one(project?.ad_account)
    const connection = one(account?.connection)
    if (!project || !account || !connection) {
      return { available: false, reason: 'Campaign is not linked to a connected ad account.' }
    }
    if (connection.status !== 'active') return { available: false, reason: 'Ad account connection is not active.' }

    let provider
    try {
      provider = getProvider(account.provider)
    } catch {
      return { available: false, reason: `${account.provider} is not supported yet.` }
    }
    if (!provider.getCampaignPeriodReach) {
      return { available: false, reason: `${provider.name} does not report period reach.` }
    }
    const token = decryptToken(connection.access_token)
    if (!token) return { available: false, reason: 'Ad account token is missing.' }

    const res = await provider.getCampaignPeriodReach(account.account_id, token, project.provider_metadata, dateFrom, dateTo)
    if (!res) return { available: false, reason: 'No delivery in this period.' }
    return {
      available: true,
      value: res.reach,
      ...(res.frequency != null ? { frequency: res.frequency } : {}),
      source: provider.id,
      fetchedAt: new Date().toISOString(),
    }
  } catch (err) {
    // Never surface provider error bodies (they can echo request details).
    console.error('[period-reach] fetch failed', err instanceof Error ? err.message : err)
    return { available: false, reason: 'The ad platform did not return period reach.' }
  }
}

function one<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null
  return v ?? null
}

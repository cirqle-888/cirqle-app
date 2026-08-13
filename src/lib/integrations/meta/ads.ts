/**
 * Meta Marketing API — account / ad-set / ad level insights + breakdowns.
 *
 * The existing advertising module syncs at the campaign level into
 * ad_daily_metrics (that pipeline is untouched). This adds on-demand drill-down
 * used by the campaign detail + agency views: ad-set and ad breakdowns, and
 * demographic/placement breakdowns, fetched live (not persisted) so no new
 * tables are required. All calls go through the central client (v26, retries,
 * appsecret_proof, rate-limit handling).
 */

import { metaGraphAll } from './client'

export interface AdInsightRow {
  id: string
  name: string
  spend: number
  impressions: number
  reach: number
  clicks: number
  ctr: number | null
  cpc: number | null
  cpm: number | null
  leads: number
  cpl: number | null
  roas: number | null
  conversions: number
}

const INSIGHT_FIELDS = 'spend,impressions,reach,clicks,ctr,cpc,cpm,actions,purchase_roas'

function parseInsight(node: { name?: string; id?: string }, ins: any): AdInsightRow {
  let leads = 0
  let conversions = 0
  if (Array.isArray(ins?.actions)) {
    for (const a of ins.actions) {
      if (a.action_type === 'lead') leads += Number(a.value)
      if (a.action_type === 'offsite_conversion.fb_pixel_purchase' || a.action_type === 'purchase') conversions += Number(a.value)
    }
  }
  const spend = Number(ins?.spend ?? 0)
  const roasVal = Array.isArray(ins?.purchase_roas) && ins.purchase_roas[0] ? Number(ins.purchase_roas[0].value) : null
  return {
    id: node.id ?? '',
    name: node.name ?? '',
    spend,
    impressions: Number(ins?.impressions ?? 0),
    reach: Number(ins?.reach ?? 0),
    clicks: Number(ins?.clicks ?? 0),
    ctr: ins?.ctr != null ? Number(ins.ctr) : null,
    cpc: ins?.cpc != null ? Number(ins.cpc) : null,
    cpm: ins?.cpm != null ? Number(ins.cpm) : null,
    leads,
    cpl: leads > 0 ? Math.round((spend / leads) * 100) / 100 : null,
    roas: roasVal,
    conversions,
  }
}

/** Account-level totals for a date range. */
export async function getAccountInsights(
  accountId: string,
  token: string,
  since: string,
  until: string,
): Promise<AdInsightRow | null> {
  const act = accountId.startsWith('act_') ? accountId : `act_${accountId}`
  const rows = await metaGraphAll<any>(`${act}/insights`, {
    token,
    params: { level: 'account', fields: INSIGHT_FIELDS, time_range: { since, until } },
    maxPages: 1,
  })
  if (!rows.length) return null
  return parseInsight({ id: accountId, name: 'Account' }, rows[0])
}

/** Ad-sets under a campaign, each with its insights for the range. */
export async function getAdSetInsights(
  campaignId: string,
  token: string,
  since: string,
  until: string,
): Promise<AdInsightRow[]> {
  const adsets = await metaGraphAll<any>(`${campaignId}/adsets`, {
    token,
    params: { fields: `id,name,insights.time_range(${JSON.stringify({ since, until })}){${INSIGHT_FIELDS}}`, limit: 100 },
  })
  return adsets.map((as) => parseInsight(as, as.insights?.data?.[0] ?? {}))
}

/** Ads under a campaign (or ad-set), each with insights + creative name. */
export async function getAdInsights(
  parentId: string,
  token: string,
  since: string,
  until: string,
  parent: 'campaign' | 'adset' = 'campaign',
): Promise<AdInsightRow[]> {
  const edge = parent === 'campaign' ? 'ads' : 'ads'
  const ads = await metaGraphAll<any>(`${parentId}/${edge}`, {
    token,
    params: { fields: `id,name,insights.time_range(${JSON.stringify({ since, until })}){${INSIGHT_FIELDS}}`, limit: 200 },
  })
  return ads.map((ad) => parseInsight(ad, ad.insights?.data?.[0] ?? {}))
}

/** Demographic / placement breakdown for a campaign. */
export async function getBreakdown(
  campaignId: string,
  token: string,
  since: string,
  until: string,
  breakdown: 'age' | 'gender' | 'publisher_platform' | 'platform_position' | 'country' | 'region' | 'device_platform',
): Promise<Array<AdInsightRow & { segment: string }>> {
  const rows = await metaGraphAll<any>(`${campaignId}/insights`, {
    token,
    params: { level: 'campaign', fields: INSIGHT_FIELDS, breakdowns: breakdown, time_range: { since, until }, limit: 200 },
  })
  return rows.map((r) => ({
    ...parseInsight({ id: campaignId, name: r[breakdown] ?? 'unknown' }, r),
    segment: String(r[breakdown] ?? 'unknown'),
  }))
}

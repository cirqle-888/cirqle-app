import { AdProvider, AdAccountResponse, AdCampaignResponse, AdMetricsResponse } from './interface'
import {
  FACEBOOK_URL,
  exchangeForLongLivedToken,
  metaGraph,
  metaGraphAll,
} from '@/lib/integrations/meta/client'
import { decryptToken, encryptToken } from '@/lib/integrations/tokens'

export class MetaProvider implements AdProvider {
  readonly id = 'meta'
  readonly name = 'Meta Ads'
  readonly logoUrl = '/logos/meta-ads.svg'
  readonly capabilities = ['impressions', 'clicks', 'reach', 'spend', 'leads', 'revenue']

  getOAuthUrl(targetClientId: string, redirectUri: string, state: string): string {
    const clientId = process.env.META_APP_ID || process.env.META_CLIENT_ID
    if (!clientId) throw new Error('Meta OAuth not configured')
    const base = `${FACEBOOK_URL}/dialog/oauth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`

    // Apps registered under "Facebook Login for Business" (Business-Portfolio-owned
    // apps) must reference a saved Login Configuration via config_id — the
    // permission list is defined on the configuration itself, and a plain
    // `scope=` param is silently ignored, returning a token with zero granted
    // scopes. Fall back to `scope` only for classic (non-Business) apps that
    // have no configuration.
    const configId = process.env.META_LOGIN_CONFIG_ID
    if (configId) return `${base}&config_id=${configId}`

    return `${base}&scope=${META_OAUTH_SCOPES.join(',')}`
  }

  /**
   * Re-exchange the current long-lived token for a fresh one (~60 days) when it
   * is within the refresh window. Meta has no offline refresh_token grant for
   * user tokens — the supported path is fb_exchange_token while the current
   * token is still valid, which is why the token-refresh cron runs early.
   */
  async refreshTokenIfNeeded(connectionId: string): Promise<boolean> {
    const { createAdminClient } = await import('@/lib/supabase/admin')
    const admin = createAdminClient()
    const { data: conn } = await admin
      .from('provider_connections')
      .select('id, access_token, token_expires_at, status')
      .eq('id', connectionId)
      .single()
    if (!conn?.access_token) return false

    const expiresAt = conn.token_expires_at ? new Date(conn.token_expires_at).getTime() : 0
    const sevenDays = 7 * 24 * 60 * 60 * 1000
    if (expiresAt && expiresAt - Date.now() > sevenDays) return false

    const current = decryptToken(conn.access_token)
    if (!current) return false
    const refreshed = await exchangeForLongLivedToken(current)
    const expiresIn = refreshed.expires_in || 60 * 60 * 24 * 60
    await admin
      .from('provider_connections')
      .update({
        access_token: encryptToken(refreshed.access_token),
        token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
        status: 'active',
      })
      .eq('id', connectionId)
    return true
  }

  /** Exchange any still-valid token for a fresh long-lived token. */
  refreshToken = async (
    token: string,
  ): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> => {
    const refreshed = await exchangeForLongLivedToken(token)
    return {
      access_token: refreshed.access_token,
      expires_in: refreshed.expires_in || 60 * 60 * 24 * 60,
    }
  }

  async healthCheck(connectionId: string, accessToken: string): Promise<boolean> {
    try {
      await metaGraph('me', { token: accessToken, params: { fields: 'id' }, retries: 1 })
      return true
    } catch {
      return false
    }
  }

  async getAccounts(connectionId: string, accessToken: string): Promise<AdAccountResponse[]> {
    try {
      const accounts = await metaGraphAll<any>('me/adaccounts', {
        token: accessToken,
        params: { fields: 'account_id,name,currency,timezone_name,business', limit: 100 },
      })
      return accounts.map((acc: any) => ({
        account_id: acc.account_id,
        name: acc.name,
        business_id: acc.business?.id,
        currency: acc.currency,
        timezone: acc.timezone_name,
      }))
    } catch (err: any) {
      console.error('[MetaProvider] getAccounts error:', err?.message)
      throw err
    }
  }

  async searchCampaigns(accountId: string, accessToken: string, query: string): Promise<AdCampaignResponse[]> {
    // In Graph API, ad account id requires 'act_' prefix
    const prefixedAccountId = accountId.startsWith('act_') ? accountId : `act_${accountId}`
    const rows = await metaGraphAll<any>(`${prefixedAccountId}/campaigns`, {
      token: accessToken,
      params: { fields: 'id,name,status,effective_status,objective', limit: 200 },
    })

    const campaigns: AdCampaignResponse[] = rows.map((c: any) => ({
      campaign_id: c.id,
      name: c.name,
      status: c.status,
      effective_status: c.effective_status,
      objective: c.objective,
    }))

    if (query) {
      const q = query.toLowerCase()
      return campaigns.filter((c) => c.name.toLowerCase().includes(q))
    }
    return campaigns
  }

  async getCampaignInsights(
    accountId: string,
    accessToken: string,
    providerMetadata: any,
    startDate: string,
    endDate: string,
  ): Promise<AdMetricsResponse[]> {
    const campaignId = providerMetadata?.campaign_id
    if (!campaignId) {
      throw new Error('Meta provider requires campaign_id in provider_metadata')
    }

    const rows = await metaGraphAll<any>(`${campaignId}/insights`, {
      token: accessToken,
      params: {
        time_range: { since: startDate, until: endDate },
        time_increment: 1,
        fields: 'date_start,spend,impressions,clicks,reach,actions,purchase_roas',
        limit: 100,
      },
    })

    const results: AdMetricsResponse[] = []
    for (const row of rows) {
      let leads = 0

      if (Array.isArray(row.actions)) {
        for (const action of row.actions) {
          // 'lead' is Meta's total-leads rollup; do NOT also add the
          // onsite/offsite variants or leads double-count.
          if (action.action_type === 'lead') leads += Number(action.value)
        }
      }

      // Parse purchase ROAS (1.0 ROAS = spend == revenue)
      let roas = 0
      if (Array.isArray(row.purchase_roas) && row.purchase_roas.length > 0) {
        roas = Number(row.purchase_roas[0].value)
      }
      const revenue = Number(row.spend || 0) * roas

      results.push({
        metric_date: row.date_start,
        spend: Number(row.spend || 0),
        impressions: Number(row.impressions || 0),
        clicks: Number(row.clicks || 0),
        reach: Number(row.reach || 0),
        leads,
        revenue,
      })
    }
    return results
  }
}

/**
 * Scopes requested when no META_LOGIN_CONFIG_ID is configured (classic apps).
 * With Facebook Login for Business the permission set lives on the login
 * configuration in the Meta App Dashboard — keep both in sync.
 */
export const META_OAUTH_SCOPES = [
  // Ads
  'ads_read',
  'ads_management',
  'business_management',
  // Pages
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'pages_manage_metadata',
  'pages_manage_ads',
  // Added 2026-08-29 alongside the Meta login configuration (869229522906617),
  // which is what actually governs scopes while META_LOGIN_CONFIG_ID is set.
  // pages_read_user_content is what Facebook COMMENT counts need; without it
  // comments.summary fails and Meta discards the whole posts request.
  'pages_read_user_content',
  'pages_manage_engagement',
  'read_insights',
  'publish_video',
  // Instagram professional accounts
  'instagram_basic',
  'instagram_manage_insights',
  'instagram_content_publish',
  'instagram_manage_comments',
  // Deleting a published post needs this and nothing else — without it the
  // Graph API answers (#10) Insufficient permissions, which reads like a token
  // problem and is not one.
  'instagram_manage_contents',
  // Lead ads
  'leads_retrieval',
]

export const metaProvider = new MetaProvider()

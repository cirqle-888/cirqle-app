import { AdProvider, AdAccountResponse, AdCampaignResponse, AdMetricsResponse } from './interface'

export class MetaProvider implements AdProvider {
  readonly id = 'meta'
  readonly name = 'Meta Ads'
  readonly logoUrl = '/logos/meta-ads.svg'
  readonly capabilities = ['impressions', 'clicks', 'reach', 'spend', 'leads', 'revenue']

  getOAuthUrl(targetClientId: string, redirectUri: string, state: string): string {
    const clientId = process.env.META_APP_ID || process.env.META_CLIENT_ID
    if (!clientId) throw new Error('Meta OAuth not configured')
    const base = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`

    // Apps registered under "Facebook Login for Business" (Business-Portfolio-owned
    // apps) must reference a saved Login Configuration via config_id — the
    // permission list is defined on the configuration itself, and a plain
    // `scope=` param is silently ignored, returning a token with zero granted
    // scopes. Fall back to `scope` only for classic (non-Business) apps that
    // have no configuration.
    const configId = process.env.META_LOGIN_CONFIG_ID
    if (configId) return `${base}&config_id=${configId}`

    const scope = 'ads_management,ads_read,business_management'
    return `${base}&scope=${scope}`
  }

  async refreshTokenIfNeeded(connectionId: string): Promise<boolean> {
    // Meta long-lived tokens generally don't need active refreshing via a refresh token,
    // they last 60 days. If it's close to expiry, we'd exchange it.
    // For now, assume it's valid or handled by OAuth.
    return false
  }

  async healthCheck(connectionId: string, accessToken: string): Promise<boolean> {
    try {
      const res = await fetch(`https://graph.facebook.com/v19.0/me?access_token=${accessToken}`)
      return res.ok
    } catch {
      return false
    }
  }

  async getAccounts(connectionId: string, accessToken: string): Promise<AdAccountResponse[]> {
    const url = `https://graph.facebook.com/v19.0/me/adaccounts?fields=account_id,name,currency,timezone_name,business&access_token=${accessToken}`
    
    try {
      const res = await fetch(url)
      const data = await res.json()
      
      if (!res.ok) {
        throw new Error(data.error?.message || 'Failed to fetch Meta accounts')
      }

      return data.data.map((acc: any) => ({
        account_id: acc.account_id,
        name: acc.name,
        business_id: acc.business?.id,
        currency: acc.currency,
        timezone: acc.timezone_name,
      }))
    } catch (err: any) {
      console.error('[MetaProvider] getAccounts error:', err)
      throw err
    }
  }

  async searchCampaigns(accountId: string, accessToken: string, query: string): Promise<AdCampaignResponse[]> {
    // In Graph API, ad account id requires 'act_' prefix
    const prefixedAccountId = accountId.startsWith('act_') ? accountId : `act_${accountId}`
    const fields = 'id,name,status,effective_status,objective'
    let url: string | null =
      `https://graph.facebook.com/v19.0/${prefixedAccountId}/campaigns` +
      `?fields=${fields}&limit=200&access_token=${accessToken}`

    // Follow Graph API cursor pagination so agencies with >25 campaigns are not
    // silently truncated. Cap pages defensively to avoid a runaway loop.
    const campaigns: AdCampaignResponse[] = []
    let page = 0
    while (url && page < 50) {
      const res: Response = await fetch(url)
      const data: any = await res.json()
      if (!res.ok) throw new Error(data.error?.message || 'Failed to fetch campaigns')

      for (const c of data.data ?? []) {
        campaigns.push({
          campaign_id: c.id,
          name: c.name,
          status: c.status,
          effective_status: c.effective_status,
          objective: c.objective,
        })
      }
      url = data.paging?.next ?? null
      page++
    }

    if (query) {
      const q = query.toLowerCase()
      return campaigns.filter(c => c.name.toLowerCase().includes(q))
    }

    return campaigns
  }

  async getCampaignInsights(
    accountId: string,
    accessToken: string,
    providerMetadata: any,
    startDate: string,
    endDate: string
  ): Promise<AdMetricsResponse[]> {
    const campaignId = providerMetadata?.campaign_id
    if (!campaignId) {
      throw new Error('Meta provider requires campaign_id in provider_metadata')
    }

    const fields = [
      'date_start',
      'spend',
      'impressions',
      'clicks',
      'reach',
      'actions',
      'purchase_roas'
    ].join(',')

    const timeRange = encodeURIComponent(JSON.stringify({ since: startDate, until: endDate }))
    const url = `https://graph.facebook.com/v19.0/${campaignId}/insights?time_range=${timeRange}&time_increment=1&fields=${fields}&access_token=${accessToken}`

    try {
      const res = await fetch(url)
      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error?.message || 'Failed to fetch Meta insights')
      }

      const results: AdMetricsResponse[] = []
      
      for (const row of data.data || []) {
        let leads = 0
        let revenue = 0

        if (Array.isArray(row.actions)) {
          for (const action of row.actions) {
            if (action.action_type === 'lead') leads += Number(action.value)
          }
        }

        // Parse purchase ROAS (assuming 1.0 ROAS = spend == revenue)
        let roas = 0
        if (Array.isArray(row.purchase_roas) && row.purchase_roas.length > 0) {
          roas = Number(row.purchase_roas[0].value)
        }
        revenue = (Number(row.spend || 0)) * roas

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
    } catch (err: any) {
      console.error('[MetaProvider] getCampaignInsights error:', err)
      throw err
    }
  }
}

export const metaProvider = new MetaProvider()

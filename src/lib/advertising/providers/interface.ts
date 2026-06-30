export interface AdAccountResponse {
  account_id: string
  name: string
  business_id?: string
  currency?: string
  timezone?: string
}

export interface AdCampaignResponse {
  campaign_id: string
  name: string
  status: string
  objective?: string
  /** Provider's computed delivery status (e.g. Meta effective_status), when available. */
  effective_status?: string
}

export interface AdMetricsResponse {
  metric_date: string // YYYY-MM-DD
  spend: number
  impressions: number
  clicks: number
  reach?: number
  leads?: number
  revenue?: number
}

export interface AdProvider {
  /**
   * The canonical identifier for this provider (e.g., 'meta', 'google')
   */
  readonly id: string

  /**
   * Display name of the provider (e.g., 'Meta Ads')
   */
  readonly name: string

  /**
   * URL to the provider's logo (can be a local path or external URL)
   */
  readonly logoUrl?: string

  /**
   * Capabilities supported by this provider (e.g., ['leads', 'purchases', 'video_views'])
   */
  readonly capabilities: string[]

  /**
   * Generates the OAuth URL to begin the connection process.
   */
  getOAuthUrl(targetClientId: string, redirectUri: string, state: string): string

  /**
   * Refreshes the OAuth access token if necessary.
   * Returns true if token was refreshed.
   */
  refreshTokenIfNeeded(connectionId: string): Promise<boolean>

  /**
   * Performs a health check on the connection.
   */
  healthCheck(connectionId: string, accessToken: string): Promise<boolean>

  /**
   * Returns a list of ad accounts accessible via this connection.
   */
  getAccounts(connectionId: string, accessToken: string): Promise<AdAccountResponse[]>

  /**
   * Searches for campaigns matching a query across a specific account.
   */
  searchCampaigns(accountId: string, accessToken: string, query: string): Promise<AdCampaignResponse[]>

  /**
   * Returns daily metrics for a specific campaign between two dates.
   */
  getCampaignInsights(
    accountId: string,
    accessToken: string,
    providerMetadata: any,
    startDate: string,
    endDate: string
  ): Promise<AdMetricsResponse[]>

  /**
   * Optional: Refresh OAuth token
   */
  refreshToken?: (refreshToken: string) => Promise<{ access_token: string, refresh_token?: string, expires_in?: number }>
}

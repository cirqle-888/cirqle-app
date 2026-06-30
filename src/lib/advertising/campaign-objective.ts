/**
 * Maps a provider's raw campaign objective to a Cirqle `campaign_type`.
 *
 * `campaign_type` is the enum used on ad_projects (see 20260628120000_
 * advertising_module.sql): awareness / reach / traffic / engagement / leads /
 * messages / sales / conversion / remarketing / app_install / video_views.
 *
 * Meta exposes two generations of objectives: the current ODAX "OUTCOME_*"
 * set and the legacy set. Both are handled. Unknown values return `null` so the
 * mapping UI falls back to "let the user choose".
 */

export type CampaignType =
  | 'awareness' | 'reach' | 'traffic' | 'engagement' | 'leads'
  | 'messages' | 'sales' | 'conversion' | 'remarketing'
  | 'app_install' | 'video_views'

/** Ordered list for objective dropdowns (single source of truth for the UI). */
export const CIRQLE_CAMPAIGN_TYPES: { value: CampaignType; label: string }[] = [
  { value: 'awareness',   label: 'Awareness' },
  { value: 'reach',       label: 'Reach' },
  { value: 'traffic',     label: 'Traffic' },
  { value: 'engagement',  label: 'Engagement' },
  { value: 'leads',       label: 'Leads' },
  { value: 'messages',    label: 'Messages' },
  { value: 'sales',       label: 'Sales' },
  { value: 'conversion',  label: 'Conversions' },
  { value: 'remarketing', label: 'Remarketing' },
  { value: 'app_install', label: 'App Installs' },
  { value: 'video_views', label: 'Video Views' },
]

const META_OBJECTIVE_MAP: Record<string, CampaignType> = {
  // ODAX (current)
  OUTCOME_AWARENESS:     'awareness',
  OUTCOME_TRAFFIC:       'traffic',
  OUTCOME_ENGAGEMENT:    'engagement',
  OUTCOME_LEADS:         'leads',
  OUTCOME_SALES:         'sales',
  OUTCOME_APP_PROMOTION: 'app_install',
  // Legacy
  BRAND_AWARENESS:        'awareness',
  REACH:                  'reach',
  LINK_CLICKS:            'traffic',
  POST_ENGAGEMENT:        'engagement',
  PAGE_LIKES:             'engagement',
  EVENT_RESPONSES:        'engagement',
  VIDEO_VIEWS:            'video_views',
  LEAD_GENERATION:        'leads',
  MESSAGES:               'messages',
  CONVERSIONS:            'conversion',
  CATALOG_SALES:          'sales',
  PRODUCT_CATALOG_SALES:  'sales',
  STORE_VISITS:           'sales',
  APP_INSTALLS:           'app_install',
}

/**
 * @param metaObjective raw provider objective (any provider; Meta keys handled)
 * @returns Cirqle campaign_type, or null when unrecognised / empty.
 */
export function metaObjectiveToCampaignType(metaObjective?: string | null): CampaignType | null {
  if (!metaObjective) return null
  const key = metaObjective.trim().toUpperCase()
  return META_OBJECTIVE_MAP[key] ?? null
}

const VALID = new Set<string>(CIRQLE_CAMPAIGN_TYPES.map(t => t.value))

/** Type guard / validator for a user- or API-supplied campaign_type string. */
export function isCampaignType(value?: string | null): value is CampaignType {
  return !!value && VALID.has(value)
}

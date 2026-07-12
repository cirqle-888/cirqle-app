/**
 * Advertising module — shared types & display maps.
 *
 * Pure, framework-agnostic (no 'use server'/'use client') so it can be imported
 * by server actions, client components, and unit tests alike. Mirrors the
 * status-chip convention from src/lib/requests/core.ts.
 */

// ─── Enums (kept as text in the DB; these are the allowed values) ────────────

export type AdPlatform =
  | 'meta' | 'google' | 'instagram' | 'facebook' | 'linkedin'
  | 'tiktok' | 'youtube' | 'x' | 'snapchat' | 'custom'

export type AdCampaignType =
  | 'awareness' | 'reach' | 'traffic' | 'engagement' | 'leads' | 'messages'
  | 'sales' | 'conversion' | 'remarketing' | 'app_install' | 'video_views'

export type AdStatus =
  | 'draft' | 'pending_approval' | 'active' | 'paused' | 'completed' | 'cancelled'

export type AdMetricStatus = 'draft' | 'submitted' | 'approved'

export type ServiceChargeType = 'fixed' | 'percent'

/** How the advertising spend budget was entered. */
export type BudgetInputMode = 'total' | 'daily'

/** Duration presets for the daily-budget mode (value = number of days, or 'custom'). */
export const DURATION_PRESETS: { value: string; label: string }[] = [
  { value: '7',      label: '7 days' },
  { value: '14',     label: '14 days' },
  { value: '30',     label: '1 month (30 days)' },
  { value: 'custom', label: 'Date range (start → end)' },
]

// ─── Option lists (drive the create/edit dropdowns) ──────────────────────────

export const PLATFORMS: { value: AdPlatform; label: string }[] = [
  { value: 'meta',      label: 'Meta' },
  { value: 'google',    label: 'Google' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'facebook',  label: 'Facebook' },
  { value: 'linkedin',  label: 'LinkedIn' },
  { value: 'tiktok',    label: 'TikTok' },
  { value: 'youtube',   label: 'YouTube' },
  { value: 'x',         label: 'X' },
  { value: 'snapchat',  label: 'Snapchat' },
  { value: 'custom',    label: 'Custom' },
]

export const CAMPAIGN_TYPES: { value: AdCampaignType; label: string }[] = [
  { value: 'awareness',   label: 'Awareness' },
  { value: 'reach',       label: 'Reach' },
  { value: 'traffic',     label: 'Traffic' },
  { value: 'engagement',  label: 'Engagement' },
  { value: 'leads',       label: 'Leads' },
  { value: 'messages',    label: 'Messages' },
  { value: 'sales',       label: 'Sales' },
  { value: 'conversion',  label: 'Conversion' },
  { value: 'remarketing', label: 'Remarketing' },
  { value: 'app_install', label: 'App Install' },
  { value: 'video_views', label: 'Video Views' },
]

export const STATUSES: { value: AdStatus; label: string }[] = [
  { value: 'draft',            label: 'Draft' },
  { value: 'pending_approval', label: 'Pending Approval' },
  { value: 'active',           label: 'Active' },
  { value: 'paused',           label: 'Paused' },
  { value: 'completed',        label: 'Completed' },
  { value: 'cancelled',        label: 'Cancelled' },
]

export const PLATFORM_LABEL: Record<string, string> =
  Object.fromEntries(PLATFORMS.map(p => [p.value, p.label]))
export const CAMPAIGN_TYPE_LABEL: Record<string, string> =
  Object.fromEntries(CAMPAIGN_TYPES.map(t => [t.value, t.label]))
export const STATUS_LABEL: Record<string, string> =
  Object.fromEntries(STATUSES.map(s => [s.value, s.label]))

/** Status chip styling (mirrors requests/core.ts STATUS_CHIP). */
export const AD_STATUS_CHIP: Record<string, string> = {
  draft:            'bg-secondary text-muted-foreground border-border',
  pending_approval: 'bg-amber-500/12 text-amber-700 border-amber-500/25 dark:text-amber-400',
  active:           'bg-green-500/12 text-green-700 border-green-500/25 dark:text-green-400',
  paused:           'bg-orange-500/12 text-orange-700 border-orange-500/25 dark:text-orange-400',
  completed:        'bg-emerald-500/12 text-emerald-700 border-emerald-500/25 dark:text-emerald-400',
  cancelled:        'bg-red-500/10 text-red-700/80 border-red-500/20 dark:text-red-400/80',
}

// ─── Row shapes (Supabase returns snake_case; kept loose like requests core) ──

export interface AdProjectRow {
  id: string
  client_id: string | null
  request_id: string | null
  service_id?: string | null
  campaign_name: string
  platform: AdPlatform | string
  campaign_type: AdCampaignType | string | null
  status: AdStatus | string
  ad_budget_amount: number
  ad_budget_currency: string
  service_charge_type: ServiceChargeType | string
  service_charge_value: number
  tax_percent: number
  /** Budget entry metadata (optional — added by the daily-budget migration). */
  budget_input_mode?: BudgetInputMode | string | null
  daily_budget?: number | null
  budget_days?: number | null
  objective: string | null
  optimization_goal: string | null
  start_date: string | null
  end_date: string | null
  notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  archived_at?: string | null

  // --- Phase 2: ERP Architecture ---
  ad_account_id?: string | null
  external_campaign_id?: string | null
  provider_metadata?: any | null
  tracking_config?: any | null
  sync_enabled?: boolean
  sync_status?: 'idle' | 'queued' | 'running' | 'error' | string
  last_sync_at?: string | null
  last_sync_error?: string | null
  approval_status?: 'pending' | 'approved' | 'rejected' | string | null
  approved_by?: string | null
  approved_at?: string | null
}

export interface AdDailyMetricRow {
  id: string
  project_id: string
  metric_date: string
  spend: number | null
  revenue: number | null
  cpc: number | null
  cpm: number | null
  cpr: number | null
  result_cost: number | null
  remaining_budget: number | null
  currency: string
  reach: number | null
  impressions: number | null
  clicks: number | null
  conversions: number | null
  leads: number | null
  messages: number | null
  purchases: number | null
  video_views: number | null
  landing_page_views: number | null
  adds_to_cart: number | null
  checkouts: number | null
  ctr: number | null
  roas: number | null
  frequency: number | null
  notes: string | null
  status: AdMetricStatus | string
  entered_by: string | null
  approved_by: string | null
  approved_at: string | null
  created_at: string
  updated_at: string
  source?: string // 'Manual', 'Meta API', etc
  sync_state?: 'imported' | 'manual' | 'locked' | string
  version?: number
  base_currency?: string
  ad_currency?: string
  billing_currency?: string
  exchange_rate_ad_to_base?: number
  exchange_rate_ad_to_billing?: number
}

/** REF label for a campaign (mirrors requests' REQ-0042). */
export function adRefLabel(shortId: string | null | undefined): string {
  const s = (shortId ?? '').replace(/-/g, '')
  return `AD-${s.slice(0, 6).toUpperCase()}`
}

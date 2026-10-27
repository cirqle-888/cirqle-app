/**
 * Ad funds — row shapes for the tables the funds code reads, plus tiny cast
 * helpers. The admin client is untyped (createClient<any>), so every read
 * comes back as `any`; narrowing it ONCE here keeps the funds code typed.
 */

import type { FundingStatus } from './funds-core'

/** A PostgREST embed can arrive as an object or a one-element array. */
export type Embed<T> = T | T[] | null | undefined
export const one = <T>(v: Embed<T>): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null)

export const asRows = <T>(data: unknown): T[] => (Array.isArray(data) ? (data as T[]) : [])
export const asRow = <T>(data: unknown): T | null => (data && typeof data === 'object' ? (data as T) : null)

export const errorMessage = (err: unknown, fallback: string): string =>
  err instanceof Error ? err.message : typeof err === 'string' ? err : fallback

export interface ConnectionRow { access_token: string | null; status: string | null }

export interface AdAccountRow {
  id: string
  name: string
  provider: string
  account_id: string
  currency: string | null
  is_active?: boolean | null
  billing_available_balance?: number | string | null
  billing_funding_display?: string | null
  billing_synced_at?: string | null
  billing_sync_error?: string | null
  connection?: Embed<ConnectionRow>
}

export interface AdProjectLite {
  id: string
  campaign_name: string
  client_id: string | null
  ad_account_id: string | null
  status: string
  scope: string | null
  platform?: string | null
  provider_metadata: { campaign_id?: string | number | null } | null
}

export interface AdCampaignRegistryRow {
  ad_account_id: string
  external_campaign_id: string
  client_id: string | null
  project_id: string | null
}

export interface FundingEventRow {
  id: string
  ad_account_id: string
  status: FundingStatus
  amount: number | string | null
  event_time: string
  cashbook_entry_id: string | null
  suggested_client_id: string | null
  dismissed_at: string | null
}

export interface TopUpEntryRow {
  id: string
  ad_account_id: string | null
  client_id?: string | null
  amount: number | string | null
  amount_inr?: number | string | null
  entry_date: string
  description?: string | null
}

export interface CampaignSpendRow {
  ad_account_id?: string
  external_campaign_id: string
  campaign_name?: string | null
  spend_date: string
  spend: number | string | null
}

export interface DailyMetricRow {
  project_id?: string
  metric_date: string
  spend: number | string | null
  exchange_rate_ad_to_base: number | string | null
}

export interface InvoiceRef {
  id?: string
  invoice_number?: string | null
  status: string
  client_id?: string | null
  billing_period_start?: string | null
  issue_date?: string | null
  currency?: string | null
  exchange_rate?: number | string | null
}

export interface ExpenseLineRow {
  id: string
  invoice_id?: string
  kind?: string
  amount_inr: number | string | null
  description?: string | null
  ad_project_id?: string | null
  ad_period?: string | null
  invoice?: Embed<InvoiceRef>
  entry?: Embed<{ ad_account_id: string | null; category?: Embed<{ account_code: string | null }> }>
}

export const num = (v: number | string | null | undefined): number => Number(v ?? 0) || 0

/**
 * FX rate synchronisation (server-only).
 *
 * Fetches daily reference rates from the **keyless** ExchangeRate-API "open"
 * endpoint (`https://open.er-api.com/v6/latest/INR`) and stores a `rate_to_inr`
 * for each supported foreign currency. One request refreshes every currency and
 * — unlike Frankfurter/ECB — covers the Gulf pegs (SAR/AED/QAR) Cirqle needs.
 *
 * Imported only by settings/actions.ts (`'use server'`); never bundled to the
 * client. Set `FX_API_URL` to swap to the keyed endpoint if rate limits bite.
 */
import { createAdminClient } from '@/lib/supabase/admin'

// INR is the base currency; we track a rate_to_inr for each of these.
const FX_CURRENCIES = ['USD', 'EUR', 'SAR', 'AED', 'GBP', 'QAR'] as const
const FX_ENDPOINT = process.env.FX_API_URL || 'https://open.er-api.com/v6/latest/INR'

export interface FxSyncResult {
  ok: boolean
  error?: string
  updated?: number
  rateDate?: string
  rates?: Record<string, number>
}

/**
 * Fetch and normalise rates to `rate_to_inr` (INR per 1 unit of the foreign
 * currency). The endpoint returns units-of-CUR-per-1-INR, so we invert.
 */
export async function fetchRates(): Promise<{
  ok: boolean
  error?: string
  rates?: Record<string, number>
  rateDate?: string
}> {
  try {
    const res = await fetch(FX_ENDPOINT, { cache: 'no-store' })
    if (!res.ok) return { ok: false, error: `FX API HTTP ${res.status}` }
    const json: {
      result?: string
      rates?: Record<string, number>
      time_last_update_utc?: string
      ['error-type']?: string
    } = await res.json()

    if (json?.result !== 'success' || !json?.rates) {
      return { ok: false, error: json?.['error-type'] || 'FX API returned no rates' }
    }

    const perInr = json.rates
    const rates: Record<string, number> = {}
    for (const cur of FX_CURRENCIES) {
      const v = perInr[cur]
      if (typeof v === 'number' && v > 0) {
        rates[cur] = Math.round((1 / v) * 1e6) / 1e6 // rate_to_inr, 6 dp
      }
    }

    const rateDate = json.time_last_update_utc
      ? new Date(json.time_last_update_utc).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10)

    return { ok: true, rates, rateDate }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'FX fetch failed' }
  }
}

/** Fetch fresh rates and upsert them into `exchange_rates` with `rate_source='api'`. */
export async function syncRatesToDb(): Promise<FxSyncResult> {
  const fetched = await fetchRates()
  if (!fetched.ok || !fetched.rates) return { ok: false, error: fetched.error }

  const entries = Object.entries(fetched.rates)
  if (entries.length === 0) return { ok: false, error: 'No usable rates returned' }

  const now = new Date().toISOString()
  const rows = entries.map(([currency, rate_to_inr]) => ({
    currency,
    rate_to_inr,
    rate_source: 'api',
    rate_date: fetched.rateDate,
    last_updated: now,
  }))

  const admin = createAdminClient()
  const { error } = await admin.from('exchange_rates').upsert(rows, { onConflict: 'currency' })
  if (error) return { ok: false, error: error.message }

  return { ok: true, updated: rows.length, rateDate: fetched.rateDate, rates: fetched.rates }
}

/** True when the freshest stored rate is older than `maxHours` (or none exist). */
export async function ratesAreStale(maxHours: number): Promise<boolean> {
  if (maxHours <= 0) return true // 0 / negative = "always refresh" (useful for testing)
  const admin = createAdminClient()
  const { data } = await admin
    .from('exchange_rates')
    .select('last_updated')
    .order('last_updated', { ascending: false })
    .limit(1)
  const latest = data?.[0]?.last_updated
  if (!latest) return true
  const ageHours = (Date.now() - new Date(latest as string).getTime()) / 36e5
  return ageHours >= maxHours
}

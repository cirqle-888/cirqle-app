import { unstable_cache } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * Shared, cached read of the whole `company_settings` key/value table.
 *
 * EGRESS: several pages used to run their own unfiltered
 * `from('company_settings').select('key, value')` on every render. That table
 * holds the branding blobs — the Settings uploader writes logos as base64 data
 * URLs (`settings-client.tsx`, `reader.readAsDataURL`), and `/api/logo` still
 * branches on `startsWith('data:image/')`, so those rows can be hundreds of KB
 * each. Under `force-dynamic` that meant re-downloading the logo from Postgres
 * on every page view, for every user.
 *
 * One cached fetch, shared by every caller, refreshed every 5 minutes. Settings
 * writes call `revalidateCompanySettings()` so saves still show up immediately.
 */
export type CompanySettings = Record<string, string>

export const COMPANY_SETTINGS_TAG = 'company-settings'

const load = unstable_cache(
  async (): Promise<CompanySettings> => {
    const admin = createAdminClient()
    const { data } = await admin.from('company_settings').select('key, value')
    return Object.fromEntries(
      (data || []).map((r: { key: string; value: string | null }) => [r.key, r.value ?? '']),
    )
  },
  ['company-settings-all'],
  { revalidate: 300, tags: [COMPANY_SETTINGS_TAG] },
)

/** Never throws — returns {} if the table is unreachable, matching the previous
 *  per-call-site try/catch behaviour so pages keep rendering. */
export async function getCompanySettings(): Promise<CompanySettings> {
  try {
    return await load()
  } catch {
    return {}
  }
}

/**
 * Only the named keys — for a page that hands settings to the BROWSER.
 *
 * The table is one key/value bag: branding sits next to the bank account, the
 * WhatsApp listener's staff phone list and gateway state. A client component
 * given the whole map gives all of that to whoever opens the page, whatever
 * the page actually uses. Pass the keys a screen needs and nothing else.
 */
export function pickCompanySettings(settings: CompanySettings, keys: readonly string[]): CompanySettings {
  const out: CompanySettings = {}
  for (const k of keys) if (settings[k] !== undefined) out[k] = settings[k]
  return out
}

/**
 * Everything except the keys no screen should receive: integration state and
 * anything that reads like a credential. For finance screens that legitimately
 * need the company's own invoice and bank details, but not the staff phone
 * list or a gateway session.
 */
export function withoutPrivateSettings(settings: CompanySettings): CompanySettings {
  const out: CompanySettings = {}
  for (const [k, v] of Object.entries(settings)) {
    if (/^whatsapp_listener_|^openwa_|token|secret|password|api_key|apikey|session|webhook/i.test(k)) continue
    out[k] = v
  }
  return out
}


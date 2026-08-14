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

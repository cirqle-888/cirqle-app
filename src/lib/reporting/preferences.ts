/**
 * Saved per-client report preferences (migration
 * 20261025190000_ad_client_report_preferences). Server-only reads; the
 * composer receives them as plain data.
 */

import type { ReportRecipient } from './types'
import type { ComposerPeriod, PresetKey } from './presets'

export interface ClientReportPreferences {
  clientId: string
  preset: PresetKey
  period: Exclude<ComposerPeriod, 'custom'>
  language?: 'en' | 'ml'
  includeComparison: boolean
  /** Empty = every eligible campaign. */
  defaultProjectIds: string[]
  recipients: ReportRecipient[]
}

/** Preferences per client id; `supported` is false before the migration. */
export async function loadClientReportPreferences(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- either Supabase admin client
  admin: { from: (table: string) => any },
  clientIds?: string[],
): Promise<{ supported: boolean; byClient: Record<string, ClientReportPreferences> }> {
  let q = admin.from('ad_client_report_preferences')
    .select('client_id, preset, period, include_comparison, default_project_ids, recipients, language')
  if (clientIds) q = q.in('client_id', clientIds)
  const { data, error } = await q.then((r: unknown) => r, () => ({ data: null, error: { message: 'missing' } }))
  if (error) return { supported: false, byClient: {} }
  const byClient: Record<string, ClientReportPreferences> = {}
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    byClient[r.client_id as string] = {
      clientId: r.client_id as string,
      preset: r.preset as PresetKey,
      period: r.period as ClientReportPreferences['period'],
      language: r.language === 'ml' ? 'ml' : 'en',
      includeComparison: r.include_comparison !== false,
      defaultProjectIds: Array.isArray(r.default_project_ids) ? (r.default_project_ids as string[]) : [],
      recipients: Array.isArray(r.recipients) ? (r.recipients as ReportRecipient[]) : [],
    }
  }
  return { supported: true, byClient }
}

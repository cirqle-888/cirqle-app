'use server'

import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { createAdminClient } from '@/lib/supabase/server'
import { parseRecipients } from '@/lib/reporting/config'
import { COMPOSER_PERIODS, REPORT_PRESETS } from '@/lib/reporting/presets'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Save a client's report defaults (preset, period, comparison, campaigns,
 * recipients). Every campaign must belong to that client. Needs migration
 * 20261025190000_ad_client_report_preferences.
 */
export async function saveClientReportPreferences(input: {
  clientId: string
  preset: string
  period: string
  includeComparison: boolean
  defaultProjectIds: string[]
  language?: 'en' | 'ml'
  recipients: unknown
}): Promise<{ ok: boolean; error?: string }> {
  const guard = await requirePermission(PERMS.ADVERTISING_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  if (!UUID.test(input.clientId)) return { ok: false, error: 'Unknown client.' }
  if (!REPORT_PRESETS.some(p => p.key === input.preset)) return { ok: false, error: 'Unknown preset.' }
  if (!COMPOSER_PERIODS.some(p => p.key === input.period) || input.period === 'custom') {
    return { ok: false, error: 'Pick a standard period to save as the default.' }
  }
  const ids = [...new Set(Array.isArray(input.defaultProjectIds) ? input.defaultProjectIds : [])]
  if (ids.some(id => !UUID.test(id)) || ids.length > 20) return { ok: false, error: 'Invalid campaign selection.' }
  const recipients = parseRecipients(input.recipients)
  if (!recipients.ok) return { ok: false, error: recipients.error }

  const admin = createAdminClient()
  if (ids.length) {
    const { data } = await admin.from('ad_projects').select('id, client_id').in('id', ids).is('deleted_at', null)
    if ((data ?? []).length !== ids.length || (data ?? []).some(r => r.client_id !== input.clientId)) {
      return { ok: false, error: 'Every default campaign must belong to this client.' }
    }
  }

  const { error } = await admin.from('ad_client_report_preferences').upsert({
    client_id: input.clientId,
    preset: input.preset,
    period: input.period,
    include_comparison: input.includeComparison === true,
    default_project_ids: ids,
    recipients: recipients.value,
    language: input.language === 'ml' ? 'ml' : 'en',
    updated_by: guard.employeeId || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'client_id' })
  if (error) return { ok: false, error: 'Saving defaults is not set up yet.' }
  revalidatePath('/dashboard/advertising/reports')
  return { ok: true }
}

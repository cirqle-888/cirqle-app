/**
 * Business partners for filter pickers (invoices page, cash book entry form).
 *
 * Names and codes only — no figures — so it is safe to send to any user who
 * can already see the client list. Defensive like the follow-ups page: a
 * missing `business_partners` table returns [] instead of taking the page down.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export interface PartnerOption {
  id: string
  name: string
  code: string | null
}

export async function listPartnerOptions(supabase: SupabaseClient): Promise<PartnerOption[]> {
  try {
    const { data, error } = await supabase
      .from('business_partners')
      .select('id, name, partner_code, status')
      .order('name')
    if (error || !data) return []
    return (data as { id: string; name: string; partner_code: string | null; status: string | null }[])
      .filter(p => p.status !== 'inactive')
      .map(p => ({ id: p.id, name: p.name, code: p.partner_code }))
  } catch {
    return []
  }
}

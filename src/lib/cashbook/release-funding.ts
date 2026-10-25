/**
 * Release the campaign funding an entry backs — when the entry is deleted,
 * or the money it recorded is returned by the bank.
 *
 * Campaign fund allocations are soft-deleted and each affected campaign's
 * billing re-derived; wallet CREDITS funded by the entry are soft-deleted
 * (ledger rows stay for audit). Campaign debits are left alone — committed
 * money is a finance decision, and any resulting negative wallet balance
 * surfaces on the Advertising dashboard.
 *
 * Best-effort: both tables are optional migrations.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { recomputeCampaignBilling } from '@/lib/advertising/billing'

export async function releaseEntryFunding(admin: SupabaseClient, entryId: string): Promise<void> {
  const now = new Date().toISOString()
  try {
    const { data: allocs } = await admin
      .from('ad_fund_allocations').select('id, ad_project_id')
      .eq('cashbook_entry_id', entryId).is('deleted_at', null)
    if (allocs && allocs.length > 0) {
      await admin.from('ad_fund_allocations')
        .update({ deleted_at: now })
        .eq('cashbook_entry_id', entryId).is('deleted_at', null)
      const projectIds = [...new Set(allocs.map((a: any) => a.ad_project_id as string))]
      for (const pid of projectIds) await recomputeCampaignBilling(admin, pid)
    }
  } catch { /* ad_fund_allocations not migrated */ }

  try {
    await admin.from('ad_wallet_ledger')
      .update({ deleted_at: now })
      .eq('cashbook_entry_id', entryId).eq('direction', 'credit').is('deleted_at', null)
  } catch { /* ad_wallet_ledger not migrated */ }
}

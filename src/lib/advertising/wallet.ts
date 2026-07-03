/**
 * Advertising — client wallet ledger (server-only).
 *
 * A proper financial ledger over ad_wallet_ledger: every movement is a
 * transaction row, balances are ALWAYS derived from the rows, never stored.
 *
 *   credit 'topup'               Cashbook outflow share → client wallet
 *   debit  'campaign_allocation' client wallet → campaign (billing basis)
 *
 * Amounts are GST-inclusive actual paid money. Platform-reported spend
 * (ad_daily_metrics) is reporting-only and never enters the ledger.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const round2 = (v: number) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100

export interface WalletSummary {
  clientId: string
  /** Σ active credits (top-up shares), INR. */
  creditedInr: number
  /** Σ active campaign-allocation debits, INR. */
  allocatedInr: number
  /** creditedInr − allocatedInr. */
  balanceInr: number
}

export interface LedgerRow {
  id: string
  client_id: string
  direction: 'credit' | 'debit'
  kind: string
  cashbook_entry_id: string | null
  ad_project_id: string | null
  amount: number
  amount_inr: number
  notes: string | null
  created_by: string | null
  created_at: string
}

/** Derives wallet summaries for a set of clients from the ledger. */
export async function getWalletSummaries(
  admin: SupabaseClient, clientIds: string[],
): Promise<Record<string, WalletSummary>> {
  const out: Record<string, WalletSummary> = {}
  if (clientIds.length === 0) return out
  try {
    const { data, error } = await admin
      .from('ad_wallet_ledger')
      .select('client_id, direction, amount_inr')
      .in('client_id', clientIds)
      .is('deleted_at', null)
    if (error || !data) return out
    for (const r of data as any[]) {
      const s = (out[r.client_id] ||= { clientId: r.client_id, creditedInr: 0, allocatedInr: 0, balanceInr: 0 })
      if (r.direction === 'credit') s.creditedInr = round2(s.creditedInr + Number(r.amount_inr || 0))
      else s.allocatedInr = round2(s.allocatedInr + Number(r.amount_inr || 0))
    }
    for (const s of Object.values(out)) s.balanceInr = round2(s.creditedInr - s.allocatedInr)
  } catch { /* ledger not migrated */ }
  return out
}

/** Single-client convenience wrapper. */
export async function getWalletSummary(admin: SupabaseClient, clientId: string): Promise<WalletSummary> {
  const map = await getWalletSummaries(admin, [clientId])
  return map[clientId] ?? { clientId, creditedInr: 0, allocatedInr: 0, balanceInr: 0 }
}

/** Σ active campaign-allocation debits per project (INR), for a set of projects. */
export async function getCampaignAllocatedByProject(
  admin: SupabaseClient, projectIds: string[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  if (projectIds.length === 0) return out
  try {
    const { data, error } = await admin
      .from('ad_wallet_ledger')
      .select('ad_project_id, amount_inr')
      .in('ad_project_id', projectIds)
      .eq('direction', 'debit')
      .is('deleted_at', null)
    if (error || !data) return out
    for (const r of data as any[]) {
      out[r.ad_project_id] = round2((out[r.ad_project_id] || 0) + Number(r.amount_inr || 0))
    }
  } catch { /* ledger not migrated */ }
  return out
}

/**
 * How much of a cashbook entry is still uncredited to any wallet.
 * Returns Infinity if the ledger isn't migrated (no constraint enforceable).
 */
export async function getEntryUncredited(
  admin: SupabaseClient, entryId: string, entryAmount: number,
): Promise<number> {
  try {
    const { data, error } = await admin
      .from('ad_wallet_ledger')
      .select('amount')
      .eq('cashbook_entry_id', entryId)
      .eq('direction', 'credit')
      .is('deleted_at', null)
    if (error) return Infinity
    const credited = (data || []).reduce((s, r: any) => s + Number(r.amount || 0), 0)
    return round2(entryAmount - credited)
  } catch { return Infinity }
}

import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { loadAllAssets } from '@/lib/assets/registry'
import { loadBrands } from '@/lib/brands/load'
import { loadBrandSummaries, resolveBrandPeriod } from '@/lib/brands/dashboard'
import CirqleAccountsClient from './cirqle-accounts-client'

export const dynamic = 'force-dynamic'

/**
 * Cirqle Brands — the agency's OWN brands and marketing, deliberately separate.
 *
 * Everything here is excluded from client reports, client dashboards, client
 * leads and client billing by the same ownership rule that drives every other
 * surface (@/lib/assets/ownership). Brands (Cirqle Works, Cirqle Flyers,
 * Memoura, …) split that own marketing and money by brand.
 */
export default async function CirqleAccountsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  if (!(isAdmin || hasPermission(me, PERMS.ASSETS_VIEW_CIRQLE))) redirect('/dashboard')

  const sp = await searchParams
  const { period, from, to } = resolveBrandPeriod(typeof sp.period === 'string' ? sp.period : null)
  const perms = {
    money: isAdmin || hasPermission(me, PERMS.REPORTS_VIEW_COMPANY_FINANCIALS),
    manage: isAdmin || hasPermission(me, PERMS.SETTINGS_MANAGE_COMPANY),
    assign: isAdmin || hasPermission(me, PERMS.ASSETS_ASSIGN),
  }

  const admin = createAdminClient()
  const [{ assets }, brands] = await Promise.all([loadAllAssets(admin), loadBrands(admin)])
  const mine = assets.filter(a => a.ownerType === 'cirqle')
  const summaries = await loadBrandSummaries(admin, brands.filter(b => b.is_active), { from, to, withMoney: perms.money })

  // Brand of each Cirqle-owned social account, for the per-account picker.
  let accountBrand: Record<string, string | null> = {}
  if (brands.length) {
    try {
      const { data } = await admin.from('social_accounts').select('id, brand_id').eq('owner_type', 'cirqle')
      accountBrand = Object.fromEntries((data ?? []).map((r: { id: string; brand_id: string | null }) => [r.id, r.brand_id]))
    } catch { /* column not migrated */ }
  }

  // Leads captured by Cirqle's own forms/pages (all time, for the header).
  let leads = 0
  try {
    const { count } = await admin.from('leads').select('*', { count: 'exact', head: true }).eq('owner_type', 'cirqle')
    leads = count ?? 0
  } catch { /* pre-migration */ }

  return (
    <CirqleAccountsClient
      assets={mine}
      brands={brands}
      summaries={summaries}
      accountBrand={accountBrand}
      period={period}
      range={{ from, to }}
      totalLeads={leads}
      perms={perms}
    />
  )
}

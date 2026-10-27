import { redirect } from 'next/navigation'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { loadFundsData } from './_data'
import FundsClient from './funds-client'

export const dynamic = 'force-dynamic'

/**
 * Ad Funds — one place to top up Meta, see which client each top-up is for,
 * catch failed / unrecorded payments, and check every rupee of ad spend is
 * invoiced. Wallet-layer data, so it needs view_financials (or manage_budget).
 */
export default async function AdFundsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const canManage = isAdmin || hasPermission(me, PERMS.ADVERTISING_MANAGE_BUDGET)
  const canView = canManage || hasPermission(me, PERMS.ADVERTISING_VIEW_FINANCIALS)
  if (me && !canView) redirect('/dashboard/advertising')

  const params = await searchParams
  const client = typeof params.client === 'string' && /^[0-9a-f-]{36}$/i.test(params.client) ? params.client : null
  const data = await loadFundsData()

  return <FundsClient data={data} canManage={canManage} initialClientId={client} />
}

import { redirect } from 'next/navigation'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import AdvertisingClient from './advertising-client'
import { loadAdvertisingData } from './_data'

export const dynamic = 'force-dynamic'

/**
 * Advertising overview — every client. Data loading (and its permission
 * gating) lives in _data.ts, shared with the client workspace.
 */
export default async function AdvertisingPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const canView = isAdmin || hasPermission(me, PERMS.ADVERTISING_VIEW)
  if (me && !canView) redirect('/dashboard')

  // Two confidentiality layers (migration 027). Campaign ALLOCATIONS are
  // behind neither — they are the campaign's working budget and every viewer
  // sees them. manage_budget implies both (you cannot manage what you cannot
  // see).
  //   viewFinancials — wallet balances, credited top-ups, history, Add Funds
  //   viewBilling    — service charges, billing amounts, invoices, rate cards
  const viewFinancials = isAdmin
    || hasPermission(me, PERMS.ADVERTISING_VIEW_FINANCIALS)
    || hasPermission(me, PERMS.ADVERTISING_MANAGE_BUDGET)
  const viewBilling = isAdmin
    || hasPermission(me, PERMS.ADVERTISING_VIEW_BILLING)
    || hasPermission(me, PERMS.ADVERTISING_MANAGE_BUDGET)

  const data = await loadAdvertisingData({ viewFinancials, viewBilling })

  const perms = {
    create:         isAdmin || hasPermission(me, PERMS.ADVERTISING_CREATE),
    edit:           isAdmin || hasPermission(me, PERMS.ADVERTISING_EDIT),
    manageBudget:   isAdmin || hasPermission(me, PERMS.ADVERTISING_MANAGE_BUDGET),
    viewFinancials,
    viewBilling,
  }

  return (
    <AdvertisingClient
      migrated={data.migrated}
      initialProjects={data.projects}
      metricsByProject={data.metricsByProject}
      benchmarksByProject={data.benchmarksByProject}
      attention={data.attention}
      pendingRequests={data.pendingRequests}
      clients={data.clients}
      walletSupported={data.walletSupported}
      ledger={data.ledger}
      fundCandidates={data.fundCandidates}
      perms={perms}
    />
  )
}

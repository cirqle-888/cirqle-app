import { balanceOnToday, loadModuleState, pendingByEntitlement, todayIso } from '../_data'
import { requireProfitSharingPage } from '../_page'
import { NotInstalled } from '../_not-installed'
import InvestorsClient, { type InvestorsData } from './investors-client'

export const dynamic = 'force-dynamic'

export default async function InvestorsPage() {
  const { admin, installed } = await requireProfitSharingPage()
  if (!installed) return <NotInstalled />

  const state = await loadModuleState(admin)
  // CQIDs only — names are never selected for this feature.
  const { data: employees } = await admin.from('employees').select('id, cqid, is_active').order('cqid')

  // Historical Personal Withdrawals and unlinked capital entries, for review and linking.
  const { data: cats } = await admin.from('cashbook_categories').select('id, account_code')
    .in('account_code', ['excluded.owner_drawings', 'financial.capital_introduced', 'excluded.capital_withdrawal'])
  const byCode = (code: string) => (cats ?? []).filter(c => c.account_code === code).map(c => c.id as string)
  const read = async (ids: string[]) => ids.length
    ? (await admin.from('cashbook_entries').select('id, entry_date, type, amount_inr, description, reference')
      .in('category_id', ids).is('deleted_at', null).order('entry_date', { ascending: false }).limit(1000)).data ?? []
    : []
  const [withdrawals, capitalIn, capitalOut] = await Promise.all([
    read(byCode('excluded.owner_drawings')), read(byCode('financial.capital_introduced')), read(byCode('excluded.capital_withdrawal')),
  ])
  const linked = new Set(state.cashLinks.map(l => l.entryId))
  const pendingEnt = pendingByEntitlement(state.entitlements, state.settlements, state.runs)

  const data: InvestorsData = {
    today: todayIso(),
    employees: (employees ?? []).map(e => ({ id: e.id, cqid: e.cqid, active: !!e.is_active })),
    members: state.members.map(m => ({
      ...m,
      capitalToday: balanceOnToday(state.capital, m.id),
      pendingInr: state.entitlements.filter(e => e.memberId === m.id).reduce((s, e) => s + (pendingEnt.get(e.id) ?? 0), 0),
    })),
    capital: state.capital,
    agreements: state.agreements,
    entitlements: state.entitlements.map(e => ({
      ...e, pendingInr: pendingEnt.get(e.id) ?? 0,
      period: state.runs.find(r => r.id === e.runId) ?? null,
    })).filter(e => e.period?.status === 'confirmed').map(e => ({
      id: e.id, memberId: e.memberId, amountInr: e.amountInr, pendingInr: e.pendingInr,
      periodStart: e.period!.periodStart, periodEnd: e.period!.periodEnd,
    })),
    settlements: state.settlements.filter(s => s.entitlementId),
    withdrawals: withdrawals.map(w => ({
      id: w.id as string, date: String(w.entry_date), amountInr: Number(w.amount_inr), description: (w.description as string) ?? null,
      review: state.reviews.find(r => r.sourceTable === 'cashbook_entries' && r.sourceId === w.id) ?? null,
    })),
    advances: state.reviews.filter(r => r.classification === 'advance_distribution').map(r => ({
      id: r.id, memberId: r.memberId, amountInr: r.amountInr ?? 0, date: r.reviewedOn,
      usedInr: state.settlements.filter(s => s.reviewId === r.id && s.kind === 'advance_offset').reduce((x, s) => x + s.amountInr, 0),
    })),
    linkableCapitalEntries: [...capitalIn, ...capitalOut].filter(e => !linked.has(e.id)).map(e => ({
      id: e.id as string, date: String(e.entry_date), type: e.type as string, amountInr: Number(e.amount_inr), description: (e.description as string) ?? null,
    })),
  }
  return <InvestorsClient data={data} />
}

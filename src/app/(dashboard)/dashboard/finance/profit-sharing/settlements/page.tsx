import { loadModuleState, pendingByEntitlement, pendingByValuation, todayIso, valuationAmount } from '../_data'
import { requireProfitSharingPage } from '../_page'
import { NotInstalled } from '../_not-installed'
import SettlementsClient, { type SettlementsData } from './settlements-client'

export const dynamic = 'force-dynamic'

export default async function SettlementsPage() {
  const { admin, installed } = await requireProfitSharingPage()
  if (!installed) return <NotInstalled />
  const state = await loadModuleState(admin)
  const label = new Map(state.members.map(m => [m.id, m.label]))
  const pendingEnt = pendingByEntitlement(state.entitlements, state.settlements, state.runs)
  const pendingDev = pendingByValuation(state.valuations, state.settlements)

  const { data: devices } = await admin.from('profit_share_devices').select('id, member_id, category, brand, model')
  const deviceById = new Map((devices ?? []).map(d => [d.id, d]))
  const { data: accounts } = await admin.from('bank_accounts').select('id, name, is_default').eq('is_active', true).order('name')

  // Outflows that could be linked instead of creating a new entry.
  const { data: cats } = await admin.from('cashbook_categories').select('id, account_code').in('account_code', ['excluded.profit_distribution', 'opex.equipment'])
  const linked = new Set(state.cashLinks.map(l => l.entryId))
  const linkable = cats?.length
    ? ((await admin.from('cashbook_entries').select('id, entry_date, amount_inr, category_id')
      .in('category_id', cats.map(c => c.id)).eq('type', 'outflow').is('deleted_at', null)
      .order('entry_date', { ascending: false }).limit(300)).data ?? [])
      .filter(e => !linked.has(e.id))
    : []
  const codeOf = new Map((cats ?? []).map(c => [c.id, c.account_code as string]))

  const data: SettlementsData = {
    today: todayIso(),
    entitlements: state.entitlements
      .filter(e => (pendingEnt.get(e.id) ?? 0) > 0)
      .map(e => {
        const r = state.runs.find(x => x.id === e.runId)!
        return { id: e.id, memberId: e.memberId, label: label.get(e.memberId) ?? '—', periodStart: r.periodStart, periodEnd: r.periodEnd, amountInr: e.amountInr, pendingInr: pendingEnt.get(e.id) ?? 0 }
      }),
    valuations: state.valuations
      .filter(v => (pendingDev.get(v.id) ?? 0) > 0)
      .map(v => {
        const d = deviceById.get(v.deviceId)
        return {
          id: v.id, kind: v.kind, outcome: v.outcome, label: d ? `${label.get(d.member_id) ?? '—'} · ${d.category}${d.brand ? ` ${d.brand}` : ''}${d.model ? ` ${d.model}` : ''}` : '—',
          amountInr: valuationAmount(v), pendingInr: pendingDev.get(v.id) ?? 0, confirmedAt: v.confirmedAt,
        }
      }),
    advances: state.reviews.filter(r => r.classification === 'advance_distribution').map(r => ({
      id: r.id, memberId: r.memberId, label: label.get(r.memberId ?? '') ?? '—',
      leftInr: (r.amountInr ?? 0) - state.settlements.filter(s => s.reviewId === r.id && s.kind === 'advance_offset').reduce((x, s) => x + s.amountInr, 0),
    })).filter(a => a.leftInr > 0.004),
    accounts: (accounts ?? []).map(a => ({ id: a.id, name: a.name, isDefault: !!a.is_default })),
    linkable: linkable.map(e => ({ id: e.id, date: String(e.entry_date), amountInr: Number(e.amount_inr), code: codeOf.get(e.category_id) ?? '' })),
    history: state.settlements.slice().reverse().map(s => {
      const ent = s.entitlementId ? state.entitlements.find(e => e.id === s.entitlementId) : null
      const v = s.deviceValuationId ? state.valuations.find(x => x.id === s.deviceValuationId) : null
      const who = ent ? label.get(ent.memberId) : v ? label.get(deviceById.get(v.deviceId)?.member_id ?? '') : null
      return { id: s.id, kind: s.kind, amountInr: s.amountInr, settledOn: s.settledOn, what: ent ? 'Profit share' : 'Device', who: who ?? '—', reason: s.reason }
    }),
  }
  return <SettlementsClient data={data} />
}

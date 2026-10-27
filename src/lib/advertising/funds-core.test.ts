import { describe, it, expect } from 'vitest'
import {
  withGst, classifyFundingEvent, parseMoney, parseFundingAmount, parseAvailableBalance,
  matchFundingEvents, failedInitiations, unconfirmedTopUps, suggestClients, suggestTopUp,
  buildStatement, monthlySpendInclGst, type FundingEventLite,
} from './funds-core'

const ACC = 'acc-seastar'

describe('withGst', () => {
  it('adds 18% GST to platform spend', () => {
    expect(withGst(169.48)).toBe(199.99)
    expect(withGst(0)).toBe(0)
  })
})

describe('classifyFundingEvent', () => {
  it('maps money events and ignores the rest', () => {
    expect(classifyFundingEvent('funding_event_successful')).toBe('successful')
    expect(classifyFundingEvent('funding_event_initiated')).toBe('initiated')
    expect(classifyFundingEvent('ad_account_billing_charge')).toBe('charge')
    expect(classifyFundingEvent('ad_account_billing_decline')).toBe('failed')
    expect(classifyFundingEvent('ad_account_billing_refund')).toBe('refund')
    expect(classifyFundingEvent('update_campaign_budget')).toBeNull()
    expect(classifyFundingEvent(undefined)).toBeNull()
  })
})

describe('parsing money', () => {
  it('parses common money strings', () => {
    expect(parseMoney('₹1,000.00')).toBe(1000)
    expect(parseMoney('800.00 INR')).toBe(800)
    expect(parseMoney('abc')).toBeNull()
  })
  it('finds the amount in extra_data JSON at any depth', () => {
    // JSON amounts are in paise — live: a ₹200 top-up arrived as 20000.
    expect(parseFundingAmount('{"amount":"20000","currency":"INR"}')).toEqual({ amount: 200, currency: 'INR' })
    expect(parseFundingAmount({ new_value: { amount: 165200, currency: 'INR' } })).toEqual({ amount: 1652, currency: 'INR' })
    expect(parseFundingAmount({ amount: 5000 }, 'JPY')).toEqual({ amount: 5000, currency: null })
    expect(parseFundingAmount('Added ₹1,652.00 to balance')).toEqual({ amount: 1652, currency: 'INR' })
    expect(parseFundingAmount(null)).toEqual({ amount: null, currency: null })
  })
  it('reads the prepaid available balance', () => {
    expect(parseAvailableBalance('Available balance (₹323.14 INR)')).toBe(323.14)
    expect(parseAvailableBalance('Visa ···· 1152')).toBeNull()
  })
})

const ev = (p: Partial<FundingEventLite> & { id: string }): FundingEventLite => ({
  adAccountId: ACC, status: 'successful', amount: 800, eventTime: '2026-10-25T00:50:00Z', cashbookEntryId: null, ...p,
})

describe('matchFundingEvents', () => {
  it('links a successful event to the same-amount top-up on the same account', () => {
    const links = matchFundingEvents(
      [ev({ id: 'e1' })],
      [
        { id: 'c-other-acc', adAccountId: 'acc-mezza', amount: 800, entryDate: '2026-10-25' },
        { id: 'c1', adAccountId: ACC, amount: 800, entryDate: '2026-10-25' },
      ],
    )
    expect(links.get('e1')).toBe('c1')
  })
  it('never links one entry to two events, and respects the date window', () => {
    const links = matchFundingEvents(
      [ev({ id: 'e1' }), ev({ id: 'e2', eventTime: '2026-10-25T01:00:00Z' }), ev({ id: 'e3', eventTime: '2026-11-10T00:00:00Z' })],
      [{ id: 'c1', adAccountId: ACC, amount: 800, entryDate: '2026-10-25' }],
    )
    expect([...links.values()]).toEqual(['c1'])
    expect(links.has('e3')).toBe(false)
  })
})

describe('failedInitiations — the 25 Oct Sea Star case', () => {
  const now = new Date('2026-10-27T00:00:00Z')
  it('flags initiated payments that never succeeded', () => {
    const events = [
      ev({ id: 'i1', status: 'initiated', amount: 1000, eventTime: '2026-10-25T00:21:00Z' }),
      ev({ id: 'i2', status: 'initiated', amount: 800,  eventTime: '2026-10-25T00:51:00Z' }),
      ev({ id: 's2', status: 'successful', amount: 800, eventTime: '2026-10-25T00:52:00Z' }),
      ev({ id: 'i3', status: 'initiated', amount: 800,  eventTime: '2026-10-25T00:52:30Z' }),
    ]
    expect(failedInitiations(events, now).map(e => e.id)).toEqual(['i1', 'i3'])
  })
  it('waits for the grace period before calling it failed', () => {
    const fresh = [ev({ id: 'i1', status: 'initiated', eventTime: '2026-10-26T22:00:00Z' })]
    expect(failedInitiations(fresh, now)).toEqual([])
  })
})

describe('unconfirmedTopUps', () => {
  it('flags recorded top-ups Meta never confirmed, only on synced accounts', () => {
    const entries = [
      { id: 'ok', adAccountId: ACC, amount: 800, entryDate: '2026-10-25' },
      { id: 'missing', adAccountId: ACC, amount: 1000, entryDate: '2026-10-25' },
      { id: 'unsynced', adAccountId: 'acc-x', amount: 500, entryDate: '2026-10-20' },
    ]
    const events = [ev({ id: 'e', cashbookEntryId: 'ok' })]
    const out = unconfirmedTopUps(entries, events, new Set([ACC]), new Date('2026-10-27T00:00:00Z'))
    expect(out.map(e => e.id)).toEqual(['missing'])
  })
})

describe('suggestClients', () => {
  it('ranks clients by spend on the account around the funding date', () => {
    const spend = [
      { adAccountId: ACC, clientId: 'seastar', date: '2026-10-24', spendExGst: 169.48 },
      { adAccountId: ACC, clientId: 'mezza', date: '2026-10-25', spendExGst: 20 },
      { adAccountId: ACC, clientId: 'old', date: '2026-09-01', spendExGst: 999 },
      { adAccountId: 'other', clientId: 'x', date: '2026-10-25', spendExGst: 999 },
    ]
    expect(suggestClients(spend, ACC, '2026-10-25T00:52:00Z')).toEqual(['seastar', 'mezza'])
  })
})

describe('suggestTopUp', () => {
  it('suggests topping up to 7 days when runway is under 3 days', () => {
    // Sea Star: ₹800 credited, ₹420.13 spent, ~₹210/day
    const s = suggestTopUp({ creditedInr: 800, spentInclGstInr: 420.13, recentSpendInclGstInr: 420.13, burnDays: 2, activeCampaigns: 1 })
    expect(s.balanceInr).toBe(379.87)
    expect(s.level).toBe('low')
    expect(s.runwayDays).toBe(1.8)
    expect(s.suggestedInr).toBe(1100) // 7 × 210.07 − 379.87 = 1090.6 → 1,100
  })
  it('asks for nothing when there is enough runway or nothing is running', () => {
    expect(suggestTopUp({ creditedInr: 5000, spentInclGstInr: 0, recentSpendInclGstInr: 600, burnDays: 3, activeCampaigns: 1 }).suggestedInr).toBeNull()
    expect(suggestTopUp({ creditedInr: 100, spentInclGstInr: 0, recentSpendInclGstInr: 0, burnDays: 3, activeCampaigns: 0 }).level).toBe('idle')
  })
  it('asks to cover a negative balance even when idle', () => {
    expect(suggestTopUp({ creditedInr: 0, spentInclGstInr: 445.18, recentSpendInclGstInr: 0, burnDays: 3, activeCampaigns: 0 }).suggestedInr).toBe(500)
  })
})

describe('buildStatement — the Mezza February gap', () => {
  const spend = [
    { clientId: 'mezza', projectId: 'p-reach', campaignKey: 'c1', campaignName: 'Mezza - Reach', date: '2026-02-08', spendExGst: 1000 },
    { clientId: 'mezza', projectId: 'p-reach', campaignKey: 'c1', campaignName: 'Mezza - Reach', date: '2026-02-09', spendExGst: 1488.98 },
    { clientId: 'mezza', projectId: 'p-hire', campaignKey: 'c2', campaignName: 'Hiring', date: '2026-03-17', spendExGst: 423.72 },
    { clientId: null, projectId: null, campaignKey: 'c9', campaignName: 'Unmapped', date: '2026-03-01', spendExGst: 100 },
    { clientId: 'seastar', projectId: 'p-w', campaignKey: 'c3', campaignName: 'Wedding', date: '2026-10-24', spendExGst: 169.48 },
  ]
  const billed = [
    { clientId: 'mezza', period: '2026-02', amountInr: 2737, source: 'topup' as const, invoiceNumber: 'INV-2603-053', invoiceStatus: 'paid' },
    { clientId: 'mezza', period: '2026-03', amountInr: 500, source: 'topup' as const, invoiceNumber: 'INV-2604-053', invoiceStatus: 'paid' },
  ]
  const st = buildStatement(spend, billed, '2026-10')
  it('puts unmapped spend first', () => {
    expect(st[0].clientId).toBeNull()
    expect(st[0].months[0].status).toBe('not_invoiced')
  })
  it('flags the short month and totals the client', () => {
    const mezza = st.find(c => c.clientId === 'mezza')!
    const feb = mezza.months.find(m => m.period === '2026-02')!
    expect(feb.spendInclGst).toBe(2937)
    expect(feb.differenceInr).toBe(200)
    expect(feb.status).toBe('short')
    expect(feb.campaigns[0].days).toBe(2)
    expect(mezza.months.find(m => m.period === '2026-03')!.status).toBe('ok')
    // March: ₹423.72 + GST = ₹499.99 against ₹500 billed (within ₹1 → ok)
    expect(mezza.differenceInr).toBe(199.99)
  })
  it('marks the current month as running, not short', () => {
    expect(st.find(c => c.clientId === 'seastar')!.months[0].status).toBe('running')
  })
})

describe('monthlySpendInclGst', () => {
  it('buckets daily spend by month incl. GST', () => {
    const m = monthlySpendInclGst([
      { date: '2026-06-29', spendExGst: 344.9 }, { date: '2026-06-30', spendExGst: 78.82 }, { date: '2026-07-01', spendExGst: 10 },
    ])
    // Same as Meta's two invoices for those days: ₹406.98 + ₹93.01
    expect(m.get('2026-06')).toBe(499.99)
    expect(m.get('2026-07')).toBe(11.8)
  })
})

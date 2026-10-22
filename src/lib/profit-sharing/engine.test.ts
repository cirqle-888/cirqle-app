import { describe, it, expect } from 'vitest'
import { computeRun, isBlocked, monthsOf, type RunInput } from './engine'
import type { InvoiceRaw, LedgerEntry, PayrollRow, Review } from './types'
import { DEFAULT_SETTINGS } from './types'

let n = 0
const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({
  id: `e${++n}`, date: '2026-04-01', type: 'outflow', amountInr: 0, categoryId: null, categoryName: null,
  section: 'opex', accountCode: 'opex.rent', clientId: null, employeeId: null, invoiceId: null,
  bankAccountId: 'bank', transferRef: null, reversalOf: null, isBillable: false, reference: null, ...over,
})
const invoice = (over: Partial<InvoiceRaw>): InvoiceRaw => ({
  id: 'inv', clientId: 'c', status: 'paid', exchangeRate: 1, totalAmount: 0, totalAmountInr: null, taxAmount: 0,
  discountAmount: 0, previousBalance: 0, updatedOn: null, itemsTotal: 0, markupTotal: 0, adSpendInr: 0,
  expenseOriginalInr: 0, ...over,
})
const payroll = (month: number, gross: number, year = 2026): PayrollRow => ({
  id: `p${year}-${month}`, employeeId: 'emp', month, year, base: gross, commission: 0, bonus: 0, adjustment: 0,
  ownership: 0, advancesDeducted: 0, otherDeductions: 0, storedNet: gross, status: 'paid',
})
const review = (over: Partial<Review>): Review => ({
  id: `r${++n}`, sourceTable: 'cashbook_entries', sourceId: '', category: 'personal_withdrawal', classification: 'personal_drawing',
  memberId: null, amountInr: null, reviewedOn: '2026-10-01', detail: null, ...over,
})

const base = (over: Partial<RunInput>): RunInput => ({
  periodStart: '2026-04-01', periodEnd: '2026-09-30', settings: DEFAULT_SETTINGS,
  openingLossInr: 0, openingLossEntered: true, previousConfirmedEnd: null, confirmedRanges: [],
  entries: [], accountOpeningBalancesInr: 0, allocations: [], invoices: [], walletCredits: [],
  rebilledEntryIds: new Set(), payrollAllocations: [], payrollRows: [], credits: [], reviews: [], cashLinks: [],
  settlements: [], deviceCosts: [], capital: [], memberIds: [], finalizedMonths: new Set(monthsOf('2026-01-01', '2026-12-31')),
  banks: [], obligations: { pendingEntitlementsInr: 0, unpaidDeviceInr: 0, reserveBalanceInr: 0 },
  ...over,
})

/** The design's §3.5 period: Apr–Sep 2026, opening loss ₹20,000. */
function section35(): RunInput {
  const receiptA = entry({ date: '2026-07-15', type: 'inflow', amountInr: 200000, section: 'revenue', accountCode: 'revenue.services', clientId: 'x' })
  const receiptB1 = entry({ date: '2026-05-20', type: 'inflow', amountInr: 690000, section: 'revenue', accountCode: 'revenue.services', clientId: 'y' })
  const receiptB2 = entry({ date: '2026-06-18', type: 'inflow', amountInr: 10000, section: 'revenue', accountCode: 'revenue.services', clientId: 'y' })
  const refund = entry({ date: '2026-08-20', type: 'outflow', amountInr: 10000, section: 'revenue', accountCode: 'revenue.services', clientId: 'y', reversalOf: receiptB2.id })
  const held = entry({ date: '2026-09-25', type: 'inflow', amountInr: 20000, section: 'revenue', accountCode: 'revenue.services', clientId: 'z' })
  const capitalIn = entry({ date: '2026-07-01', type: 'inflow', amountInr: 100000, section: 'financial', accountCode: 'financial.capital_introduced' })
  const adFunding = entry({ date: '2026-06-10', amountInr: 190000, section: 'cogs', accountCode: 'cogs.ad_spend' })
  const rent = [4, 5, 6, 7, 8, 9].map(m => entry({ date: `2026-0${m}-05`, amountInr: 45000 }))
  const salaries = [
    ['2026-04-03', 45000, 'p2026-3'], ['2026-05-03', 50000, 'p2026-4'], ['2026-06-03', 50000, 'p2026-5'],
    ['2026-07-03', 50000, 'p2026-6'], ['2026-08-03', 55000, 'p2026-7'], ['2026-09-03', 55000, 'p2026-8'],
  ].map(([date, amt, pid]) => ({ e: entry({ date: date as string, amountInr: amt as number, accountCode: 'opex.salaries', employeeId: 'emp' }), pid: pid as string }))
  const w1 = entry({ date: '2026-06-30', amountInr: 25000, section: 'excluded', accountCode: 'excluded.owner_drawings' })
  const w2 = entry({ date: '2026-09-15', amountInr: 20000, section: 'excluded', accountCode: 'excluded.owner_drawings' })

  const gross = [[3, 45000], [4, 50000], [5, 50000], [6, 50000], [7, 55000], [8, 55000], [9, 60000]] as const
  return base({
    openingLossInr: 20000,
    accountOpeningBalancesInr: 140000,
    entries: [receiptA, receiptB1, receiptB2, refund, held, capitalIn, adFunding, ...rent, ...salaries.map(s => s.e), w1, w2],
    allocations: [
      { entryId: receiptA.id, invoiceId: 'A', amountInr: 200000, allocatedOn: '2026-07-15' },
      { entryId: receiptB1.id, invoiceId: 'B', amountInr: 690000, allocatedOn: '2026-05-20' },
      { entryId: receiptB2.id, invoiceId: 'B', amountInr: 10000, allocatedOn: '2026-06-18' },
    ],
    invoices: [
      invoice({ id: 'A', clientId: 'x', totalAmount: 200000, itemsTotal: 20000, adSpendInr: 180000 }),
      invoice({ id: 'B', clientId: 'y', totalAmount: 700000, itemsTotal: 700000 }),
    ],
    walletCredits: [{ entryId: adFunding.id, clientId: 'x', amountInr: 190000 }],
    payrollRows: gross.map(([m, g]) => payroll(m, g)),
    payrollAllocations: salaries.map(s => ({ entryId: s.e.id, payrollId: s.pid, amountInr: s.e.amountInr })),
    reviews: [
      review({ sourceId: w1.id, classification: 'advance_distribution', amountInr: 25000 }),
      review({ sourceId: w2.id, classification: 'personal_drawing', amountInr: 20000 }),
    ],
    cashLinks: [{ entryId: capitalIn.id, ownerKind: 'capital', ownerId: 'cap-emp' }],
    capital: [
      { id: 'cap-f', memberId: 'founder', direction: 'in', amountInr: 500000, weight: 1, effectiveOn: '2026-01-01', status: 'approved' },
      { id: 'cap-emp', memberId: 'emp', direction: 'in', amountInr: 100000, weight: 1, effectiveOn: '2026-07-01', status: 'approved' },
    ],
    memberIds: ['founder', 'emp'],
  })
}

describe('§3.5 worked example, reproduced to the paisa', () => {
  const r = computeRun(section35())

  it('profit counts only Cirqle’s own money, pay as earned', () => {
    expect(r.profit).toMatchObject({
      ownRevenueInr: 710000, operatingPaymentsInr: 270000, remunerationInr: 320000, profitInr: 120000,
    })
  })

  it('the cash bridge balances: ₹1,40,000 → ₹3,40,000', () => {
    expect(r.cash.openingInr).toBe(140000)
    expect(r.cash.closingInr).toBe(340000)
    expect(r.cash.bridgeDifferenceInr).toBe(0)
    const byBucket = Object.fromEntries(r.cash.byBucket.map(b => [b.bucket, b.amountInr]))
    expect(byBucket).toMatchObject({
      client_receipts: 910000, capital: 100000, passthrough_paid: -190000, operating: -270000,
      salary_paid: -305000, drawing: -45000,
    })
  })

  it('absorbs the opening loss, then splits 50 / 50 / 50', () => {
    expect(r.loss).toMatchObject({ lossOffsetInr: 20000, closingLossInr: 0, eligibleProfitInr: 100000 })
    expect(r.distribution).toMatchObject({ poolInr: 50000, capitalShareInr: 25000, reserveInr: 25000, retainedOutsideInr: 50000, totalRetainedInr: 75000 })
  })

  it('divides the Capital Share by capital-days', () => {
    expect(r.capital.entitlements.map(e => [e.memberId, e.amountInr])).toEqual([['founder', 22715.99], ['emp', 2284.01]])
  })

  it('reports liabilities and cash available, deducting the reserve once', () => {
    expect(r.balances).toMatchObject({ clientFundsHeldInr: 20000, passthroughReceivableInr: 10000, payrollLiabilityInr: 60000 })
    expect(r.freeCash).toMatchObject({ freeCashInr: 260000, reserveBalanceInr: 25000, cashAvailableInr: 235000, capitalShareExceedsCash: false })
  })

  it('has nothing blocking confirmation', () => {
    expect(r.gates.filter(g => g.level === 'block')).toEqual([])
    expect(isBlocked(r.gates)).toBe(false)
  })

  it('changes its fingerprint when the books change', () => {
    const input = section35()
    const again = computeRun(input)
    input.entries[0] = { ...input.entries[0], amountInr: input.entries[0].amountInr + 1 }
    expect(computeRun(input).fingerprint).not.toBe(again.fingerprint)
  })
})

describe('§4.3 — ₹20,000 of client ad money never becomes revenue', () => {
  const received = entry({ date: '2026-09-05', type: 'inflow', amountInr: 20000, section: 'revenue', accountCode: 'revenue.services', clientId: 'x' })
  const funding = entry({ date: '2026-09-08', amountInr: 20000, section: 'cogs', accountCode: 'cogs.ad_spend' })
  const fee = entry({ date: '2026-10-10', type: 'inflow', amountInr: 3000, section: 'revenue', accountCode: 'revenue.services', clientId: 'x' })
  const shared: Partial<RunInput> = {
    entries: [received, funding, fee],
    allocations: [
      { entryId: received.id, invoiceId: 'inv', amountInr: 20000, allocatedOn: '2026-09-30' },
      { entryId: fee.id, invoiceId: 'inv', amountInr: 3000, allocatedOn: '2026-10-10' },
    ],
    invoices: [invoice({ id: 'inv', clientId: 'x', totalAmount: 23000, itemsTotal: 3000, adSpendInr: 20000 })],
    walletCredits: [{ entryId: funding.id, clientId: 'x', amountInr: 20000 }],
  }

  it('September: no profit, nothing held, nothing owed', () => {
    const sep = computeRun(base({ ...shared, periodStart: '2026-09-01', periodEnd: '2026-09-30', entries: [received, funding] }))
    expect(sep.profit.ownRevenueInr).toBe(0)
    expect(sep.profit.operatingPaymentsInr).toBe(0)
    expect(sep.balances.clientFundsHeldInr).toBe(0)
    expect(sep.balances.passthroughReceivableInr).toBe(0)
  })

  it('October: the ₹3,000 service charge is the only profit', () => {
    const oct = computeRun(base({ ...shared, periodStart: '2026-10-01', periodEnd: '2026-10-31' }))
    expect(oct.profit.ownRevenueInr).toBe(3000)
    expect(oct.profit.profitInr).toBe(3000)
  })

  it('before the receipt is applied, the money is held for the client (D3)', () => {
    const early = computeRun(base({ ...shared, periodStart: '2026-09-01', periodEnd: '2026-09-29', entries: [received, funding] }))
    expect(early.balances.clientFundsHeldInr).toBe(20000)
    expect(early.balances.passthroughReceivableInr).toBe(20000)
    expect(early.profit.profitInr).toBe(0)
  })
})

describe('gates (design §11)', () => {
  it('blocks the first period until the opening loss is entered (D7)', () => {
    const r = computeRun(base({ openingLossEntered: false }))
    expect(r.gates.map(g => g.key)).toContain('opening_loss')
  })

  it('blocks a period that does not follow on from the last confirmed one', () => {
    const r = computeRun(base({ previousConfirmedEnd: '2026-02-28' }))
    expect(r.gates.find(g => g.key === 'order')?.level).toBe('block')
  })

  it('blocks months with no payroll and months still open', () => {
    const r = computeRun(base({ finalizedMonths: new Set() }))
    expect(r.gates.map(g => g.key)).toEqual(expect.arrayContaining(['payroll_missing', 'months_open']))
  })

  it('sends an unreviewed Personal Withdrawal to review and blocks', () => {
    const w = entry({ date: '2026-05-01', amountInr: 1000, section: 'excluded', accountCode: 'excluded.owner_drawings' })
    const r = computeRun(base({ entries: [w] }))
    expect(r.reviewItems.map(i => i.category)).toContain('personal_withdrawal')
    expect(r.gates.find(g => g.key === 'reviews')?.level).toBe('block')
  })

  it('keeps tax-bearing invoices in review while D1 is open', () => {
    const rec = entry({ date: '2026-05-01', type: 'inflow', amountInr: 11800, section: 'revenue', accountCode: 'revenue.services', clientId: 'c' })
    const r = computeRun(base({
      entries: [rec],
      allocations: [{ entryId: rec.id, invoiceId: 'gst', amountInr: 11800, allocatedOn: '2026-05-01' }],
      invoices: [invoice({ id: 'gst', totalAmount: 11800, itemsTotal: 10000, taxAmount: 1800 })],
    }))
    expect(r.profit.ownRevenueInr).toBe(0)
    expect(r.reviewItems.map(i => i.category)).toContain('invoice_split')
    expect(r.balances.clientFundsHeldInr).toBe(11800)
  })

  it('blocks unassigned ad funding older than 60 days, and only warns-by-listing younger funding (D4)', () => {
    const old = entry({ date: '2026-05-01', amountInr: 5000, section: 'cogs', accountCode: 'cogs.ad_spend' })
    const young = entry({ date: '2026-09-20', amountInr: 3000, section: 'cogs', accountCode: 'cogs.ad_spend' })
    const r = computeRun(base({ entries: [old, young] }))
    expect(r.gates.find(g => g.key === 'ad_prepaid_aged')).toMatchObject({ level: 'block', count: 1, amountInr: 5000 })
    expect(r.reviewItems.filter(i => i.category === 'unassigned_ad_funding')).toHaveLength(2)
    expect(r.profit.operatingPaymentsInr).toBe(0)
    expect(r.balances.adPrepaidInr).toBe(8000)
  })

  it('a write-off review turns old ad funding into an expense on the review date', () => {
    const old = entry({ date: '2026-05-01', amountInr: 5000, section: 'cogs', accountCode: 'cogs.ad_spend' })
    const r = computeRun(base({ entries: [old], reviews: [review({ sourceId: old.id, category: 'unassigned_ad_funding', classification: 'write_off', reviewedOn: '2026-09-10' })] }))
    expect(r.gates.find(g => g.key === 'ad_prepaid_aged')).toBeUndefined()
    expect(r.profit.adWriteoffsInr).toBe(5000)
  })

  it('needs review for a salary payment to an employee with no payslip allocation', () => {
    const s = entry({ date: '2026-05-15', amountInr: 10000, accountCode: 'opex.salaries', employeeId: 'emp9' })
    const r = computeRun(base({ entries: [s] }))
    expect(r.reviewItems.map(i => i.category)).toContain('salary_without_payroll')
    const extra = computeRun(base({ entries: [s], reviews: [review({ sourceId: s.id, category: 'salary_without_payroll', classification: 'extra_pay' })] }))
    expect(extra.profit.extraPayInr).toBe(10000)
  })

  it('warns, and needs an acknowledgement, when the Capital Share exceeds cash available (D13)', () => {
    const input = section35()
    input.obligations = { pendingEntitlementsInr: 240000, unpaidDeviceInr: 0, reserveBalanceInr: 0 }
    const r = computeRun(input)
    expect(r.freeCash.capitalShareExceedsCash).toBe(true)
    expect(r.gates.find(g => g.key === 'cash_cover')?.level).toBe('warn')
  })

  it('blocks an account under reconciliation with unmatched lines, and warns for one that is not (D6)', () => {
    const r = computeRun(base({
      banks: [
        { id: 'k', name: 'Kotak', underReconciliation: true, covered: true, unmatchedInPeriod: 2, differenceInr: 0, hadEntriesInPeriod: true },
        { id: 'c', name: 'Cash', underReconciliation: false, covered: false, unmatchedInPeriod: 0, differenceInr: null, hadEntriesInPeriod: true },
      ],
    }))
    expect(r.gates.find(g => g.key === 'bank_unmatched_k')?.level).toBe('block')
    expect(r.gates.find(g => g.key === 'bank_unreconciled_c')?.level).toBe('warn')
  })

  it('recognises a confirmed device usage cost in the period it was confirmed (D14)', () => {
    const r = computeRun(base({ periodStart: '2026-10-01', periodEnd: '2026-12-31', deviceCosts: [{ valuationId: 'v', confirmedOn: '2026-11-12', amountInr: 2685.25 }] }))
    expect(r.profit.deviceCostsInr).toBe(2685.25)
    const apr = computeRun(base({ deviceCosts: [{ valuationId: 'v', confirmedOn: '2026-11-12', amountInr: 2685.25 }] }))
    expect(apr.profit.deviceCostsInr).toBe(0)
  })

  it('does not count the later device payment again', () => {
    const pay = entry({ date: '2027-01-20', amountInr: 2685.25, accountCode: 'opex.equipment' })
    const r = computeRun(base({
      periodStart: '2027-01-01', periodEnd: '2027-03-31', entries: [pay],
      cashLinks: [{ entryId: pay.id, ownerKind: 'settlement', ownerId: 's' }],
      settlements: [{ id: 's', kind: 'paid', entitlementId: null, deviceValuationId: 'v', deviceKind: 'usage', amountInr: 2685.25 }],
      finalizedMonths: new Set(monthsOf('2027-01-01', '2027-03-31')),
    }))
    expect(r.profit.operatingPaymentsInr).toBe(0)
    expect(r.cash.byBucket.find(b => b.bucket === 'device_settlement')?.amountInr).toBe(-2685.25)
  })
})

/**
 * Ad funds — pure core (no I/O, unit-tested in funds-core.test.ts).
 *
 * The money model (see migration 20261027120000_ad_funds_autopilot.sql):
 *
 *   Top-up   — Cirqle pays the ad platform (a Cashbook outflow carrying
 *              ad_account_id) and credits the client's wallet.
 *   Spend    — the platform reports spend EXCLUDING GST; what was really paid
 *              is spend × 1.18 (AD_SPEND_GST_RATE).
 *   Billing  — the client is billed the ACTUAL spend incl. GST, per campaign
 *              per month. Unspent wallet money simply carries forward.
 *
 * Everything here works on plain rows so the same rules drive the statement
 * page, the needs-attention items, the cron auto-matcher and the tests.
 */

import { AD_SPEND_GST_RATE } from './budget'

const r2 = (v: number) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100
const DAY = 86_400_000

/** spend (excl. GST) → money actually paid (incl. GST). */
export const withGst = (spendExGst: number): number => r2(Number(spendExGst || 0) * (1 + AD_SPEND_GST_RATE))

// ─── Meta funding / billing events ──────────────────────────────────────────

export type FundingStatus = 'initiated' | 'successful' | 'failed' | 'charge' | 'refund' | 'other'

/**
 * Map a Meta ad-account activity `event_type` to a money status.
 * Returns null for events that are not about money (campaign edits etc.),
 * which the sync skips.
 */
export function classifyFundingEvent(eventType: string | null | undefined): FundingStatus | null {
  switch (String(eventType || '')) {
    case 'funding_event_successful':          return 'successful'
    case 'funding_event_initiated':           return 'initiated'
    case 'ad_account_billing_charge':         return 'charge'
    case 'ad_account_billing_charge_failed':
    case 'ad_account_billing_decline':        return 'failed'
    case 'ad_account_billing_refund':
    case 'ad_account_billing_chargeback':     return 'refund'
    case 'ad_account_billing_chargeback_reversal':
    case 'billing_event':                     return 'other'
    default:                                  return null
  }
}

/** Parse a money string such as "₹1,000.00", "1000.00 INR" or "1,000". */
export function parseMoney(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? r2(v) : null
  if (typeof v !== 'string') return null
  const m = v.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)
  if (!m) return null
  const n = Number(m[0])
  return Number.isFinite(n) ? r2(n) : null
}

const AMOUNT_KEYS = ['amount', 'funded_amount', 'funding_amount', 'payment_amount', 'value', 'new_value']
const CURRENCY_KEYS = ['currency', 'currency_code']

/**
 * Best-effort amount + currency from an activity's `extra_data` (a JSON
 * string whose shape Meta does not document). Looks for amount-like keys at
 * any depth, preferring the most specific names, and falls back to a money
 * pattern in the raw text. Never throws.
 */
export function parseFundingAmount(extra: unknown): { amount: number | null; currency: string | null } {
  let obj: unknown = extra
  if (typeof extra === 'string') {
    try { obj = JSON.parse(extra) } catch { obj = extra }
  }
  let amount: number | null = null
  let amountRank = Infinity
  let currency: string | null = null

  const visit = (node: unknown, depth: number) => {
    if (depth > 6 || node == null) return
    if (Array.isArray(node)) { node.forEach(n => visit(n, depth + 1)); return }
    if (typeof node !== 'object') return
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const key = k.toLowerCase()
      const rank = AMOUNT_KEYS.indexOf(key)
      if (rank >= 0 && rank < amountRank) {
        const n = typeof v === 'object' && v !== null ? null : parseMoney(v)
        if (n !== null && n > 0) { amount = n; amountRank = rank }
      }
      if (!currency && CURRENCY_KEYS.includes(key) && typeof v === 'string' && /^[A-Z]{3}$/.test(v)) currency = v
      if (typeof v === 'object') visit(v, depth + 1)
    }
  }
  visit(obj, 0)

  if (amount === null && typeof obj === 'string') {
    const m = obj.match(/(?:₹|INR|Rs\.?)\s*([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*INR/i)
    if (m) amount = parseMoney(m[1] ?? m[2])
    if (amount !== null && !currency && /INR|₹|Rs/i.test(obj)) currency = 'INR'
  }
  return { amount, currency }
}

/**
 * Prepaid "available balance" from funding_source_details.display_string,
 * e.g. "Available balance (₹323.14 INR)". Null when it isn't a prepaid
 * balance string (a card, a credit line…).
 */
export function parseAvailableBalance(display: string | null | undefined): number | null {
  if (!display || !/balance/i.test(display)) return null
  return parseMoney(display.replace(/^[^(\d₹]*/, ''))
}

// ─── Matching Meta events ↔ Cashbook top-ups ────────────────────────────────

export interface FundingEventLite {
  id: string
  adAccountId: string
  status: FundingStatus
  amount: number | null
  /** ISO timestamp. */
  eventTime: string
  cashbookEntryId: string | null
  dismissedAt?: string | null
}

export interface TopUpEntryLite {
  id: string
  adAccountId: string | null
  amount: number
  /** YYYY-MM-DD */
  entryDate: string
}

const dayOf = (iso: string) => iso.slice(0, 10)
const daysBetween = (a: string, b: string) => Math.abs(Date.parse(dayOf(a)) - Date.parse(dayOf(b))) / DAY

/**
 * Link each SUCCESSFUL Meta funding event that has no Cashbook entry to the
 * nearest-dated unlinked top-up on the same account with the same amount
 * (± `amountTolerance`) within `toleranceDays`. One entry ↔ one event.
 * Returns eventId → entryId for the NEW links only.
 */
export function matchFundingEvents(
  events: FundingEventLite[],
  entries: TopUpEntryLite[],
  opts: { toleranceDays?: number; amountTolerance?: number } = {},
): Map<string, string> {
  const { toleranceDays = 3, amountTolerance = 0.5 } = opts
  const taken = new Set(events.map(e => e.cashbookEntryId).filter((v): v is string => !!v))
  const out = new Map<string, string>()
  const open = events
    .filter(e => e.status === 'successful' && !e.cashbookEntryId && e.amount !== null)
    .sort((a, b) => a.eventTime.localeCompare(b.eventTime))
  for (const ev of open) {
    let best: TopUpEntryLite | null = null
    let bestGap = Infinity
    for (const en of entries) {
      if (taken.has(en.id) || en.adAccountId !== ev.adAccountId) continue
      if (Math.abs(Number(en.amount) - Number(ev.amount)) > amountTolerance) continue
      const gap = daysBetween(en.entryDate, ev.eventTime)
      if (gap <= toleranceDays && gap < bestGap) { best = en; bestGap = gap }
    }
    if (best) { out.set(ev.id, best.id); taken.add(best.id) }
  }
  return out
}

/**
 * Initiated payments that never succeeded: an `initiated` event with no
 * `successful` event on the same account (same amount when both are known)
 * within `windowHours` after it, once `graceHours` have passed.
 */
export function failedInitiations(
  events: FundingEventLite[], now: Date, opts: { windowHours?: number; graceHours?: number } = {},
): FundingEventLite[] {
  const { windowHours = 2, graceHours = 6 } = opts
  const successes = events.filter(e => e.status === 'successful')
  const used = new Set<string>()
  return events
    .filter(e => e.status === 'initiated' && !e.dismissedAt)
    .sort((a, b) => a.eventTime.localeCompare(b.eventTime))
    .filter(init => {
      if (now.getTime() - Date.parse(init.eventTime) < graceHours * 3_600_000) return false
      const t0 = Date.parse(init.eventTime)
      const hit = successes.find(s =>
        !used.has(s.id)
        && s.adAccountId === init.adAccountId
        && Date.parse(s.eventTime) >= t0 - 60_000
        && Date.parse(s.eventTime) <= t0 + windowHours * 3_600_000
        && (s.amount === null || init.amount === null || Math.abs(s.amount - init.amount) < 0.5))
      if (hit) { used.add(hit.id); return false }
      return true
    })
}

/**
 * Top-ups recorded in the Cashbook that Meta never confirmed: a top-up on an
 * account whose billing IS synced, older than `graceHours`, that no successful
 * funding event is linked to. (Likely a failed payment — check the bank.)
 */
export function unconfirmedTopUps(
  entries: TopUpEntryLite[], events: FundingEventLite[], syncedAccountIds: Set<string>, now: Date,
  opts: { graceHours?: number } = {},
): TopUpEntryLite[] {
  const { graceHours = 12 } = opts
  const confirmed = new Set(events.filter(e => e.status === 'successful' && e.cashbookEntryId).map(e => e.cashbookEntryId as string))
  return entries.filter(en =>
    en.adAccountId
    && syncedAccountIds.has(en.adAccountId)
    && !confirmed.has(en.id)
    // entryDate is a calendar day: count the grace from the END of that day.
    && now.getTime() - (Date.parse(en.entryDate) + DAY) >= graceHours * 3_600_000)
}

// ─── Which client is an unmatched top-up for? ───────────────────────────────

export interface SpendLite {
  adAccountId: string
  clientId: string | null
  /** YYYY-MM-DD */
  date: string
  spendExGst: number
}

/**
 * Rank the clients whose campaigns spent on this account around the funding
 * date (−3 … +2 days) — the money was most likely added for them. Ties break
 * on spend. Returns client ids, best first (empty = no idea).
 */
export function suggestClients(spend: SpendLite[], adAccountId: string, onIso: string): string[] {
  const day = Date.parse(dayOf(onIso))
  const totals = new Map<string, number>()
  for (const s of spend) {
    if (s.adAccountId !== adAccountId || !s.clientId || s.spendExGst <= 0) continue
    const d = (Date.parse(s.date) - day) / DAY
    if (d < -3 || d > 2) continue
    totals.set(s.clientId, (totals.get(s.clientId) ?? 0) + s.spendExGst)
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

// ─── Wallet runway → top-up suggestion ──────────────────────────────────────

export interface ClientFundsInput {
  /** Σ wallet credits (top-ups), INR, incl. GST. */
  creditedInr: number
  /** Lifetime spend incl. GST on the client's campaigns, INR. */
  spentInclGstInr: number
  /** Spend incl. GST over the last `burnDays` days. */
  recentSpendInclGstInr: number
  burnDays: number
  /** Campaigns currently delivering for this client. */
  activeCampaigns: number
}

export interface TopUpSuggestion {
  balanceInr: number
  dailyBurnInr: number
  /** null when nothing is spending. */
  runwayDays: number | null
  level: 'ok' | 'low' | 'empty' | 'idle'
  /** Rounded amount to add, or null when no top-up is needed. */
  suggestedInr: number | null
}

/**
 * Balance = top-ups − spend (both incl. GST). With live campaigns burning
 * money, suggest topping up to `targetDays` of runway when it drops under
 * `warnDays`, rounded up to `roundTo` and at least `minTopUp`.
 */
export function suggestTopUp(
  c: ClientFundsInput,
  opts: { warnDays?: number; targetDays?: number; roundTo?: number; minTopUp?: number } = {},
): TopUpSuggestion {
  const { warnDays = 3, targetDays = 7, roundTo = 100, minTopUp = 500 } = opts
  const balanceInr = r2(c.creditedInr - c.spentInclGstInr)
  const dailyBurnInr = c.burnDays > 0 ? r2(c.recentSpendInclGstInr / c.burnDays) : 0
  if (c.activeCampaigns <= 0 || dailyBurnInr <= 0) {
    return { balanceInr, dailyBurnInr, runwayDays: null, level: balanceInr < 0 ? 'empty' : 'idle', suggestedInr: balanceInr < 0 ? Math.max(minTopUp, Math.ceil(-balanceInr / roundTo) * roundTo) : null }
  }
  const runwayDays = Math.round((balanceInr / dailyBurnInr) * 10) / 10
  const level: TopUpSuggestion['level'] = balanceInr <= 0 ? 'empty' : runwayDays < warnDays ? 'low' : 'ok'
  if (level === 'ok') return { balanceInr, dailyBurnInr, runwayDays, level, suggestedInr: null }
  const need = dailyBurnInr * targetDays - balanceInr
  const suggestedInr = Math.max(minTopUp, Math.ceil(need / roundTo) * roundTo)
  return { balanceInr, dailyBurnInr, runwayDays, level, suggestedInr }
}

// ─── Statement: spend vs invoiced ───────────────────────────────────────────

export interface StatementSpend {
  clientId: string | null
  projectId: string | null
  campaignKey: string
  campaignName: string
  /** YYYY-MM-DD */
  date: string
  spendExGst: number
}

export interface StatementBilled {
  clientId: string
  /** YYYY-MM — the invoice's billing month. */
  period: string
  amountInr: number
  /** 'ad_spend' = billed from actual spend; 'topup' = legacy line that rebilled a top-up. */
  source: 'ad_spend' | 'topup'
  invoiceNumber: string | null
  invoiceStatus: string | null
  projectId?: string | null
}

export interface StatementCampaignLine {
  campaignKey: string
  campaignName: string
  projectId: string | null
  days: number
  spendExGst: number
  gst: number
  spendInclGst: number
}

export interface StatementMonth {
  period: string
  campaigns: StatementCampaignLine[]
  spendInclGst: number
  billedInr: number
  /** spend − billed (positive = under-invoiced). */
  differenceInr: number
  invoices: { number: string | null; status: string | null; amountInr: number; source: 'ad_spend' | 'topup' }[]
  status: 'ok' | 'short' | 'over' | 'not_invoiced' | 'running'
}

export interface StatementClient {
  /** null = spend on campaigns not mapped to any client (cannot be billed). */
  clientId: string | null
  months: StatementMonth[]
  spendInclGst: number
  billedInr: number
  differenceInr: number
}

/**
 * Group spend by client → month → campaign and set it against what was
 * invoiced. A month is 'running' while it is the current month (still
 * accruing); 'short' / 'over' use a ₹1 tolerance. The client totals are the
 * lifetime truth — month buckets can disagree when a top-up was billed in a
 * different month from when it was spent.
 */
export function buildStatement(
  spend: StatementSpend[], billed: StatementBilled[], currentPeriod: string,
): StatementClient[] {
  const byClient = new Map<string, { spend: StatementSpend[]; billed: StatementBilled[] }>()
  const key = (c: string | null) => c ?? '__unmapped__'
  for (const s of spend) (byClient.get(key(s.clientId)) ?? byClient.set(key(s.clientId), { spend: [], billed: [] }).get(key(s.clientId))!).spend.push(s)
  for (const b of billed) (byClient.get(key(b.clientId)) ?? byClient.set(key(b.clientId), { spend: [], billed: [] }).get(key(b.clientId))!).billed.push(b)

  const out: StatementClient[] = []
  for (const [k, v] of byClient) {
    const clientId = k === '__unmapped__' ? null : k
    const periods = new Set<string>([...v.spend.map(s => s.date.slice(0, 7)), ...v.billed.map(b => b.period)])
    const months: StatementMonth[] = [...periods].sort().map(period => {
      const camp = new Map<string, StatementCampaignLine & { dates: Set<string> }>()
      for (const s of v.spend.filter(x => x.date.startsWith(period))) {
        const c = camp.get(s.campaignKey) ?? { campaignKey: s.campaignKey, campaignName: s.campaignName, projectId: s.projectId, days: 0, spendExGst: 0, gst: 0, spendInclGst: 0, dates: new Set<string>() }
        c.spendExGst = r2(c.spendExGst + s.spendExGst)
        if (s.spendExGst > 0) c.dates.add(s.date)
        camp.set(s.campaignKey, c)
      }
      const campaigns = [...camp.values()].map(({ dates, ...c }) => {
        const incl = withGst(c.spendExGst)
        return { ...c, days: dates.size, spendInclGst: incl, gst: r2(incl - c.spendExGst) }
      }).filter(c => c.spendExGst > 0).sort((a, b) => b.spendInclGst - a.spendInclGst)
      const spendInclGst = r2(campaigns.reduce((t, c) => t + c.spendInclGst, 0))
      const bills = v.billed.filter(b => b.period === period)
      const billedInr = r2(bills.reduce((t, b) => t + b.amountInr, 0))
      const differenceInr = r2(spendInclGst - billedInr)
      const status: StatementMonth['status'] =
        clientId === null ? 'not_invoiced'
        : period === currentPeriod && differenceInr > 1 ? 'running'
        : billedInr === 0 && spendInclGst > 0 ? 'not_invoiced'
        : differenceInr > 1 ? 'short'
        : differenceInr < -1 ? 'over'
        : 'ok'
      return {
        period, campaigns, spendInclGst, billedInr, differenceInr, status,
        invoices: bills.map(b => ({ number: b.invoiceNumber, status: b.invoiceStatus, amountInr: b.amountInr, source: b.source })),
      }
    })
    const spendInclGst = r2(months.reduce((t, m) => t + m.spendInclGst, 0))
    const billedInr = r2(months.reduce((t, m) => t + m.billedInr, 0))
    out.push({ clientId, months, spendInclGst, billedInr, differenceInr: r2(spendInclGst - billedInr) })
  }
  // Biggest leak first; unmapped spend always on top (it can never be billed).
  return out.sort((a, b) => (a.clientId === null ? -1 : b.clientId === null ? 1 : b.differenceInr - a.differenceInr))
}

/** Monthly ad-spend invoice lines for one campaign: period → amount incl. GST. */
export function monthlySpendInclGst(rows: { date: string; spendExGst: number }[]): Map<string, number> {
  const ex = new Map<string, number>()
  for (const r of rows) ex.set(r.date.slice(0, 7), r2((ex.get(r.date.slice(0, 7)) ?? 0) + Number(r.spendExGst || 0)))
  return new Map([...ex].map(([p, v]) => [p, withGst(v)]))
}

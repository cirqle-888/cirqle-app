/**
 * Business units — one department's or sub-brand's profit and loss, optionally shared by agreement
 * (pure; no database).
 *
 * The owner agrees with the team running a department to share its WHOLE
 * result, profit or loss, at fixed percentages (Social Media & Creative:
 * owner 40 %, CQID004 30 %, CQID005 30 %). Per department, per month:
 *
 *   income         Cirqle's own revenue on the department's invoices —
 *                  service fees and markups, never pass-through (ad spend,
 *                  rebilled costs) or tax. Counted when the money is
 *                  COLLECTED (default) or when the invoice is ISSUED.
 *   other income   Cash Book receipts tagged to the department.
 *   direct costs   Cash Book payments tagged to the department, or carrying
 *                  a service of it.
 *   general costs  its equal part of every General payment (subscriptions,
 *                  tools, domains) — General is split equally between the
 *                  departments that share general costs that month.
 *   result         income + other income − direct costs − general costs.
 *
 * Each partner's share is result × their percentage, so a loss is shared the
 * same way as a profit. Amounts are split to the paisa (largest remainder),
 * so the partners' shares always add back to the result exactly.
 *
 * Which department an invoice belongs to: each line's service category
 * (Settings → Departments) decides, weighted by line amount. An admin can
 * instead put the WHOLE invoice in one department — a big request from an
 * Offer Flyer client counted in Social Media — or leave it out of all of them.
 */

import { round2 } from '@/lib/calculations/currency'
import { splitByWeight } from '@/lib/reports/ownership-allocation'

/** Stands for "no department": the money stays with the company. */
export const NONE = '__none__'

export type RevenueBasis = 'collected' | 'invoiced'

/** Invoice statuses that mean the invoice has been issued to the client. */
export const ISSUED_STATUSES = ['sent', 'partial', 'overdue', 'paid', 'closed'] as const

export interface DeptPartner {
  employeeId: string
  cqid: string
  sharePct: number
}

export interface UnitMember {
  employeeId: string
  cqid: string
  role: 'lead' | 'member'
}

/**
 * A unit: one of Cirqle's departments (Social Media & Creative, Cirqle Flyers)
 * or sub-brands (Memoura). `partners` is its profit-and-loss agreement and may
 * be empty — then the unit's result simply stays with Cirqle. `members` is the
 * team that runs it; the engine ignores them (they are about access, not money).
 */
export interface DeptConfig {
  id: string
  name: string
  slug: string
  kind: 'department' | 'brand'
  color: string | null
  categoryIds: string[]
  revenueBasis: RevenueBasis
  sharesGeneralCosts: boolean
  /** YYYY-MM-DD, the first of a month. */
  startsOn: string
  endsOn: string | null
  isActive: boolean
  teamSeesResults: boolean
  partners: DeptPartner[]
  members: UnitMember[]
}

export type UnitConfig = DeptConfig

export interface EngineInvoice {
  id: string
  number: string | null
  clientId: string | null
  clientName: string | null
  issueDate: string | null
  status: string
  /** Cirqle's own revenue on the invoice in INR (fees + markups − discount). */
  ownInr: number
  totalInr: number
  /** One row per invoice line; amounts in any currency — only proportions matter. */
  lines: { categoryId: string | null; amount: number }[]
  /** Admin override: whole invoice to one department, or to none (null). Undefined = automatic. */
  override?: { departmentId: string | null }
}

/** A payment's own-revenue part, already split out of pass-through and tax. */
export interface EngineCollection {
  invoiceId: string
  entryId: string
  /** YYYY-MM-DD the money counts as received. */
  on: string
  ownInr: number
}

export interface EngineEntry {
  id: string
  date: string
  type: 'inflow' | 'outflow'
  amountInr: number
  description: string | null
  categoryId: string | null
  categoryName: string | null
  /** The service category of the entry's service, if it carries one. */
  serviceCategoryId: string | null
  clientId: string | null
  /** The person a payment was for (salary, advance), when the entry names one. */
  employeeId?: string | null
  reversalOf: string | null
  /** Internal transfer between Cirqle's own accounts — never income or cost. */
  isTransfer: boolean
  /** Settles an invoice — the income is already counted from the invoice. */
  isInvoiceReceipt: boolean
  /** Pass-through: rebilled to a client, billable, or an ad-wallet top-up. */
  isPassThrough: boolean
}

export interface EntryTag {
  departmentId: string | null
  isGeneral: boolean
  isExcluded: boolean
}

/** One unit's part of a split entry: a percentage or an amount — only the proportions matter. */
export interface SplitPart {
  unitId: string
  share: number
}

export type EntryKind =
  | { kind: 'dept'; departmentId: string; how: 'tagged' | 'service' | 'reversal' }
  | { kind: 'split'; parts: SplitPart[]; how: 'split' | 'reversal' }
  | { kind: 'general'; how: 'tagged' | 'category' | 'reversal' }
  | { kind: 'none'; how: 'excluded' | 'untagged' | 'transfer' | 'invoice_receipt' | 'pass_through' | 'reversal' }

export interface PartnerShare {
  employeeId: string
  cqid: string
  sharePct: number
  amountInr: number
}

export interface DeptMonth {
  /** YYYY-MM */
  month: string
  incomeInr: number
  otherIncomeInr: number
  directCostsInr: number
  generalCostsInr: number
  resultInr: number
  partners: PartnerShare[]
}

export interface DeptInvoiceRow {
  invoiceId: string
  number: string | null
  clientId: string | null
  clientName: string | null
  issueDate: string | null
  status: string
  /** Share of the invoice's own revenue that belongs to this department (0–1). */
  fraction: number
  how: 'auto' | 'assigned'
  /** This department's part of the invoice's own revenue. */
  ownInr: number
  /** This department's part of what was collected in the period. */
  collectedInr: number
  totalInr: number
}

export interface DeptEntryRow {
  entryId: string
  date: string
  type: 'inflow' | 'outflow'
  description: string | null
  categoryName: string | null
  amountInr: number
  /** 'combined' = several confidential staff entries shown as one line (lib/units/confidential). */
  how: EntryKind['how'] | 'combined'
  /** The person the entry was for, when it names one (salary, advance). */
  employeeId?: string | null
  /** For a General entry: this department's part of it. Equal to amountInr for a direct entry. */
  shareInr: number
  general: boolean
  /** For a split entry: this unit's percentage of it. */
  splitPct?: number
}

export interface DeptLedger {
  department: DeptConfig
  months: DeptMonth[]
  /** Σ of `months`, with each partner's total. */
  total: Omit<DeptMonth, 'month'>
  invoices: DeptInvoiceRow[]
  entries: DeptEntryRow[]
}

export interface GeneralMonth {
  month: string
  /** Net General payments (payments − refunds) in the month. */
  netInr: number
  /** Departments that carried part of it. Empty = the company kept all of it. */
  splitBetween: string[]
}

export interface EngineInput {
  departments: DeptConfig[]
  /** Months to report, ascending YYYY-MM. */
  months: string[]
  invoices: EngineInvoice[]
  collections: EngineCollection[]
  entries: EngineEntry[]
  tags: Map<string, EntryTag>
  generalCategoryIds: Set<string>
  /** Entries split across units by share (percent or amount). Wins over a tag. */
  splits?: Map<string, SplitPart[]>
}

export interface EngineResult {
  ledgers: DeptLedger[]
  general: GeneralMonth[]
  /** Company entries in the months with no department and nothing General about them. */
  untagged: EngineEntry[]
  /** Own revenue in the months that landed in no department, by invoice (issued and collected). */
  unassignedIncome: { invoice: EngineInvoice; invoicedInr: number; collectedInr: number }[]
  /** Every entry's classification (for the Cash Book tag controls). */
  classified: Map<string, EntryKind>
}

const month = (d: string) => d.slice(0, 7)

/** Is the department running in this month (YYYY-MM)? */
export function runsIn(d: DeptConfig, m: string): boolean {
  if (!d.isActive) return false
  if (month(d.startsOn) > m) return false
  if (d.endsOn && month(d.endsOn) < m) return false
  return true
}

/** Split any signed amount by weights, to the paisa. */
export function splitSigned(total: number, weights: number[]): number[] {
  const parts = splitByWeight(Math.abs(total), weights)
  return total < 0 ? parts.map(p => (p === 0 ? 0 : -p)) : parts
}

/** Partners' shares of a result. Percentages need not total 100 — the rest stays with nobody, so callers validate. */
export function partnerShares(resultInr: number, partners: DeptPartner[]): PartnerShare[] {
  if (partners.length === 0) return []
  const totalPct = partners.reduce((s, p) => s + p.sharePct, 0)
  // Split the part of the result the percentages cover, then hand it out by weight.
  const covered = round2(resultInr * Math.min(100, totalPct) / 100)
  const parts = splitSigned(covered, partners.map(p => p.sharePct))
  return partners.map((p, i) => ({ employeeId: p.employeeId, cqid: p.cqid, sharePct: p.sharePct, amountInr: parts[i] }))
}

/** category id → department id, for departments running in month m (first listed wins). */
export function categoryMap(departments: DeptConfig[], m?: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const d of departments) {
    if (m ? !runsIn(d, m) : !d.isActive) continue
    for (const c of d.categoryIds) if (!map.has(c)) map.set(c, d.id)
  }
  return map
}

/** How an invoice's own revenue divides between departments: department id (or NONE) → fraction. */
export function invoiceSplit(inv: EngineInvoice, catToDept: Map<string, string>): Map<string, number> {
  if (inv.override) return new Map([[inv.override.departmentId ?? NONE, 1]])
  const weights = new Map<string, number>()
  for (const l of inv.lines) {
    const d = (l.categoryId && catToDept.get(l.categoryId)) || NONE
    weights.set(d, (weights.get(d) ?? 0) + Math.max(0, l.amount))
  }
  const total = [...weights.values()].reduce((s, v) => s + v, 0)
  if (total <= 0) return new Map([[NONE, 1]])
  return new Map([...weights].filter(([, w]) => w > 0).map(([d, w]) => [d, w / total]))
}

/** Which department (if any) a Cash Book entry belongs to. */
export function classifyEntry(
  e: EngineEntry,
  tags: Map<string, EntryTag>,
  catToDept: Map<string, string>,
  generalCategoryIds: Set<string>,
  original?: EntryKind,
  splits?: Map<string, SplitPart[]>,
): EntryKind {
  const split = splits?.get(e.id)
  if (split?.length) return { kind: 'split', parts: split, how: 'split' }
  const tag = tags.get(e.id)
  if (tag) {
    if (tag.isExcluded) return { kind: 'none', how: 'excluded' }
    if (tag.isGeneral) return { kind: 'general', how: 'tagged' }
    if (tag.departmentId) return { kind: 'dept', departmentId: tag.departmentId, how: 'tagged' }
  }
  if (e.isTransfer) return { kind: 'none', how: 'transfer' }
  if (e.isInvoiceReceipt) return { kind: 'none', how: 'invoice_receipt' }
  // A return or reversal follows the entry it undoes, so the two net to nothing.
  if (e.reversalOf && original) {
    if (original.kind === 'dept') return { kind: 'dept', departmentId: original.departmentId, how: 'reversal' }
    if (original.kind === 'general') return { kind: 'general', how: 'reversal' }
    if (original.kind === 'split') return { kind: 'split', parts: original.parts, how: 'reversal' }
    return { kind: 'none', how: 'reversal' }
  }
  if (e.isPassThrough) return { kind: 'none', how: 'pass_through' }
  if (e.serviceCategoryId) {
    const d = catToDept.get(e.serviceCategoryId)
    if (d) return { kind: 'dept', departmentId: d, how: 'service' }
  }
  if (e.categoryId && generalCategoryIds.has(e.categoryId) && !e.clientId && e.type === 'outflow') {
    return { kind: 'general', how: 'category' }
  }
  return { kind: 'none', how: 'untagged' }
}

const signed = (e: Pick<EngineEntry, 'type' | 'amountInr'>) => (e.type === 'outflow' ? 1 : -1) * Math.abs(e.amountInr)

export function computeDepartmentShares(input: EngineInput): EngineResult {
  const months = [...input.months].sort()
  const inMonths = new Set(months)
  const deptById = new Map(input.departments.map(d => [d.id, d]))

  // ── Classify every entry (originals first, so reversals can follow them) ──
  // Classification ignores the month: a category belongs to its department
  // whenever it is active. The money is only reported in the months the
  // department runs (see the per-department pass below).
  const classified = new Map<string, EntryKind>()
  const anyCat = categoryMap(input.departments)
  const byId = new Map(input.entries.map(e => [e.id, e]))
  const classify = (e: EngineEntry, depth = 0): EntryKind => {
    const done = classified.get(e.id)
    if (done) return done
    const orig = e.reversalOf && depth < 5 && byId.has(e.reversalOf) ? classify(byId.get(e.reversalOf)!, depth + 1) : undefined
    const k = classifyEntry(e, input.tags, anyCat, input.generalCategoryIds, orig, input.splits)
    classified.set(e.id, k)
    return k
  }
  for (const e of input.entries) classify(e)

  // ── General pool per month, split equally ──
  const generalNet = new Map<string, number>()
  for (const e of input.entries) {
    const m = month(e.date)
    if (!inMonths.has(m)) continue
    if (classified.get(e.id)?.kind === 'general') generalNet.set(m, round2((generalNet.get(m) ?? 0) + signed(e)))
  }
  const generalShare = new Map<string, Map<string, number>>() // month → dept → share
  const general: GeneralMonth[] = months.map(m => {
    const sharing = input.departments.filter(d => d.sharesGeneralCosts && runsIn(d, m))
    const net = generalNet.get(m) ?? 0
    const parts = splitSigned(net, sharing.map(() => 1))
    generalShare.set(m, new Map(sharing.map((d, i) => [d.id, parts[i]])))
    return { month: m, netInr: net, splitBetween: sharing.map(d => d.id) }
  })

  // ── Income per invoice → departments ──
  const invById = new Map(input.invoices.map(i => [i.id, i]))
  const splitCache = new Map<string, Map<string, number>>()
  const splitOf = (inv: EngineInvoice, m: string) => {
    const k = `${inv.id}|${m}`
    let s = splitCache.get(k)
    if (!s) {
      const map = categoryMap(input.departments, m)
      s = invoiceSplit(inv, map)
      // An assigned department that isn't running that month can't take the money.
      const dep = inv.override?.departmentId ? deptById.get(inv.override.departmentId) : undefined
      if (dep && !runsIn(dep, m)) s = new Map([[NONE, 1]])
      splitCache.set(k, s)
    }
    return s
  }

  const income = new Map<string, number>() // `${dept}|${month}` → INR
  const collectedByInvDept = new Map<string, number>() // `${inv}|${dept}`
  const ownByInvDept = new Map<string, number>()
  const touched = new Map<string, Set<string>>() // dept → invoice ids
  const unassignedCollected = new Map<string, number>() // invoice → INR in no department
  const unassignedInvoiced = new Map<string, number>()
  const addTo = (m: Map<string, number>, k: string, v: number) => m.set(k, round2((m.get(k) ?? 0) + v))
  const touch = (d: string, invId: string) => { const s = touched.get(d) ?? new Set(); s.add(invId); touched.set(d, s) }

  const spread = (inv: EngineInvoice, amount: number, m: string, collected: boolean) => {
    const s = splitOf(inv, m)
    const keys = [...s.keys()]
    const parts = splitSigned(amount, keys.map(k => s.get(k) ?? 0))
    keys.forEach((d, i) => {
      const dep = d === NONE ? undefined : deptById.get(d)
      if (!dep) { addTo(collected ? unassignedCollected : unassignedInvoiced, inv.id, parts[i]); return }
      touch(d, inv.id)
      if (collected) addTo(collectedByInvDept, `${inv.id}|${d}`, parts[i])
      else addTo(ownByInvDept, `${inv.id}|${d}`, parts[i])
      const counts = collected ? dep.revenueBasis === 'collected' : dep.revenueBasis === 'invoiced'
      if (counts) addTo(income, `${d}|${m}`, parts[i])
    })
  }

  for (const c of input.collections) {
    const m = month(c.on)
    if (!inMonths.has(m) || c.ownInr === 0) continue
    const inv = invById.get(c.invoiceId)
    if (inv) spread(inv, c.ownInr, m, true)
  }
  for (const inv of input.invoices) {
    if (!inv.issueDate || !(ISSUED_STATUSES as readonly string[]).includes(inv.status)) continue
    const m = month(inv.issueDate)
    if (!inMonths.has(m) || inv.ownInr === 0) continue
    spread(inv, inv.ownInr, m, false)
  }

  // ── Per department ──
  const ledgers: DeptLedger[] = input.departments.map(dept => {
    const otherIncome = new Map<string, number>()
    const direct = new Map<string, number>()
    const entries: DeptEntryRow[] = []
    for (const e of input.entries) {
      const m = month(e.date)
      if (!inMonths.has(m) || !runsIn(dept, m)) continue
      const k = classified.get(e.id)
      if (k?.kind === 'dept' && k.departmentId === dept.id) {
        if (e.type === 'inflow' && !e.reversalOf) addTo(otherIncome, m, Math.abs(e.amountInr))
        else addTo(direct, m, signed(e))
        entries.push(row(e, k.how, Math.abs(e.amountInr), false))
      } else if (k?.kind === 'split') {
        const i = k.parts.findIndex(p => p.unitId === dept.id)
        if (i < 0) continue
        const part = splitByWeight(Math.abs(e.amountInr), k.parts.map(p => p.share))[i]
        if (e.type === 'inflow' && !e.reversalOf) addTo(otherIncome, m, part)
        else addTo(direct, m, (e.type === 'outflow' ? 1 : -1) * part)
        const total = k.parts.reduce((t, p) => t + Math.max(0, p.share), 0)
        entries.push({ ...row(e, k.how, part, false), splitPct: total > 0 ? Math.round((k.parts[i].share / total) * 10000) / 100 : 0 })
      } else if (k?.kind === 'general') {
        const sharing = input.departments.filter(d => d.sharesGeneralCosts && runsIn(d, m))
        const i = sharing.findIndex(d => d.id === dept.id)
        if (i < 0) continue
        const part = splitByWeight(Math.abs(e.amountInr), sharing.map(() => 1))[i]
        entries.push(row(e, k.how, part, true))
      }
    }
    entries.sort((a, b) => b.date.localeCompare(a.date))

    const deptMonths: DeptMonth[] = months.filter(m => runsIn(dept, m)).map(m => {
      const inc = income.get(`${dept.id}|${m}`) ?? 0
      const oth = otherIncome.get(m) ?? 0
      const dir = direct.get(m) ?? 0
      const gen = generalShare.get(m)?.get(dept.id) ?? 0
      const result = round2(inc + oth - dir - gen)
      return {
        month: m, incomeInr: inc, otherIncomeInr: oth, directCostsInr: dir, generalCostsInr: gen,
        resultInr: result, partners: partnerShares(result, dept.partners),
      }
    })

    const sum = (f: (r: DeptMonth) => number) => round2(deptMonths.reduce((s, r) => s + f(r), 0))
    const total: Omit<DeptMonth, 'month'> = {
      incomeInr: sum(r => r.incomeInr),
      otherIncomeInr: sum(r => r.otherIncomeInr),
      directCostsInr: sum(r => r.directCostsInr),
      generalCostsInr: sum(r => r.generalCostsInr),
      resultInr: sum(r => r.resultInr),
      partners: dept.partners.map(p => ({
        employeeId: p.employeeId, cqid: p.cqid, sharePct: p.sharePct,
        amountInr: round2(deptMonths.reduce((s, r) => s + (r.partners.find(x => x.employeeId === p.employeeId)?.amountInr ?? 0), 0)),
      })),
    }

    const invoices: DeptInvoiceRow[] = [...(touched.get(dept.id) ?? [])].map(id => {
      const inv = invById.get(id)!
      const anyMonth = inv.issueDate ? month(inv.issueDate) : months[months.length - 1]
      const s = splitOf(inv, anyMonth)
      return {
        invoiceId: id, number: inv.number, clientId: inv.clientId, clientName: inv.clientName,
        issueDate: inv.issueDate, status: inv.status, fraction: s.get(dept.id) ?? 0,
        how: inv.override ? 'assigned' as const : 'auto' as const,
        ownInr: ownByInvDept.get(`${id}|${dept.id}`) ?? 0,
        collectedInr: collectedByInvDept.get(`${id}|${dept.id}`) ?? 0,
        totalInr: inv.totalInr,
      }
    }).sort((a, b) => (b.issueDate ?? '').localeCompare(a.issueDate ?? ''))

    return { department: dept, months: deptMonths, total, invoices, entries }
  })

  const untagged = input.entries
    .filter(e => inMonths.has(month(e.date)) && classified.get(e.id)?.how === 'untagged')
    .sort((a, b) => b.date.localeCompare(a.date))

  const unassignedIds = new Set([...unassignedCollected.keys(), ...unassignedInvoiced.keys()])
  const unassignedIncome = [...unassignedIds]
    .map(id => ({ invoice: invById.get(id)!, invoicedInr: unassignedInvoiced.get(id) ?? 0, collectedInr: unassignedCollected.get(id) ?? 0 }))
    .filter(r => Math.abs(r.invoicedInr) >= 0.01 || Math.abs(r.collectedInr) >= 0.01)
    .sort((a, b) => Math.max(b.invoicedInr, b.collectedInr) - Math.max(a.invoicedInr, a.collectedInr))

  return { ledgers, general, untagged, unassignedIncome, classified }
}

function row(e: EngineEntry, how: EntryKind['how'], shareInr: number, isGeneral: boolean): DeptEntryRow {
  return {
    entryId: e.id, date: e.date, type: e.type, description: e.description, categoryName: e.categoryName,
    amountInr: Math.abs(e.amountInr), how, shareInr, general: isGeneral, employeeId: e.employeeId ?? null,
  }
}

/** YYYY-MM months from `from` to `to`, inclusive. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = []
  let [y, m] = from.slice(0, 7).split('-').map(Number)
  const [ty, tm] = to.slice(0, 7).split('-').map(Number)
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) { m = 1; y += 1 }
    if (out.length > 600) break
  }
  return out
}

export interface DeptValidation {
  ok: boolean
  errors: string[]
}

/** The checks a department must pass before it is saved. */
export function validateDepartment(
  d: Pick<DeptConfig, 'id' | 'name' | 'categoryIds' | 'partners' | 'startsOn' | 'endsOn' | 'isActive'>,
  others: Pick<DeptConfig, 'id' | 'name' | 'categoryIds' | 'isActive'>[],
): DeptValidation {
  const errors: string[] = []
  if (!d.name.trim()) errors.push('Give the unit a name.')
  if (!/^\d{4}-\d{2}-01$/.test(d.startsOn)) errors.push('Pick the month its results start.')
  if (d.endsOn && d.endsOn < d.startsOn) errors.push('It cannot end before it starts.')
  // No partners is allowed: no agreement, the result stays with Cirqle.
  const ids = new Set<string>()
  for (const p of d.partners) {
    if (ids.has(p.employeeId)) errors.push(`${p.cqid || 'A partner'} is listed twice.`)
    ids.add(p.employeeId)
    if (!(p.sharePct > 0) || p.sharePct > 100) errors.push(`${p.cqid || 'A partner'}: the share must be more than 0 % and at most 100 %.`)
  }
  const total = round2(d.partners.reduce((s, p) => s + p.sharePct, 0))
  if (d.partners.length && Math.abs(total - 100) > 0.001) errors.push(`The shares add up to ${total} %. They must add up to exactly 100 %.`)
  if (d.isActive) {
    for (const o of others) {
      if (o.id === d.id || !o.isActive) continue
      const clash = d.categoryIds.filter(c => o.categoryIds.includes(c))
      if (clash.length) errors.push(`${clash.length === 1 ? 'A category' : `${clash.length} categories`} already belong to ${o.name}. A category can count in only one unit.`)
    }
  }
  return { ok: errors.length === 0, errors }
}

/** A URL-safe slug for a department name. */
export function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60) || 'department'
}

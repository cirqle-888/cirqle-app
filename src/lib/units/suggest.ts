/**
 * Smart allocation — what a waiting Cash Book entry most likely is, and why
 * (pure; no database).
 *
 * Every company payment ends up in one of: ONE unit, a SPLIT across units, the
 * GENERAL pool (split equally between the units that carry general costs), or
 * LEFT OUT (not a business cost at all — a loan, an owner's withdrawal). The
 * rules below look at what the entry already says, strongest signal first:
 *
 *   1. not a cost        — loan, credit, capital or personal-withdrawal categories → left out
 *   2. a salary by parts — when the payment is linked to a payroll: base pay to the person's
 *                          unit(s), contribution earnings where their tasks were, ownership
 *                          equally between the units that carry general costs
 *   3. a person          — a salary or payment to someone on a unit's team → that unit
 *                          (several units → split equally); someone on no team goes by the
 *                          departments assigned to them; working for every unit → General
 *   4. a client          — a cost for a client → the unit(s) that client belongs to
 *   5. like before       — the same description was allocated before → the same again
 *   6. names a unit      — "Social Media team meeting" → Social Media & Creative
 *   7. a shared tool     — subscriptions, AI tools, domains, hosting, phone, internet, rent → General
 *
 * Nothing is applied by this module; it only proposes, with the reason shown
 * to the admin. People are named by CQID only.
 */

import type { SplitPart } from './engine'

export type Allocation =
  | { kind: 'unit'; unitId: string }
  | { kind: 'general' }
  | { kind: 'split'; parts: SplitPart[] }
  | { kind: 'exclude' }

export interface Suggestion {
  allocation: Allocation
  reason: string
  confidence: 'high' | 'medium'
}

export interface SuggestEntry {
  id: string
  type: 'inflow' | 'outflow'
  description: string | null
  categoryName: string | null
  employeeId: string | null
  clientId: string | null
}

export interface SuggestContext {
  unitName: ReadonlyMap<string, string>
  /** employee → the active units they are on */
  unitsOfEmployee: ReadonlyMap<string, readonly string[]>
  /** employee → the units their ASSIGNED departments fall in (for people on no team) */
  assignedUnitsOfEmployee?: ReadonlyMap<string, readonly string[]>
  /** units that carry general costs — a person working for all of them is General */
  generalUnitIds?: readonly string[]
  /** unit → the names it goes by (its own, its departments'), already normalised */
  unitPhrases?: ReadonlyMap<string, readonly string[]>
  /** salary entry → its split by pay part, worked out from the payroll it paid (see salaryByParts) */
  salaryParts?: ReadonlyMap<string, { weights: ReadonlyMap<string, number>; reason: string }>
  /** employee id → CQID, for reasons and for spotting a CQID in a description */
  cqidOf: ReadonlyMap<string, string>
  /** client → the units it belongs to (its pin, else what it buys) */
  unitsOfClient: ReadonlyMap<string, readonly string[]>
  clientName: ReadonlyMap<string, string>
  /** normalised description → how such entries were allocated before */
  learned: ReadonlyMap<string, { allocation: Allocation; count: number }>
}

/** Categories that are money moving, not a cost of running a unit. */
const NOT_A_COST = /\b(credit given|credit return|loans?|capital|personal withdrawals?|withdrawals?|drawings?|profit share payouts?|transfers?)\b/i

/** Costs every unit shares. */
const SHARED_TOOL = /\b(gpt|chatgpt|openai|claude|anthropic|gemini|midjourney|subscriptions?|domains?|hosting|server|vercel|supabase|aws|google workspace|g ?suite|zoho|canva|adobe|figma|freepik|envato|capcut|notion|slack|internet|wi-?fi|broadband|electricity|rent|office rent|bank (fee|charge)s?|service charges?|mobile|phone|recharge|airtel|jio)\b/i

const MONTHS = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/gi

/** "Salary — CQID004 — October 2026" and "salary cqid004 nov 2026" read the same. */
export function normaliseDescription(d: string | null | undefined): string {
  return (d ?? '')
    .toLowerCase()
    .replace(MONTHS, ' ')
    .replace(/\b(?!cqid)\d[\d/.,-]*\b/g, ' ')   // amounts, dates, EMI counts — not CQIDs
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/** The names a unit goes by, normalised for matching: "Offer Flyers" also matches "offer flyer". */
export function phrasesFor(names: readonly string[]): string[] {
  const out = new Set<string>()
  for (const n of names) {
    const p = normaliseDescription(n.replace(/&/g, ' '))
    if (!p || p.length < 4) continue
    out.add(p)
    out.add(p.replace(/s\b/g, ''))
  }
  return [...out].filter(p => p.length >= 4)
}

const equalSplit = (unitIds: readonly string[]): Allocation =>
  unitIds.length === 1 ? { kind: 'unit', unitId: unitIds[0] } : { kind: 'split', parts: unitIds.map(unitId => ({ unitId, share: 1 })) }

const names = (ctx: SuggestContext, ids: readonly string[]) => ids.map(id => ctx.unitName.get(id) ?? 'a unit').join(' and ')

export function suggestAllocation(e: SuggestEntry, ctx: SuggestContext): Suggestion | null {
  const text = `${e.categoryName ?? ''} ${e.description ?? ''}`

  // 1. Not a business cost at all.
  if (e.categoryName && NOT_A_COST.test(e.categoryName)) {
    return { allocation: { kind: 'exclude' }, reason: `${e.categoryName} is money moving, not a cost of running a unit`, confidence: 'high' }
  }

  // 2. A salary paid through payroll: split by its parts.
  const parts = ctx.salaryParts?.get(e.id)
  if (parts && parts.weights.size) {
    const ids = [...parts.weights.keys()]
    return {
      allocation: ids.length === 1 ? { kind: 'unit', unitId: ids[0] } : { kind: 'split', parts: ids.map(unitId => ({ unitId, share: parts.weights.get(unitId)! })) },
      reason: parts.reason,
      confidence: 'high',
    }
  }

  // 3. A person: the entry's employee, else a CQID written in the description.
  let employeeId = e.employeeId
  if (!employeeId) {
    const m = (e.description ?? '').match(/CQID\s*-?\s*(\d{3})/i)
    if (m) for (const [id, cqid] of ctx.cqidOf) if (cqid.replace(/\D/g, '') === m[1]) { employeeId = id; break }
  }
  if (employeeId) {
    const cqid = ctx.cqidOf.get(employeeId) ?? 'this person'
    const units = ctx.unitsOfEmployee.get(employeeId) ?? []
    if (units.length) {
      return { allocation: equalSplit(units), reason: `${cqid} is on ${names(ctx, units)}`, confidence: 'high' }
    }
    if (e.type === 'outflow') {
      const assigned = ctx.assignedUnitsOfEmployee?.get(employeeId) ?? []
      const everyUnit = (ctx.generalUnitIds?.length ?? 0) > 0 && (ctx.generalUnitIds ?? []).every(u => assigned.includes(u))
      if (assigned.length && !everyUnit) {
        return {
          allocation: equalSplit(assigned),
          reason: `${cqid} is on no team, but works on ${names(ctx, assigned)} (assigned departments)${assigned.length > 1 ? ' — split equally' : ''}`,
          confidence: 'medium',
        }
      }
      return {
        allocation: { kind: 'general' },
        reason: everyUnit ? `${cqid} works across every unit` : `${cqid} works for the whole company (no team, no departments)`,
        confidence: 'medium',
      }
    }
  }

  // 4. A client's cost belongs to that client's unit(s).
  if (e.clientId) {
    const units = ctx.unitsOfClient.get(e.clientId) ?? []
    const client = ctx.clientName.get(e.clientId) ?? 'This client'
    if (units.length) {
      return {
        allocation: equalSplit(units),
        reason: units.length > 1 ? `${client} buys from ${names(ctx, units)} — split equally` : `${client} belongs to ${names(ctx, units)}`,
        confidence: units.length > 1 ? 'medium' : 'high',
      }
    }
  }

  // 5. Allocated the same way before.
  const seen = ctx.learned.get(normaliseDescription(e.description))
  if (seen && normaliseDescription(e.description)) {
    return { allocation: seen.allocation, reason: `Same as ${seen.count} earlier ${seen.count === 1 ? 'entry' : 'entries'} like this`, confidence: seen.count > 1 ? 'high' : 'medium' }
  }

  // 6. The description names a unit (or one of its departments).
  const said = ` ${normaliseDescription(e.description)} `
  if (ctx.unitPhrases && said.trim()) {
    const hits = [...ctx.unitPhrases].filter(([, phrases]) => phrases.some(p => p && said.includes(` ${p} `))).map(([id]) => id)
    if (hits.length) {
      return { allocation: equalSplit(hits), reason: `The description mentions ${names(ctx, hits)}`, confidence: 'medium' }
    }
  }

  // 7. A tool or cost every unit shares.
  if (e.type === 'outflow' && SHARED_TOOL.test(text)) {
    return { allocation: { kind: 'general' }, reason: 'A shared tool or office cost — split equally', confidence: 'medium' }
  }

  return null
}

/** How an allocation reads in one line, for the page. */
export function describeAllocation(a: Allocation, unitName: ReadonlyMap<string, string>): string {
  switch (a.kind) {
    case 'unit': return unitName.get(a.unitId) ?? 'A unit'
    case 'general': return 'General (split equally)'
    case 'exclude': return 'Leave out'
    case 'split': {
      const total = a.parts.reduce((t, p) => t + p.share, 0) || 1
      return a.parts.map(p => `${unitName.get(p.unitId) ?? 'A unit'} ${Math.round((p.share / total) * 1000) / 10}%`).join(' · ')
    }
  }
}

export interface PayrollParts {
  cqid: string
  base: number
  /** bonus + adjustment: paid like base pay */
  extra: number
  ownership: number
  /** contribution earnings by unit; anything not tied to a unit's task goes with base pay */
  commissionByUnit: ReadonlyMap<string, number>
  commissionUnplaced: number
}

/**
 * How one payroll's pay divides between units, by part:
 *   base + bonus + adjustment → the person's home units (equally)
 *   contribution earnings     → the units their tasks were in
 *   ownership                 → equally between the units that carry general costs
 * Returns weights in rupees (only their proportions are used) and a reason.
 */
export function salaryByParts(
  p: PayrollParts, homeUnits: readonly string[], generalUnits: readonly string[], unitName: ReadonlyMap<string, string>,
): { weights: Map<string, number>; reason: string } {
  const w = new Map<string, number>()
  const add = (u: string, v: number) => { if (v > 0) w.set(u, Math.round(((w.get(u) ?? 0) + v) * 100) / 100) }
  const spread = (units: readonly string[], v: number) => { if (units.length) for (const u of units) add(u, v / units.length) }
  const home = homeUnits.length ? homeUnits : generalUnits
  spread(home, p.base + p.extra + p.commissionUnplaced)
  for (const [u, v] of p.commissionByUnit) add(u, v)
  spread(generalUnits.length ? generalUnits : home, p.ownership)

  const nm = (ids: readonly string[]) => ids.map(id => unitName.get(id) ?? 'a unit').join(' & ')
  const bits: string[] = []
  const baseTotal = p.base + p.extra + p.commissionUnplaced
  if (Math.round(baseTotal) > 0) bits.push(`base ₹${Math.round(baseTotal)} → ${home.length ? nm(home) : 'equally'}`)
  const comm = [...p.commissionByUnit].filter(([, v]) => v > 0)
  if (comm.length) bits.push(`contribution ${comm.map(([u, v]) => `₹${Math.round(v)} ${unitName.get(u) ?? 'a unit'}`).join(', ')}`)
  if (p.ownership > 0) bits.push(`ownership ₹${Math.round(p.ownership)} → equally`)
  return { weights: w, reason: `${p.cqid}'s pay by parts: ${bits.join('; ') || 'nothing to split'}` }
}

/**
 * Turn any ratio (revenue, amounts, 1:1:1) into percentages with two decimals
 * that add up to exactly 100 (largest remainder). All-zero weights split equally.
 */
export function percentsByWeight(weights: readonly number[]): number[] {
  if (!weights.length) return []
  const w = weights.some(x => x > 0) ? weights.map(x => Math.max(0, x)) : weights.map(() => 1)
  const total = w.reduce((t, x) => t + x, 0)
  const raw = w.map(x => (x / total) * 10000)
  const cents = raw.map(Math.floor)
  let left = 10000 - cents.reduce((t, v) => t + v, 0)
  const order = raw.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0])
  for (let k = 0; left > 0 && k < order.length; k++, left--) cents[order[k][1]]++
  return cents.map(c => c / 100)
}

/** Is a custom split valid? Percentages must total 100; amounts must total the entry. */
export function validateSplit(
  parts: { unitId: string; value: number }[], basis: 'percent' | 'amount', entryAmount: number,
): string | null {
  if (parts.length < 2) return 'A split needs at least two units.'
  if (new Set(parts.map(p => p.unitId)).size !== parts.length) return 'A unit is listed twice.'
  if (parts.some(p => !(p.value > 0))) return 'Every part must be more than 0.'
  const total = Math.round(parts.reduce((t, p) => t + p.value, 0) * 100) / 100
  if (basis === 'percent' && Math.abs(total - 100) > 0.01) return `The parts add up to ${total}%. They must add up to 100%.`
  const want = Math.round(Math.abs(entryAmount) * 100) / 100
  if (basis === 'amount' && Math.abs(total - want) > 0.01) return `The parts add up to ₹${total}. They must add up to the entry's ₹${want}.`
  return null
}

/**
 * Contribution suggestions — who probably did what on a task, as a pre-fill.
 *
 * Work in Cirqle leaves a trail before anyone opens the Contributions page:
 * someone planned the item (a staff-created request, a Social Calendar plan),
 * someone was assigned it, and that person moved its card to Done on My Work.
 * This turns that trail into the same shape the contribution panel edits —
 * `contributions[paramId][employeeId] = value` plus the active group / sub-param
 * keys — so one click fills the form and a person reviews and saves it.
 *
 * NEVER SAVES ANYTHING. Contributions decide pay: each active GROUP takes its
 * weight's share of the commission pool, so crediting a planner under Planning
 * & Content halves what the designer gets on a two-group task. That is a
 * decision for a person, which is why `split` (computed by the real engine)
 * travels with every suggestion — the card shows the money consequence before
 * anyone applies it.
 *
 * ROLE → GROUP is matched by group NAME, in priority order, because groups are
 * configured per company and carry no machine-readable role. A role whose
 * group the task's service doesn't have produces a `note`, not a guess.
 */

import { calculateCommission } from '@/lib/calculations/commission'

export type SuggestRole = 'design' | 'plan'

/** One piece of evidence: this employee did this role, and here is how we know. */
export interface ContributionEvidence {
  employeeId: string
  role: SuggestRole
  /** Plain sentence shown to the user, without the person's name — e.g. "moved REQ-0123 to Done on My Work · 3 Oct". */
  reason: string
  /** Higher wins when several people have evidence for the same role. */
  strength: number
}

export interface SuggestParam {
  id: string
  name: string
  group_id: string | null
  weight: number | null
  is_master?: boolean | null
  input_type?: string | null
}

export interface SuggestGroup {
  id: string
  name: string
  weight: number
}

export interface SuggestionLine {
  employeeId: string
  role: SuggestRole
  reason: string
  groupId: string
  groupName: string
  paramId: string
  paramName: string
  /** 'percentage' shows as "100%", anything else as a count. */
  inputType: string
  /** null = the step applies but needs a number only a person knows (e.g. how many products). */
  value: number | null
}

export interface ContributionSuggestion {
  lines: SuggestionLine[]
  /** Roles we had evidence for but could not place on this task's service. */
  notes: { employeeId: string; role: SuggestRole; reason: string; why: string }[]
  /** Exactly the panel's state shape. Lines with value null activate the group but set no value. */
  contributions: Record<string, Record<string, number>>
  activeGroups: string[]      // `${employeeId}:${groupId}`
  activeSubParams: string[]   // `${employeeId}:${paramId}`
  /** Each person's share of the pool if applied as-is (0–100), from the commission engine. */
  split: { employeeId: string; pct: number }[]
}

/** Primary group per role, in priority order. Social Media is the design fallback only. */
const DESIGN_GROUPS = [/creative\s*&\s*design/i, /flyer\s+design/i, /video\s+production/i, /social\s+media/i]
/** Groups the designer usually also fills, but with a count only they know. */
const DESIGN_ALSO = [/flyer\s+products/i]
const PLAN_GROUPS = [/planning/i, /social\s+media/i]
/** Inside a planning group, the step that IS planning — not writing the content. */
const PLAN_PARAMS = [/content\s+planning/i, /planning/i]

/** Highest-strength evidence per role. Ties keep the first seen (callers order by recency). */
export function pickEvidence(evidence: ContributionEvidence[]): Partial<Record<SuggestRole, ContributionEvidence>> {
  const out: Partial<Record<SuggestRole, ContributionEvidence>> = {}
  for (const e of evidence) {
    const cur = out[e.role]
    if (!cur || e.strength > cur.strength) out[e.role] = e
  }
  return out
}

function firstMatch<T extends { name: string }>(items: T[], patterns: RegExp[]): T | undefined {
  for (const re of patterns) {
    const hit = items.find(i => re.test(i.name))
    if (hit) return hit
  }
  return undefined
}

function masterOf(params: SuggestParam[]): SuggestParam | undefined {
  return params.find(p => p.is_master) ?? params.find(p => (p.weight ?? 0) === 1) ?? params[0]
}

/** 100 for a share-of-work percentage, 1 for a single planning step, null when only a person knows the count. */
function defaultValue(param: SuggestParam, role: SuggestRole): number | null {
  if (param.input_type === 'percentage') return 100
  return role === 'plan' ? 1 : null
}

export function buildSuggestion(
  taskGroups: SuggestGroup[],
  taskParams: SuggestParam[],
  evidence: ContributionEvidence[],
): ContributionSuggestion | null {
  const picked = pickEvidence(evidence)
  if (!picked.design && !picked.plan) return null

  const paramsOf = (g: SuggestGroup) => taskParams.filter(p => p.group_id === g.id)
  const lines: SuggestionLine[] = []
  const notes: ContributionSuggestion['notes'] = []
  const push = (ev: ContributionEvidence, g: SuggestGroup, p: SuggestParam, value: number | null) =>
    lines.push({ employeeId: ev.employeeId, role: ev.role, reason: ev.reason, groupId: g.id, groupName: g.name, paramId: p.id, paramName: p.name, inputType: p.input_type ?? 'count', value })

  if (picked.design) {
    const ev = picked.design
    const g = firstMatch(taskGroups.filter(g => paramsOf(g).length), DESIGN_GROUPS)
    const m = g && masterOf(paramsOf(g))
    if (g && m) push(ev, g, m, defaultValue(m, 'design'))
    else notes.push({ employeeId: ev.employeeId, role: 'design', reason: ev.reason, why: 'this service has no design step' })
    for (const re of DESIGN_ALSO) {
      const extra = taskGroups.find(x => re.test(x.name) && x.id !== g?.id && paramsOf(x).length)
      const em = extra && masterOf(paramsOf(extra))
      if (extra && em) push(ev, extra, em, defaultValue(em, 'design'))
    }
  }

  if (picked.plan) {
    const ev = picked.plan
    const g = firstMatch(taskGroups.filter(g => paramsOf(g).length), PLAN_GROUPS)
    const p = g && (firstMatch(paramsOf(g), PLAN_PARAMS) ?? masterOf(paramsOf(g)))
    if (g && p) push(ev, g, p, defaultValue(p, 'plan'))
    else notes.push({ employeeId: ev.employeeId, role: 'plan', reason: ev.reason, why: 'this service has no planning step' })
  }

  if (!lines.length) return { lines, notes, contributions: {}, activeGroups: [], activeSubParams: [], split: [] }

  const contributions: Record<string, Record<string, number>> = {}
  const activeGroups = new Set<string>()
  const activeSubParams = new Set<string>()
  for (const l of lines) {
    activeGroups.add(`${l.employeeId}:${l.groupId}`)
    const master = masterOf(taskParams.filter(p => p.group_id === l.groupId))
    if (master?.id !== l.paramId) activeSubParams.add(`${l.employeeId}:${l.paramId}`)
    if (l.value != null && l.value > 0) {
      ;(contributions[l.paramId] ||= {})[l.employeeId] = l.value
    }
  }

  return {
    lines, notes, contributions,
    activeGroups: [...activeGroups],
    activeSubParams: [...activeSubParams],
    split: splitOf(taskGroups, taskParams, contributions),
  }
}

/**
 * Each person's share of the pool, from the REAL engine — so the card can
 * never promise a split the panel won't show. Billing and commission are set
 * to 100 because only the proportions matter; performance rating does not
 * enter scorePercentage.
 */
function splitOf(
  groups: SuggestGroup[], params: SuggestParam[], contributions: Record<string, Record<string, number>>,
): { employeeId: string; pct: number }[] {
  const rows = Object.entries(contributions).flatMap(([parameter_id, byEmp]) =>
    Object.entries(byEmp).map(([employee_id, value]) => ({ parameter_id, employee_id, value })))
  if (!rows.length) return []
  const empIds = [...new Set(rows.map(r => r.employee_id))]
  const result = calculateCommission({
    taskId: 'suggestion', billingAmountINR: 100, serviceCommissionPct: 100,
    employees: empIds.map(id => ({ id, name: id, performance_rating: 100 })) as never,
    groups: groups.map(g => ({ id: g.id, name: g.name, weight: g.weight })) as never,
    parameters: params.map(p => ({ id: p.id, group_id: p.group_id, name: p.name, weight: p.weight ?? 0, is_master: !!p.is_master })) as never,
    toolsUsed: [],
    contributions: rows as never,
  })
  return result.employeeEarnings
    .map(e => ({ employeeId: e.employeeId, pct: Math.round(e.scorePercentage * 10) / 10 }))
    .sort((a, b) => b.pct - a.pct)
}

/**
 * Ownership rewards, apportioned to the tasks that earned them (pure).
 *
 * Ownership is paid per person per period — "2% of September billing",
 * "3% of the clients they handle" — never per task. To read margin per task,
 * client or department, each award is spread back over the work it was
 * measured on:
 *
 *   billing / collected / profit → the tasks inside the program's scope in the
 *       award period, weighted by billing. Exact for billing (the award IS a
 *       share of those tasks' billing); for collected and profit it is the
 *       closest task-level reading, since cash and company profit carry no task.
 *   clients_handled → each client on the award, by that client's billing (a %
 *       rule) or equally (₹ per client), then over the client's tasks by billing.
 *   planned → the planned tasks themselves.
 *   entries / activities / fixed → no task behind them. Reported as
 *       UNALLOCATED overhead, never smeared across tasks.
 *
 * Every split uses largest-remainder rounding to the paisa, so Σ allocated +
 * Σ unallocated equals Σ awards exactly.
 *
 * The contribution engine is not touched — this only reads stored awards.
 */
import { round2 as r2 } from '@/lib/calculations/currency'
import { matchesScope, type ResolvedScope } from '@/lib/org/units'

export interface AllocTask {
  id: string
  taskNumber: number | null
  date: string                 // YYYY-MM-DD
  clientId: string | null
  serviceId: string | null
  categoryId: string | null
  billingInr: number
}

export interface AllocAward {
  /** Who the award pays. */
  employeeId?: string
  programName: string
  basis: string
  scopeKind: string
  scopeId: string | null
  periodStart: string
  periodEnd: string
  /** Set for a percentage rule; null for a ₹ rule. */
  percent: number | null
  earnedInr: number
  /** Per-person bases: what was counted. refId is a client id (clients_handled)
   *  or task id (planned); older awards have only the label. */
  items?: { label: string; refId?: string; amountInr?: number }[]
}

export interface UnallocatedLine {
  employeeId?: string
  programName: string
  basis: string
  amountInr: number
  reason: string
}

export interface OwnershipAllocation {
  /** task id → ownership attributed to it. */
  byTask: Map<string, number>
  /** task id → employee id → that employee's ownership on the task. */
  byTaskEmployee: Map<string, Map<string, number>>
  /** Awards (or parts) with no task behind them. */
  unallocated: UnallocatedLine[]
}

const TASK_FREE_REASON: Record<string, string> = {
  entries: 'Cash-book entries are not tasks',
  activities: 'Recorded activities are not tasks',
  fixed: 'A fixed amount is not tied to any work',
}

/** Split `total` over weights to the paisa; Σ result === total exactly (when there is at least one weight). */
export function splitByWeight(total: number, weights: number[]): number[] {
  const paise = Math.round(total * 100)
  if (!weights.length || paise === 0) return weights.map(() => 0)
  // All-zero weights split equally — the amount must land somewhere.
  const w = weights.some(x => x > 0) ? weights.map(x => Math.max(0, x)) : weights.map(() => 1)
  const sum = w.reduce((t, x) => t + x, 0)
  const raw = w.map(x => (x / sum) * paise)
  const out = raw.map(Math.floor)
  let left = paise - out.reduce((t, v) => t + v, 0)
  const order = raw.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0])
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k][1]]++
  return out.map(p => p / 100)
}

export function allocateOwnership(
  awards: AllocAward[],
  tasks: AllocTask[],
  ctx: {
    /** Lower-cased client name → id, for awards stored before items carried ids. */
    clientIdByName: Map<string, string>
    /** org unit id → resolved scope, for unit-scoped programs. */
    unitScopes: Map<string, ResolvedScope>
  },
): OwnershipAllocation {
  const byTask = new Map<string, number>()
  const byTaskEmployee = new Map<string, Map<string, number>>()
  const unallocated: UnallocatedLine[] = []
  let current: AllocAward | null = null
  const add = (id: string, amt: number) => {
    if (!amt) return
    byTask.set(id, r2((byTask.get(id) ?? 0) + amt))
    const who = current?.employeeId
    if (!who) return
    const m = byTaskEmployee.get(id) ?? new Map<string, number>()
    m.set(who, r2((m.get(who) ?? 0) + amt))
    byTaskEmployee.set(id, m)
  }
  const miss = (a: AllocAward, amountInr: number, reason: string) => {
    if (amountInr) unallocated.push({ employeeId: a.employeeId, programName: a.programName, basis: a.basis, amountInr: r2(amountInr), reason })
  }
  /** Spread over tasks by billing; equally when none of them bill. */
  const spread = (a: AllocAward, amount: number, pool: AllocTask[], reason: string) => {
    if (!amount) return
    if (!pool.length) { miss(a, amount, reason); return }
    const billed = pool.some(t => t.billingInr > 0)
    const parts = splitByWeight(amount, pool.map(t => (billed ? t.billingInr : 1)))
    pool.forEach((t, i) => add(t.id, parts[i]))
  }

  for (const a of awards) {
    current = a
    const earned = r2(a.earnedInr || 0)
    if (!earned) continue
    const inPeriod = tasks.filter(t => t.date >= a.periodStart && t.date <= a.periodEnd)

    if (TASK_FREE_REASON[a.basis]) { miss(a, earned, TASK_FREE_REASON[a.basis]); continue }

    if (a.basis === 'clients_handled') {
      const items = (a.items ?? [])
        .map(it => ({ it, clientId: it.refId ?? ctx.clientIdByName.get(it.label.trim().toLowerCase()) ?? null }))
      if (!items.length) { miss(a, earned, 'No clients recorded on the award'); continue }
      const shares = splitByWeight(earned, items.map(x => (a.percent != null ? x.it.amountInr ?? 0 : 1)))
      items.forEach((x, i) => {
        if (!x.clientId) { miss(a, shares[i], `Client “${x.it.label}” not found`); return }
        spread(a, shares[i], inPeriod.filter(t => t.clientId === x.clientId), `No ${x.it.label} tasks in the period`)
      })
      continue
    }

    if (a.basis === 'planned') {
      const byNumber = new Map(inPeriod.filter(t => t.taskNumber != null).map(t => [t.taskNumber!, t]))
      const items = (a.items ?? []).map(it => {
        if (it.refId) return { it, task: inPeriod.find(t => t.id === it.refId) ?? null }
        const n = /^#(\d+)/.exec(it.label)?.[1]
        return { it, task: n ? byNumber.get(Number(n)) ?? null : null }
      })
      if (!items.length) { miss(a, earned, 'No planned tasks recorded on the award'); continue }
      const shares = splitByWeight(earned, items.map(x => (a.percent != null ? x.it.amountInr ?? 0 : 1)))
      items.forEach((x, i) => {
        if (x.task) add(x.task.id, shares[i])
        else miss(a, shares[i], `Planned task “${x.it.label}” not found`)
      })
      continue
    }

    // billing / collected / profit — the program's scope over the period.
    const unit = a.scopeKind === 'org_unit' && a.scopeId ? ctx.unitScopes.get(a.scopeId) ?? null : null
    const pool = inPeriod.filter(t => {
      switch (a.scopeKind) {
        case 'company': return true
        case 'client': return t.clientId === a.scopeId
        case 'service': return t.serviceId === a.scopeId
        case 'service_category': return t.categoryId === a.scopeId
        case 'org_unit': return unit ? matchesScope(unit, { clientId: t.clientId, serviceId: t.serviceId, serviceCategoryId: t.categoryId }) : false
        default: return false
      }
    })
    spread(a, earned, pool, 'No tasks in the program’s scope for the period')
  }

  return { byTask, byTaskEmployee, unallocated }
}

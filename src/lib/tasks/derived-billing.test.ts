import { describe, it, expect } from 'vitest'
import {
  parseBillingRule, emptyBillingRule, monthRange, isBasisTask, sumBasis,
  computeRule, isDerivedTask, isFrozenByStatus, isRuleDormant, findDuplicateRules,
  BILLING_RULE_VERSION,
  type BillingRule, type BasisTaskLike,
} from './derived-billing'
import { effectiveBillingAmount } from './pricing'

const POSTER = 'svc-poster'
const REEL = 'svc-reel'
const OTHER = 'svc-other'
const CLIENT = 'client-a'

function rule(over: Partial<BillingRule> = {}): BillingRule {
  return { ...emptyBillingRule(), percent: 30, sources: { serviceIds: [POSTER] }, ...over }
}

function task(over: Partial<BasisTaskLike> = {}): BasisTaskLike {
  return {
    id: 't1', client_id: CLIENT, service_id: POSTER, task_date: '2026-08-10',
    status: 'done', deleted_at: null, billing_mode: 'fixed',
    billing_amount: 100, billing_amount_inr: 100, currency: 'INR',
    ...over,
  }
}

const ctx = (over: Partial<{ id: string; clientId: string; taskDate: string; rule: BillingRule }> = {}) => ({
  id: 'derived-1', clientId: CLIENT, taskDate: '2026-08-31', rule: rule(), ...over,
})

// ─── parseBillingRule ────────────────────────────────────────────────────────

describe('parseBillingRule', () => {
  it('accepts a well-formed rule and normalises defaults', () => {
    const res = parseBillingRule({ v: 1, method: 'percent', percent: 30, sources: { serviceIds: [POSTER] } })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.rule.percent).toBe(30)
    expect(res.rule.filters?.statusNotIn).toEqual(['cancelled'])
    expect(res.rule.override).toBeNull()
  })

  it('refuses a rule from a NEWER app version rather than half-understanding it', () => {
    const res = parseBillingRule({ v: BILLING_RULE_VERSION + 1, method: 'percent', percent: 30, sources: { serviceIds: [POSTER] } })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toMatch(/newer version/i)
  })

  it('refuses an unknown billing method', () => {
    const res = parseBillingRule({ v: 1, method: 'tiered', percent: 30, sources: { serviceIds: [POSTER] } })
    expect(res.ok).toBe(false)
  })

  it.each([
    ['no sources', { v: 1, method: 'percent', percent: 30, sources: { serviceIds: [] } }],
    ['zero percent', { v: 1, method: 'percent', percent: 0, sources: { serviceIds: [POSTER] } }],
    ['over 100 percent', { v: 1, method: 'percent', percent: 101, sources: { serviceIds: [POSTER] } }],
    ['missing rule', null],
    ['not an object', 'nope'],
  ])('rejects %s', (_label, input) => {
    expect(parseBillingRule(input).ok).toBe(false)
  })

  it('rejects a min above the max', () => {
    const res = parseBillingRule({
      v: 1, method: 'percent', percent: 30, sources: { serviceIds: [POSTER] },
      clamps: { minInr: 500, maxInr: 100 },
    })
    expect(res.ok).toBe(false)
  })

  it('keeps a valid override', () => {
    const res = parseBillingRule({
      v: 1, method: 'percent', percent: 30, sources: { serviceIds: [POSTER] },
      override: { amount: 200, note: 'agreed with client' },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.rule.override?.amount).toBe(200)
  })
})

// ─── monthRange ──────────────────────────────────────────────────────────────

describe('monthRange', () => {
  it('spans the calendar month, end-exclusive', () => {
    expect(monthRange('2026-08-14')).toEqual({ start: '2026-08-01', endExclusive: '2026-09-01' })
  })
  it('rolls the year at December', () => {
    expect(monthRange('2026-12-31')).toEqual({ start: '2026-12-01', endExclusive: '2027-01-01' })
  })
  it('handles February without special-casing leap years', () => {
    expect(monthRange('2028-02-29')).toEqual({ start: '2028-02-01', endExclusive: '2028-03-01' })
  })
})

// ─── isBasisTask ─────────────────────────────────────────────────────────────

describe('isBasisTask', () => {
  it('accepts a matching task', () => {
    expect(isBasisTask(task(), ctx())).toBe(true)
  })

  it('NEVER counts another derived task — the anti-cycle invariant', () => {
    expect(isBasisTask(task({ billing_mode: 'percent_of_services' }), ctx())).toBe(false)
  })

  it('counts frozen single-parent variants (they bill real money)', () => {
    expect(isBasisTask(task({ billing_mode: 'percent_of_parent' }), ctx())).toBe(true)
  })

  it.each([
    ['a different client', { client_id: 'client-b' }],
    ['a non-source service', { service_id: OTHER }],
    ['the previous month', { task_date: '2026-07-31' }],
    ['the next month', { task_date: '2026-09-01' }],
    ['a soft-deleted task', { deleted_at: '2026-08-20T00:00:00Z' }],
    ['a cancelled task', { status: 'cancelled' }],
    ['a task with no date', { task_date: null }],
  ])('excludes %s', (_label, over) => {
    expect(isBasisTask(task(over), ctx())).toBe(false)
  })

  it('never counts itself', () => {
    expect(isBasisTask(task({ id: 'derived-1' }), ctx({ id: 'derived-1' }))).toBe(false)
  })

  it('accepts any listed source service', () => {
    const c = ctx({ rule: rule({ sources: { serviceIds: [POSTER, REEL] } }) })
    expect(isBasisTask(task({ service_id: REEL }), c)).toBe(true)
    expect(isBasisTask(task({ service_id: OTHER }), c)).toBe(false)
  })

  it('honours a statusIn allow-list', () => {
    const c = ctx({ rule: rule({ filters: { statusIn: ['done', 'invoiced'] } }) })
    expect(isBasisTask(task({ status: 'done' }), c)).toBe(true)
    expect(isBasisTask(task({ status: 'pending' }), c)).toBe(false)
  })

  it('honours a custom statusNotIn list', () => {
    const c = ctx({ rule: rule({ filters: { statusNotIn: ['cancelled', 'pending'] } }) })
    expect(isBasisTask(task({ status: 'pending' }), c)).toBe(false)
    expect(isBasisTask(task({ status: 'done' }), c)).toBe(true)
  })
})

// ─── sumBasis ────────────────────────────────────────────────────────────────

describe('sumBasis', () => {
  it('sums INR and native when the currency is uniform', () => {
    const s = sumBasis([
      task({ id: 'a', billing_amount: 20, billing_amount_inr: 518, currency: 'AED' }),
      task({ id: 'b', billing_amount: 30, billing_amount_inr: 777, currency: 'AED' }),
    ])
    expect(s.inr).toBe(1295)
    expect(s.native).toBe(50)
    expect(s.uniformCurrency).toBe('AED')
    expect(s.count).toBe(2)
    expect(s.taskIds).toEqual(['a', 'b'])
  })

  it('drops the native sum on mixed currencies rather than inventing a rate', () => {
    const s = sumBasis([
      task({ id: 'a', billing_amount: 20, billing_amount_inr: 518, currency: 'AED' }),
      task({ id: 'b', billing_amount: 100, billing_amount_inr: 100, currency: 'INR' }),
    ])
    expect(s.native).toBeNull()
    expect(s.uniformCurrency).toBeNull()
    expect(s.inr).toBe(618)
  })

  it('lets a zero-amount task of another currency pass without spoiling uniformity', () => {
    const s = sumBasis([
      task({ id: 'a', billing_amount: 20, billing_amount_inr: 518, currency: 'AED' }),
      task({ id: 'b', billing_amount: 0, billing_amount_inr: 0, currency: 'INR' }),
    ])
    expect(s.uniformCurrency).toBe('AED')
    expect(s.native).toBe(20)
  })

  it('returns zeroes for an empty basis', () => {
    expect(sumBasis([])).toMatchObject({ inr: 0, count: 0 })
  })
})

// ─── computeRule ─────────────────────────────────────────────────────────────

describe('computeRule', () => {
  it('takes the percentage, keeping the sources’ currency', () => {
    const basis = sumBasis([
      task({ id: 'a', billing_amount: 500, billing_amount_inr: 12950, currency: 'AED' }),
      task({ id: 'b', billing_amount: 350, billing_amount_inr: 9065, currency: 'AED' }),
    ])
    const out = computeRule(rule({ percent: 30 }), basis)
    expect(out.billingAmount).toBe(255)      // 30% of AED 850
    expect(out.currency).toBe('AED')
    expect(out.billingAmountInr).toBe(6604.5)
  })

  it('falls back to INR on mixed-currency sources', () => {
    const basis = sumBasis([
      task({ id: 'a', billing_amount: 100, billing_amount_inr: 100, currency: 'INR' }),
      task({ id: 'b', billing_amount: 20, billing_amount_inr: 518, currency: 'AED' }),
    ])
    const out = computeRule(rule({ percent: 50 }), basis)
    expect(out.currency).toBe('INR')
    expect(out.billingAmountInr).toBe(309)
    expect(out.billingAmount).toBe(309)
  })

  it('bills zero for an empty month rather than skipping', () => {
    const out = computeRule(rule(), sumBasis([]))
    expect(out.billingAmountInr).toBe(0)
    expect(out.billingAmount).toBe(0)
  })

  it('lifts a small amount to the minimum charge', () => {
    const basis = sumBasis([task({ billing_amount: 100, billing_amount_inr: 100 })])
    const out = computeRule(rule({ percent: 10, clamps: { minInr: 500, maxInr: null } }), basis)
    expect(out.billingAmountInr).toBe(500)
  })

  it('caps a large amount at the maximum charge', () => {
    const basis = sumBasis([task({ billing_amount: 10000, billing_amount_inr: 10000 })])
    const out = computeRule(rule({ percent: 50, clamps: { minInr: null, maxInr: 1000 } }), basis)
    expect(out.billingAmountInr).toBe(1000)
  })

  it('keeps native proportional to a clamped INR amount', () => {
    const basis = sumBasis([task({ billing_amount: 1000, billing_amount_inr: 25000, currency: 'AED' })])
    const out = computeRule(rule({ percent: 50, clamps: { minInr: null, maxInr: 2500 } }), basis)
    expect(out.billingAmountInr).toBe(2500)          // capped from 12500
    expect(out.billingAmount).toBe(100)              // AED 500 → 100, same ratio
    expect(out.currency).toBe('AED')
  })

  it('ignores the override — freezing is the caller’s job, not different maths', () => {
    const basis = sumBasis([task({ billing_amount: 1000, billing_amount_inr: 1000 })])
    const out = computeRule(rule({ percent: 30, override: { amount: 1 } }), basis)
    expect(out.billingAmountInr).toBe(300)
  })
})

// ─── State helpers ───────────────────────────────────────────────────────────

describe('state helpers', () => {
  it('identifies derived tasks', () => {
    expect(isDerivedTask({ billing_mode: 'percent_of_services' })).toBe(true)
    expect(isDerivedTask({ billing_mode: 'fixed' })).toBe(false)
    expect(isDerivedTask(null)).toBe(false)
  })

  it('freezes once the client has been billed', () => {
    expect(isFrozenByStatus('invoiced')).toBe(true)
    expect(isFrozenByStatus('paid')).toBe(true)
    expect(isFrozenByStatus('done')).toBe(false)
  })

  it('treats paused and archived rules as dormant', () => {
    expect(isRuleDormant(rule({ paused: true }))).toBe(true)
    expect(isRuleDormant(rule({ archivedAt: '2026-08-01T00:00:00Z' }))).toBe(true)
    expect(isRuleDormant(rule())).toBe(false)
  })
})

// ─── Coverage composition ────────────────────────────────────────────────────

describe('retainer coverage', () => {
  it('bills zero when the derived task is itself retainer-covered', () => {
    const basis = sumBasis([task({ billing_amount: 1000, billing_amount_inr: 1000 })])
    const { billingAmount } = computeRule(rule({ percent: 30 }), basis)
    expect(effectiveBillingAmount(billingAmount, { covered: true, billAsExtra: false })).toBe(0)
    expect(effectiveBillingAmount(billingAmount, { covered: true, billAsExtra: true })).toBe(300)
  })

  it('contributes nothing from covered SOURCE tasks — the retainer already paid for them', () => {
    const basis = sumBasis([
      task({ id: 'covered', billing_amount: 0, billing_amount_inr: 0 }),
      task({ id: 'extra', billing_amount: 200, billing_amount_inr: 200 }),
    ])
    expect(computeRule(rule({ percent: 50 }), basis).billingAmountInr).toBe(100)
  })
})

// ─── findDuplicateRules ──────────────────────────────────────────────────────

describe('findDuplicateRules', () => {
  const derived = (id: string, serviceIds: string[], over: Partial<BasisTaskLike> = {}) => ({
    ...task({ id, billing_mode: 'percent_of_services', task_date: '2026-08-05', ...over }),
    title: `Rule ${id}`,
    billing_rule: { v: 1, method: 'percent', percent: 20, sources: { serviceIds } },
  })

  it('flags another rule reading the same service that month', () => {
    const hits = findDuplicateRules([derived('d1', [POSTER])], {
      id: 'new', clientId: CLIENT, taskDate: '2026-08-31', serviceIds: [POSTER],
    })
    expect(hits.map(h => h.id)).toEqual(['d1'])
  })

  it('ignores disjoint sources, other months, other clients and itself', () => {
    const tasks = [
      derived('disjoint', [OTHER]),
      derived('lastMonth', [POSTER], { task_date: '2026-07-05' }),
      derived('otherClient', [POSTER], { client_id: 'client-b' }),
      derived('self', [POSTER]),
    ]
    const hits = findDuplicateRules(tasks, {
      id: 'self', clientId: CLIENT, taskDate: '2026-08-31', serviceIds: [POSTER],
    })
    expect(hits).toEqual([])
  })

  it('ignores ordinary (non-derived) tasks on the same service', () => {
    expect(findDuplicateRules([task({ id: 'plain' })], {
      clientId: CLIENT, taskDate: '2026-08-31', serviceIds: [POSTER],
    })).toEqual([])
  })
})

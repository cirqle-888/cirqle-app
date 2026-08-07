import { describe, it, expect } from 'vitest'
import {
  isCoveredWorkTask, taskPoolBasisInr, missingWorkValue, resolveCommissionPct,
} from './work-value'

const covered = { retainer_item_id: 'item-1', bill_as_extra: false, billing_amount_inr: 0, work_value_inr: 620 }
const coveredNoValue = { retainer_item_id: 'item-1', bill_as_extra: false, billing_amount_inr: 0, work_value_inr: null }
const extra = { retainer_item_id: 'item-1', bill_as_extra: true, billing_amount_inr: 940, work_value_inr: null }
const normal = { retainer_item_id: null, bill_as_extra: false, billing_amount_inr: 1200, work_value_inr: null }

describe('isCoveredWorkTask', () => {
  it('is true only for covered non-extra tasks', () => {
    expect(isCoveredWorkTask(covered)).toBe(true)
    expect(isCoveredWorkTask(extra)).toBe(false)
    expect(isCoveredWorkTask(normal)).toBe(false)
  })
})

describe('taskPoolBasisInr', () => {
  it('uses the stamped work value for covered tasks', () => {
    expect(taskPoolBasisInr(covered)).toBe(620)
  })
  it('is 0 (no matrix fallback) when a covered task has no work value', () => {
    expect(taskPoolBasisInr(coveredNoValue)).toBe(0)
  })
  it('uses billing for extra work and normal tasks', () => {
    expect(taskPoolBasisInr(extra)).toBe(940)
    expect(taskPoolBasisInr(normal)).toBe(1200)
  })
  it('tolerates absent fields', () => {
    expect(taskPoolBasisInr({})).toBe(0)
  })
})

describe('missingWorkValue', () => {
  it('flags covered tasks without a work value', () => {
    expect(missingWorkValue(coveredNoValue)).toBe(true)
    expect(missingWorkValue(covered)).toBe(false)
    expect(missingWorkValue(normal)).toBe(false)
  })
})

describe('resolveCommissionPct', () => {
  it('prefers the agreement pct for any retainer-linked task (covered or extra)', () => {
    expect(resolveCommissionPct(covered, 40, 60)).toBe(40)
    expect(resolveCommissionPct(extra, 40, 60)).toBe(40)
  })
  it('falls back to the matrix, then 50', () => {
    expect(resolveCommissionPct(covered, null, 60)).toBe(60)
    expect(resolveCommissionPct(normal, 40, 60)).toBe(60)
    expect(resolveCommissionPct(normal, null, null)).toBe(50)
  })
  it('honours a 0% agreement pct (explicit, not falsy-skipped)', () => {
    expect(resolveCommissionPct(covered, 0, 60)).toBe(0)
  })
})

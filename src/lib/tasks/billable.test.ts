import { describe, it, expect } from 'vitest'
import {
  isBillableTask, isWaivedTask, normalizeNoChargeReason, isNoChargeReason,
  noChargeReasonLabel, isNoChargeColumnMissing, withoutNoChargeReason,
} from './billable'

describe('isBillableTask', () => {
  it('treats an unset flag as billable', () => {
    // Every row written before the flag existed has NULL here. Reading those as
    // waived would empty every invoice in the system.
    expect(isBillableTask({})).toBe(true)
    expect(isBillableTask({ is_billable: null })).toBe(true)
  })

  it('is false only for an explicit false', () => {
    expect(isBillableTask({ is_billable: false })).toBe(false)
    expect(isBillableTask({ is_billable: true })).toBe(true)
  })

  it('is the exact inverse of isWaivedTask for real rows', () => {
    for (const row of [{}, { is_billable: true }, { is_billable: false }]) {
      expect(isWaivedTask(row)).toBe(!isBillableTask(row))
    }
  })
})

describe('normalizeNoChargeReason', () => {
  it('clears the reason on a billable task', () => {
    expect(normalizeNoChargeReason(true, 'goodwill')).toBeNull()
    expect(normalizeNoChargeReason(undefined, 'goodwill')).toBeNull()
  })

  it('keeps a valid reason on a waived task', () => {
    expect(normalizeNoChargeReason(false, 'package')).toBe('package')
    expect(normalizeNoChargeReason(false, 'rework')).toBe('rework')
  })

  it('falls back to goodwill when the reason is missing or junk', () => {
    expect(normalizeNoChargeReason(false, null)).toBe('goodwill')
    expect(normalizeNoChargeReason(false, 'because-i-said-so')).toBe('goodwill')
  })
})

describe('reason codes', () => {
  it('accepts only the four codes the CHECK constraint allows', () => {
    expect(['package', 'goodwill', 'rework', 'internal'].every(isNoChargeReason)).toBe(true)
    expect(isNoChargeReason('freebie')).toBe(false)
    expect(isNoChargeReason(null)).toBe(false)
  })

  it('labels codes for the UI and passes unknown text through', () => {
    expect(noChargeReasonLabel('package')).toBe('Included in package')
    expect(noChargeReasonLabel(null)).toBe('')
  })
})

describe('pre-migration retry', () => {
  it('recognises only a missing-column error for this column', () => {
    expect(isNoChargeColumnMissing({ code: 'PGRST204', message: "Could not find the 'no_charge_reason' column" })).toBe(true)
    expect(isNoChargeColumnMissing({ code: '42703', message: 'column tasks.no_charge_reason does not exist' })).toBe(true)
    // A different missing column must not be swallowed by this retry.
    expect(isNoChargeColumnMissing({ code: '42703', message: 'column tasks.scope does not exist' })).toBe(false)
    // Nor an unrelated failure that happens to mention the column.
    expect(isNoChargeColumnMissing({ code: '23514', message: 'no_charge_reason violates check constraint' })).toBe(false)
    expect(isNoChargeColumnMissing(null)).toBe(false)
  })

  it('strips the column but keeps the rest of the row', () => {
    expect(withoutNoChargeReason({ is_billable: false, no_charge_reason: 'goodwill', title: 'x' }))
      .toEqual({ is_billable: false, title: 'x' })
  })
})

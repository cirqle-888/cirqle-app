import { describe, it, expect } from 'vitest'
import { isActivityKind, isPayableLogPair, parseLogKind, logKind, activityKindLabel } from './activity-kinds'

describe('activity kinds', () => {
  it('built-in kinds, including contributions recorded', () => {
    expect(isActivityKind('contribution_saved')).toBe(true)
    expect(activityKindLabel('contribution_saved')).toBe('Contributions recorded (per task)')
  })

  it('any logged work action is a kind; admin, system and undo actions are not', () => {
    expect(isPayableLogPair('portfolio_item', 'created')).toBe(true)
    expect(isPayableLogPair('task', 'status_changed')).toBe(true)
    expect(isPayableLogPair('auth', 'login')).toBe(false)
    expect(isPayableLogPair('payroll', 'marked_paid')).toBe(false)
    expect(isPayableLogPair('task', 'deleted')).toBe(false)
    expect(isPayableLogPair('client', 'archived')).toBe(false)
    expect(isPayableLogPair('client', 'social_account_synced')).toBe(false)
  })

  it('pairs a built-in kind measures better are not offered twice', () => {
    expect(isPayableLogPair('task', 'created')).toBe(false)
    expect(isPayableLogPair('task', 'contribution_saved')).toBe(false)
    expect(isPayableLogPair('cashbook', 'expense_added')).toBe(false)
  })

  it('log kinds round-trip and read as words', () => {
    const k = logKind('portfolio_item', 'created')
    expect(k).toBe('log:portfolio_item.created')
    expect(parseLogKind(k)).toEqual({ entityType: 'portfolio_item', action: 'created' })
    expect(isActivityKind(k)).toBe(true)
    expect(activityKindLabel(k)).toBe('Portfolio item · created')
    expect(activityKindLabel('log:task.status_changed')).toBe('Task · status changed')
    expect(isActivityKind('log:auth.login')).toBe(false)
    expect(isActivityKind('log:bad kind')).toBe(false)
  })
})

describe('labels', () => {
  it('a bare "note" action reads as note added', () => {
    expect(activityKindLabel('log:task.note')).toBe('Task · note added')
  })
})

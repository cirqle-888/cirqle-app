import { describe, it, expect } from 'vitest'
import { sharesAdAccount, campaignOwnerId } from './ad-spend-invoicing'
import { firstLiveTaskId } from './billing'

describe('sharesAdAccount', () => {
  it('agrees when both sides name the same account', () => {
    expect(sharesAdAccount('acct-1', 'acct-1')).toBe(true)
  })

  it('disagrees across two different accounts', () => {
    expect(sharesAdAccount('acct-1', 'acct-2')).toBe(false)
  })

  it('agrees when either side predates ad accounts', () => {
    // The bug of 2026-10-27: a campaign mapped before ad accounts were
    // recorded carries no account id, so its re-import looked like a brand-new
    // campaign and both copies billed the client.
    expect(sharesAdAccount(null, 'acct-1')).toBe(true)
    expect(sharesAdAccount('acct-1', null)).toBe(true)
    expect(sharesAdAccount(null, null)).toBe(true)
    expect(sharesAdAccount(undefined, 'acct-1')).toBe(true)
  })
})

describe('campaignOwnerId', () => {
  const older = { id: 'older', created_at: '2026-06-29T00:00:00Z' }
  const newer = { id: 'newer', created_at: '2026-10-27T00:00:00Z' }

  it('is the oldest live project', () => {
    expect(campaignOwnerId([older, newer])).toBe('older')
  })

  it('does not depend on the order it is given', () => {
    expect(campaignOwnerId([newer, older])).toBe('older')
  })

  it('prefers the project the registry maps the campaign to', () => {
    expect(campaignOwnerId([older, newer], 'newer')).toBe('newer')
  })

  it('ignores a registry pointer to a project that is gone', () => {
    expect(campaignOwnerId([older, newer], 'deleted')).toBe('older')
  })

  it('is null when nothing is live', () => {
    expect(campaignOwnerId([])).toBeNull()
  })

  it('is the only project when there is just one', () => {
    expect(campaignOwnerId([newer])).toBe('newer')
  })

  it('will not move billing off the project that can actually bill', () => {
    // The 27 Oct re-imports: mapping pointed the registry at a fresh, empty
    // project while the original had been charging the client since June.
    // Handing it the campaign would strand the old task's money and write the
    // same fee again on a new one.
    const billing = { ...older, hasLiveBillingTask: true }
    const empty = { ...newer, hasLiveBillingTask: false }
    expect(campaignOwnerId([billing, empty], 'newer')).toBe('older')
  })

  it('prefers a billable project even when it is the newer one', () => {
    const empty = { ...older, hasLiveBillingTask: false }
    const billing = { ...newer, hasLiveBillingTask: true }
    expect(campaignOwnerId([empty, billing])).toBe('newer')
  })

  it('falls back to registry then age when none can bill', () => {
    const a = { ...older, hasLiveBillingTask: false }
    const b = { ...newer, hasLiveBillingTask: false }
    expect(campaignOwnerId([a, b])).toBe('older')
    expect(campaignOwnerId([a, b], 'newer')).toBe('newer')
  })
})

describe('firstLiveTaskId', () => {
  it('is the earliest linked task when it is live', () => {
    expect(firstLiveTaskId(['t1', 't2'], new Set(['t1', 't2']))).toBe('t1')
  })

  it('skips a deleted task and takes the next live one', () => {
    // The bug of 2026-10-28: the recomputed service charge was written onto a
    // task in the trash, so the campaign silently billed nothing.
    expect(firstLiveTaskId(['t1', 't2'], new Set(['t2']))).toBe('t2')
  })

  it('is null when every linked task is deleted', () => {
    expect(firstLiveTaskId(['t1', 't2'], new Set())).toBeNull()
  })

  it('is null when the campaign has no linked task at all', () => {
    expect(firstLiveTaskId([], new Set(['t1']))).toBeNull()
  })
})

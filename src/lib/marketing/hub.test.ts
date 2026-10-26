import { describe, it, expect } from 'vitest'
import {
  planProgress, monthStartISO, monthLabel, accountHealth, socialProfileUrl, adsManagerUrl,
  hubIssues, initials, avatarHue, hasMarketing, matchesClient, type HubIssueInput,
} from './hub'

const NOW = '2026-10-26T06:00:00.000Z'

describe('planProgress', () => {
  it('counts each item in the state the Social Calendar shows, excluding cancelled from the total', () => {
    const p = planProgress([
      { status: 'planned' },
      { status: 'planned', request: { status: 'submitted' } },
      { status: 'planned', request: { status: 'approved', promoted_task: { status: 'in_progress' } } },
      { status: 'planned', task: { status: 'done' } },
      { status: 'cancelled' },
    ])
    expect(p.counts).toMatchObject({ planned: 1, requested: 1, in_progress: 1, done: 1, cancelled: 1 })
    expect(p.total).toBe(4)
    expect(p.done).toBe(1)
    expect(p.pct).toBe(25)
  })

  it('reads an empty plan as 0%, not NaN', () => {
    expect(planProgress([]).pct).toBe(0)
  })
})

describe('months', () => {
  it('maps a date to its plan month and names it', () => {
    expect(monthStartISO('2026-10-26')).toBe('2026-10-01')
    expect(monthLabel('2026-10-01')).toBe('October 2026')
  })
})

describe('accountHealth', () => {
  it('is green when connected and synced within two days', () => {
    expect(accountHealth({ id: 'a', platform: 'instagram', name: 'x', status: 'connected', last_synced_at: '2026-10-25T03:00:00Z' }, NOW).state).toBe('green')
  })
  it('is red when the account needs reconnecting', () => {
    const h = accountHealth({ id: 'a', platform: 'instagram', name: 'x', status: 'needs_reauth', last_synced_at: '2026-10-25T03:00:00Z' }, NOW)
    expect(h).toEqual({ state: 'red', reason: 'Needs reconnecting' })
  })
  it('treats a never-synced new account as waiting, not broken', () => {
    expect(accountHealth({ id: 'a', platform: 'facebook_page', name: 'x', status: 'connected', last_synced_at: null }, NOW))
      .toEqual({ state: 'amber', reason: 'Waiting for its first sync' })
  })
})

describe('links', () => {
  it('opens Instagram by username and Facebook by Page id', () => {
    expect(socialProfileUrl('instagram', '178', 'seastar_neerad')).toBe('https://www.instagram.com/seastar_neerad/')
    expect(socialProfileUrl('facebook_page', '1356685224201185', null)).toBe('https://www.facebook.com/1356685224201185')
    expect(socialProfileUrl('instagram', '178', null)).toBeNull()
  })
  it('opens Ads Manager on the account, with or without the act_ prefix', () => {
    expect(adsManagerUrl('act_6373313269423430')).toContain('act=6373313269423430')
    expect(adsManagerUrl('6373313269423430')).toContain('act=6373313269423430')
  })
})

describe('hubIssues', () => {
  const base: HubIssueInput = {
    clientId: 'c1', clientName: 'Sea Star', accounts: [],
    currentPlan: { id: 'p1', progress: planProgress([{ status: 'planned' }]) },
    expectsPlan: true,
    overduePlanItems: 0, failedPosts: 0, staleNewLeads: 0,
    canSeeSocial: true, canSeeLeads: true, today: '2026-10-26', nowIso: NOW,
  }

  it('is empty when everything is fine', () => {
    expect(hubIssues(base)).toEqual([])
  })

  it('lists broken accounts first and links to the fix', () => {
    const items = hubIssues({
      ...base,
      currentPlan: null,
      accounts: [{ id: 'a1', platform: 'instagram', name: 'seastar', status: 'needs_reauth', last_synced_at: '2026-10-25T03:00:00Z' }],
      staleNewLeads: 2,
    })
    expect(items.map(i => i.severity)).toEqual(['critical', 'warning', 'info'])
    expect(items[0]).toMatchObject({ title: 'seastar needs reconnecting', href: '/dashboard/connections' })
    expect(items[1]).toMatchObject({ title: '2 leads not contacted yet', href: '/dashboard/marketing/c1?tab=leads' })
    expect(items[2].title).toBe('No content plan for October 2026')
  })

  it('does not ask an ads-only client for a content plan', () => {
    expect(hubIssues({ ...base, currentPlan: null, expectsPlan: false })).toEqual([])
  })

  it('does not flag an account that simply has not synced yet', () => {
    expect(hubIssues({ ...base, accounts: [{ id: 'a1', platform: 'facebook_page', name: 'new', status: 'connected', last_synced_at: null }] })).toEqual([])
  })

  it('flags overdue plan items and failed posts', () => {
    const items = hubIssues({ ...base, overduePlanItems: 1, failedPosts: 3 })
    expect(items.map(i => i.title)).toEqual(['3 posts failed to publish', '1 planned post is past its date'])
  })

  it('hides social and lead issues from people who cannot see them', () => {
    expect(hubIssues({ ...base, currentPlan: null, staleNewLeads: 4, canSeeSocial: false, canSeeLeads: false })).toEqual([])
  })
})

describe('client list helpers', () => {
  it('makes two-letter initials', () => {
    expect(initials('Sea Star Catering and Hotel')).toBe('SS')
    expect(initials('Milkees')).toBe('MI')
    expect(initials('B.N. Mart')).toBe('BN')
  })
  it('gives each client a stable hue', () => {
    expect(avatarHue('abc')).toBe(avatarHue('abc'))
    expect(avatarHue('abc')).toBeGreaterThanOrEqual(0)
    expect(avatarHue('abc')).toBeLessThan(360)
  })
  it('knows when a client has marketing set up', () => {
    expect(hasMarketing({ name: 'x', pages: 0, liveCampaigns: 0, hasPlan: false, leads30: 0 })).toBe(false)
    expect(hasMarketing({ name: 'x', pages: 0, liveCampaigns: 0, hasPlan: true, leads30: 0 })).toBe(true)
  })
  it('searches name and code, every word', () => {
    expect(matchesClient({ name: 'Sea Star Catering and Hotel', code: '039' }, 'sea cater')).toBe(true)
    expect(matchesClient({ name: 'Sea Star Catering and Hotel', code: '039' }, '039')).toBe(true)
    expect(matchesClient({ name: 'Sea Star Supermarket', code: '040' }, 'catering')).toBe(false)
  })
})

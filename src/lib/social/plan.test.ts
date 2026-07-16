import { describe, it, expect } from 'vitest'
import {
  composeRequestDescription, buildSocialMeta, resolveItemProgress, platformLabels,
  isTerminalRequestStatus, isClosedRequestStatus,
} from './plan'

describe('composeRequestDescription', () => {
  it('composes all sections in order', () => {
    const desc = composeRequestDescription({
      title: 'Diwali teaser',
      contentType: 'reel',
      platforms: ['instagram', 'facebook'],
      scheduledDate: '2026-08-05',
      caption: 'Lights on! ✨',
      notes: 'Use last year footage',
      calendarTitle: 'August content plan',
    })
    expect(desc).toBe(
      'Social media reel planned for 2026-08-05 (August content plan)\n\n' +
      'Platforms: Instagram, Facebook\n\n' +
      'Caption / copy:\nLights on! ✨\n\n' +
      'Notes:\nUse last year footage',
    )
  })

  it('omits empty sections and unknown content types pass through', () => {
    const desc = composeRequestDescription({
      title: 'x', contentType: 'meme', platforms: [], scheduledDate: '2026-08-05',
    })
    expect(desc).toBe('Social media meme planned for 2026-08-05')
  })
})

describe('buildSocialMeta', () => {
  it('produces the exact snake_case payload', () => {
    expect(buildSocialMeta({
      calendarId: 'c1', itemId: 'i1', contentType: 'post',
      platforms: ['instagram'], scheduledDate: '2026-08-01',
    })).toEqual({
      calendar_id: 'c1', item_id: 'i1', content_type: 'post',
      platforms: ['instagram'], scheduled_date: '2026-08-01',
    })
  })
})

describe('platformLabels', () => {
  it('long and short forms, unknown values pass through', () => {
    expect(platformLabels(['instagram', 'x'])).toBe('Instagram, X')
    expect(platformLabels(['instagram', 'facebook'], true)).toBe('IG·FB')
    expect(platformLabels(['mastodon'])).toBe('mastodon')
    expect(platformLabels(null)).toBe('')
  })
})

describe('resolveItemProgress', () => {
  it('planned when never pushed', () => {
    expect(resolveItemProgress('planned', null)).toBe('planned')
  })
  it('cancelled item wins over everything', () => {
    expect(resolveItemProgress('cancelled', { status: 'completed' })).toBe('cancelled')
  })
  it('requested while sitting in the inbox', () => {
    for (const s of ['submitted', 'under_review', 'approved']) {
      expect(resolveItemProgress('requested', { status: s })).toBe('requested')
    }
  })
  it('in_progress once started (with or without task join)', () => {
    expect(resolveItemProgress('requested', { status: 'started' })).toBe('in_progress')
    expect(resolveItemProgress('requested', { status: 'in_progress', promoted_task: { status: 'pending' } })).toBe('in_progress')
  })
  it('task status is authoritative when joined', () => {
    expect(resolveItemProgress('requested', { status: 'started', promoted_task: { status: 'delivered' } })).toBe('delivered')
    expect(resolveItemProgress('requested', { status: 'started', promoted_task: { status: 'invoiced' } })).toBe('done')
    expect(resolveItemProgress('requested', { status: 'started', promoted_task: { status: 'cancelled' } })).toBe('cancelled')
  })
  it('request terminal states', () => {
    expect(resolveItemProgress('requested', { status: 'completed' })).toBe('done')
    expect(resolveItemProgress('requested', { status: 'delivered' })).toBe('delivered')
    expect(resolveItemProgress('requested', { status: 'rejected' })).toBe('cancelled')
    expect(resolveItemProgress('requested', { status: 'cancelled' })).toBe('cancelled')
  })
  it('archived is terminal too — never reports as still queued', () => {
    expect(resolveItemProgress('requested', { status: 'archived' })).toBe('cancelled')
  })
})

describe('isTerminalRequestStatus / isClosedRequestStatus', () => {
  it('terminal covers finished + closed states the planner must not overwrite', () => {
    for (const s of ['completed', 'delivered', 'cancelled', 'rejected', 'archived']) {
      expect(isTerminalRequestStatus(s)).toBe(true)
    }
    for (const s of ['submitted', 'under_review', 'approved', 'started', 'in_progress']) {
      expect(isTerminalRequestStatus(s)).toBe(false)
    }
    expect(isTerminalRequestStatus(null)).toBe(false)
  })
  it('closed = re-plannable (cancelled/rejected/archived only)', () => {
    expect(isClosedRequestStatus('cancelled')).toBe(true)
    expect(isClosedRequestStatus('archived')).toBe(true)
    expect(isClosedRequestStatus('completed')).toBe(false)   // finished, not re-plannable
    expect(isClosedRequestStatus('submitted')).toBe(false)
  })
})

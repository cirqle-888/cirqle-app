import { describe, it, expect } from 'vitest'
import {
  isCreativeReady, isContentReady, postStageOf, urgencyOf, needsAttention,
  postChecklist, checklistProgress, cycleProgress, committedTarget, postContentTypeFor,
} from './post-queue'

const NO_CONTENT = {}
const READY_REQ = { requestStatus: 'completed' }

describe('isCreativeReady', () => {
  it('accepts a completed request', () => {
    expect(isCreativeReady({ requestStatus: 'completed' })).toBe(true)
  })

  it('accepts a done OR invoiced task', () => {
    // 'invoiced' is a stronger completion signal than 'done', not a weaker one
    // — we have already billed the client for it.
    expect(isCreativeReady({ taskStatus: 'done' })).toBe(true)
    expect(isCreativeReady({ taskStatus: 'invoiced' })).toBe(true)
  })

  it('rejects work still in production', () => {
    for (const s of ['submitted', 'started', 'in_progress', 'delivered']) {
      expect(isCreativeReady({ requestStatus: s })).toBe(false)
    }
    expect(isCreativeReady({ taskStatus: 'pending' })).toBe(false)
  })

  it('is false when neither side exists', () => {
    expect(isCreativeReady({})).toBe(false)
    expect(isCreativeReady({ requestStatus: null, taskStatus: null })).toBe(false)
  })

  it('either side alone is enough', () => {
    // A plan sent straight to a task has no request; one that never left the
    // inbox has no task. Neither absence means "not ready".
    expect(isCreativeReady({ requestStatus: null, taskStatus: 'done' })).toBe(true)
    expect(isCreativeReady({ requestStatus: 'completed', taskStatus: null })).toBe(true)
  })
})

describe('postStageOf', () => {
  it('work still being designed is Coming Up', () => {
    expect(postStageOf({ requestStatus: 'in_progress' }, NO_CONTENT)).toBe('coming_up')
  })

  it('finished artwork with no caption is To Prepare', () => {
    // The exact Independence Day case: REQ-17 completed, nothing written.
    expect(postStageOf(READY_REQ, NO_CONTENT)).toBe('to_prepare')
  })

  it('finished artwork with a caption is Ready', () => {
    expect(postStageOf(READY_REQ, { caption: 'Happy Independence Day' })).toBe('ready')
  })

  it('a published post is Posted regardless of pipeline state', () => {
    // Reality beats pipeline: if it went out, it went out.
    expect(postStageOf({ requestStatus: 'in_progress' }, { publishedAt: '2026-08-15T10:00:00Z' }))
      .toBe('posted')
  })

  it('blank strings do not count as content', () => {
    expect(postStageOf(READY_REQ, { caption: '   ' })).toBe('to_prepare')
    expect(postStageOf(READY_REQ, { publishedAt: '' })).toBe('to_prepare')
  })
})

describe('isContentReady', () => {
  it('needs only a caption — hashtags and alt text never block', () => {
    expect(isContentReady({ caption: 'hello' })).toBe(true)
    expect(isContentReady({ hashtags: '#a', altText: 'x' })).toBe(false)
  })
})

describe('urgencyOf', () => {
  const TODAY = '2026-08-28'

  it('flags the overdue Independence Day poster', () => {
    // Planned 15 Aug, still not posted on 28 Aug.
    const u = urgencyOf('2026-08-15', TODAY)
    expect(u.level).toBe('overdue')
    expect(u.days).toBe(-13)
    expect(u.label).toBe('13 days late')
  })

  it('says "1 day late", not "1 days late"', () => {
    expect(urgencyOf('2026-08-27', TODAY).label).toBe('1 day late')
  })

  it('recognises today and tomorrow', () => {
    expect(urgencyOf('2026-08-28', TODAY).level).toBe('today')
    expect(urgencyOf('2026-08-29', TODAY).level).toBe('tomorrow')
  })

  it('treats the next few days as soon', () => {
    expect(urgencyOf('2026-08-31', TODAY).level).toBe('soon')
    expect(urgencyOf('2026-09-01', TODAY).level).toBe('later')
  })

  it('compares calendar dates, not instants', () => {
    // A timezone-shifted midnight must not turn the 15th into the 14th.
    expect(urgencyOf('2026-08-15', '2026-08-15').level).toBe('today')
  })

  it('crosses month and year boundaries', () => {
    expect(urgencyOf('2026-09-01', '2026-08-31').days).toBe(1)
    expect(urgencyOf('2027-01-01', '2026-12-31').days).toBe(1)
  })

  it('has no opinion without a date', () => {
    expect(urgencyOf(null, TODAY).level).toBe('none')
  })
})

describe('needsAttention', () => {
  const TODAY = '2026-08-28'

  it('nags about ready work that is due or late', () => {
    expect(needsAttention('to_prepare', urgencyOf('2026-08-15', TODAY))).toBe(true)
    expect(needsAttention('ready', urgencyOf('2026-08-29', TODAY))).toBe(true)
  })

  it('never nags about something already posted, however late it went', () => {
    expect(needsAttention('posted', urgencyOf('2026-08-01', TODAY))).toBe(false)
  })

  it('never nags about artwork that does not exist yet', () => {
    // Chasing her for a caption before the designer has finished is noise.
    expect(needsAttention('coming_up', urgencyOf('2026-08-15', TODAY))).toBe(false)
  })

  it('stays quiet for work comfortably in the future', () => {
    expect(needsAttention('to_prepare', urgencyOf('2026-09-20', TODAY))).toBe(false)
  })
})

describe('postChecklist', () => {
  it('is empty-ish for untouched work', () => {
    const items = postChecklist({ requestStatus: 'in_progress' }, NO_CONTENT)
    expect(checklistProgress(items)).toEqual({ done: 0, total: 5 })
  })

  it('ticks artwork as soon as the request completes', () => {
    const items = postChecklist(READY_REQ, NO_CONTENT)
    expect(items.find(i => i.key === 'creative')?.done).toBe(true)
    expect(checklistProgress(items).done).toBe(1)
  })

  it('marks hashtags and alt text advisory, caption and posting required', () => {
    const items = postChecklist(READY_REQ, NO_CONTENT)
    const optional = items.filter(i => i.optional).map(i => i.key)
    expect(optional).toEqual(['hashtags', 'alt_text'])
  })

  it('reaches 5 of 5 on a fully prepared, posted item', () => {
    const items = postChecklist(READY_REQ, {
      caption: 'Happy Independence Day', hashtags: '#india', altText: 'Flag',
      publishedAt: '2026-08-15T10:00:00Z',
    })
    expect(checklistProgress(items)).toEqual({ done: 5, total: 5 })
  })

  it('cannot go stale — clearing the caption unticks it', () => {
    // Derived from the post itself, so there is no stored tick to drift.
    const items = postChecklist(READY_REQ, { caption: '' })
    expect(items.find(i => i.key === 'caption')?.done).toBe(false)
  })
})

describe('cycleProgress', () => {
  it('shows progress against a committed package (Elara: 15/cycle)', () => {
    expect(cycleProgress(8, 15).label).toBe('8 of 15 posted')
  })

  it('shows a bare count with no package (Sea Star: bill per task)', () => {
    // "3 of 0" would read as failure; there is simply no target.
    const p = cycleProgress(3, null)
    expect(p.target).toBeNull()
    expect(p.label).toBe('3 posted')
  })

  it('does not say "1 posteds"', () => {
    expect(cycleProgress(1, null).label).toBe('1 posted')
  })

  it('treats a zero or missing target as no target', () => {
    expect(cycleProgress(2, 0).target).toBeNull()
    expect(cycleProgress(2, undefined).target).toBeNull()
  })

  it('does not cap at the target — overdelivery stays visible', () => {
    expect(cycleProgress(17, 15).label).toBe('17 of 15 posted')
  })
})

describe('committedTarget', () => {
  const SOCIAL = 'svc-social-poster'
  const LOGO = 'svc-logo-design'
  const onCalendar = new Set([SOCIAL])

  it('counts only the service the calendar actually plans', () => {
    // Elara holds two active packages. Social Media Management commits 15
    // posters; Brand Identity Essential commits 2 logos. The posting queue's
    // target is 15, not 17 — nobody agreed to 17 posts a month.
    const target = committedTarget(
      [{ serviceId: SOCIAL, quantity: 15 }, { serviceId: LOGO, quantity: 2 }],
      onCalendar,
    )
    expect(target).toBe(15)
  })

  it('adds up several qualifying items', () => {
    const target = committedTarget(
      [{ serviceId: SOCIAL, quantity: 10 }, { serviceId: SOCIAL, quantity: 5 }],
      onCalendar,
    )
    expect(target).toBe(15)
  })

  it('returns null — not zero — when nothing qualifies', () => {
    // Sea Star: billed per task, no package. "0 of 0" would read as failure.
    expect(committedTarget([{ serviceId: LOGO, quantity: 2 }], onCalendar)).toBeNull()
    expect(committedTarget([], onCalendar)).toBeNull()
  })

  it('ignores zero and negative quantities', () => {
    expect(committedTarget([{ serviceId: SOCIAL, quantity: 0 }], onCalendar)).toBeNull()
    expect(committedTarget(
      [{ serviceId: SOCIAL, quantity: -3 }, { serviceId: SOCIAL, quantity: 4 }], onCalendar,
    )).toBe(4)
  })

  it('feeds cycleProgress to give the two client shapes', () => {
    expect(cycleProgress(8, committedTarget(
      [{ serviceId: SOCIAL, quantity: 15 }], onCalendar)).label).toBe('8 of 15 posted')
    expect(cycleProgress(3, committedTarget([], onCalendar)).label).toBe('3 posted')
  })
})

describe('postContentTypeFor', () => {
  it('maps the calendar words the studio actually uses to picture posts', () => {
    // Every one of the 7 live calendar items is 'post'. Before this mapping
    // existed the insert failed the social_posts CHECK constraint outright.
    for (const t of ['post', 'poster', 'flyer', 'ad', 'other']) {
      expect(postContentTypeFor(t)).toBe('image')
    }
  })

  it('passes through the types both tables already agree on', () => {
    expect(postContentTypeFor('carousel')).toBe('carousel')
    expect(postContentTypeFor('reel')).toBe('reel')
    expect(postContentTypeFor('video')).toBe('video')
  })

  it('sends a story to the image variant', () => {
    expect(postContentTypeFor('story')).toBe('story_image')
  })

  it('treats written formats as link or text', () => {
    expect(postContentTypeFor('blog')).toBe('link')
    expect(postContentTypeFor('seo')).toBe('link')
    expect(postContentTypeFor('email')).toBe('text')
  })

  it('falls back to image rather than blocking a save', () => {
    expect(postContentTypeFor(null)).toBe('image')
    expect(postContentTypeFor(undefined)).toBe('image')
    expect(postContentTypeFor('something-new')).toBe('image')
  })

  it('is case and whitespace tolerant', () => {
    expect(postContentTypeFor('  POST ')).toBe('image')
  })

  it('only ever returns a value social_posts accepts', () => {
    const ALLOWED = ['image','carousel','video','reel','story_image','story_video','text','link']
    const CALENDAR = ['post','reel','story','carousel','video','flyer','poster','blog','seo','ad','email','other']
    for (const t of CALENDAR) expect(ALLOWED).toContain(postContentTypeFor(t))
  })
})

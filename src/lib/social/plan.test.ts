import { describe, it, expect } from 'vitest'
import {
  composeRequestDescription, buildSocialMeta, resolveItemProgress, platformLabels,
  isTerminalRequestStatus, isClosedRequestStatus, contentTypeWithVariants,
  sanitizeCaptionHtml, captionHtmlToText, formatShortDateRange,
  sanitizeCaptionCanvas, canvasToText, isUnrouted, canPullBack,
} from './plan'

describe('sanitizeCaptionHtml', () => {
  it('keeps formatting tags, strips everything else including attributes', () => {
    expect(sanitizeCaptionHtml('<b>Onam</b> <i>sadya</i> <u>combo</u>')).toBe('<b>Onam</b> <i>sadya</i> <u>combo</u>')
    expect(sanitizeCaptionHtml('<ul><li>one</li><li>two</li></ul>')).toBe('<ul><li>one</li><li>two</li></ul>')
    // `b` never keeps a style attribute (only span/p/div/li/headings do), and
    // event handlers are always dropped.
    expect(sanitizeCaptionHtml('<b style="color:red" onclick="x()">hi</b>')).toBe('<b>hi</b>')
    expect(sanitizeCaptionHtml('<script>alert(1)</script>safe')).toBe('safe')
    expect(sanitizeCaptionHtml('plain text stays')).toBe('plain text stays')
  })

  it('keeps safe links but strips images and javascript hrefs', () => {
    expect(sanitizeCaptionHtml('<a href="https://cirqle.works">site</a>')).toBe('<a href="https://cirqle.works">site</a>')
    expect(sanitizeCaptionHtml('<a href="mailto:hi@x.com">mail</a>')).toBe('<a href="mailto:hi@x.com">mail</a>')
    // javascript: href is rejected — the tag stays, the href does not.
    expect(sanitizeCaptionHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>')
    // images are not in the allowlist — dropped, inner text (none) kept.
    expect(sanitizeCaptionHtml('<a href="https://ok.com">link</a><img src=x onerror=1>')).toBe('<a href="https://ok.com">link</a>')
  })

  // Caption HTML is injected UNESCAPED into the PDF document, so the allowlist
  // is the only thing standing between a planner's paste and script execution.
  it('resists XSS payloads', () => {
    const noScript = (s: string) => {
      const out = sanitizeCaptionHtml(s)
      expect(out).not.toMatch(/<script|<img|<svg|<iframe|onerror|onclick|onload|onmouseover|javascript:/i)
      return out
    }
    noScript('<SCRIPT>alert(1)</SCRIPT>')                       // uppercase tags
    noScript('<img src=x onerror=alert(1)>')                    // unquoted event handler
    noScript('<svg onload=alert(1)></svg>')
    noScript('<iframe src="//evil"></iframe>')
    noScript('<div onmouseover="alert(1)">hover</div>')
    noScript('<b onclick=alert(1)>hi</b>')
    noScript('<a href="  javascript:alert(1)">x</a>')           // leading-space bypass
    noScript('<a href="java&#115;cript:alert(1)">x</a>')        // entity-encoded scheme
    noScript('<a href="data:text/html,hello">x</a>')            // data: URL
    noScript('<span style="background-color:url(javascript:alert(1))">x</span>')
    noScript('<span style="color:expression(alert(1))">x</span>')
    noScript('<span style="color:red;behavior:url(#x)">x</span>')
    // "/" as the name→attribute separator: browsers parse these as real tags,
    // so the sanitizer must too (a whitespace-only pattern let them through raw).
    noScript('<img/src=x onerror=alert(1)>')
    noScript('<img/onerror=alert(1) src=x>')
    noScript('<svg/onload=alert(1)>')
    noScript('<script/src=//evil.com>')
    noScript('<iframe/src=//evil.com>')
    // Quoted attribute containing ">" must not end the tag early.
    noScript('<img alt="a>b" onerror=alert(1)>')
    // A near-miss attribute name must not be read as the real one.
    expect(sanitizeCaptionHtml('<a data-href="https://ok.com">x</a>')).toBe('<a>x</a>')

    // Event handlers are stripped but the allowed tag and its text survive.
    expect(sanitizeCaptionHtml('<b onclick=alert(1)>hi</b>')).toBe('<b>hi</b>')
    expect(sanitizeCaptionHtml('<div onmouseover="alert(1)">hover</div>')).toBe('<div>hover</div>')
    // Disallowed tags vanish entirely, keeping only their text.
    expect(sanitizeCaptionHtml('<iframe src="//evil"></iframe>')).toBe('')
  })

  it('keeps only whitelisted style properties with safe values', () => {
    expect(sanitizeCaptionHtml('<span style="color:#e11;background-color:yellow">hi</span>'))
      .toBe('<span style="color:#e11;background-color:yellow">hi</span>')
    // position/url() smuggling is rejected; the harmless property survives.
    expect(sanitizeCaptionHtml('<span style="color:red;position:fixed;background:url(x)">y</span>'))
      .toBe('<span style="color:red">y</span>')
    expect(sanitizeCaptionHtml('<p style="text-align:center">centered</p>'))
      .toBe('<p style="text-align:center">centered</p>')
  })
})

describe('sanitizeCaptionCanvas', () => {
  const block = (over: Record<string, unknown> = {}) => ({
    id: 'b1', type: 'image', x: 10, y: 10, w: 100, h: 80, z: 1,
    url: 'https://cdn.example/a.png', ...over,
  })

  it('keeps a well-formed board and pins the design width', () => {
    const out = sanitizeCaptionCanvas({ w: 999, h: 400, blocks: [block()] })
    expect(out).toEqual({
      w: 640, h: 400,
      // z is renormalized to a dense 0..n-1 scale (see below).
      blocks: [{ id: 'b1', type: 'image', x: 10, y: 10, w: 100, h: 80, z: 0, url: 'https://cdn.example/a.png' }],
    })
  })

  it('renormalizes z to 0..n-1 while preserving stacking order', () => {
    // The editor's bring-to-front just increments, so z grows without bound.
    // Clamping those raw values would collapse layers onto each other; they
    // must be re-densified instead.
    const out = sanitizeCaptionCanvas({
      blocks: [
        block({ id: 'low', z: 5 }),
        block({ id: 'high', z: 999999 }),
        block({ id: 'mid', z: 700 }),
      ],
    })!
    const z = Object.fromEntries(out.blocks.map(b => [b.id, b.z]))
    expect(z.low).toBe(0)
    expect(z.mid).toBe(1)
    expect(z.high).toBe(2)
  })

  it('forces block ids to be unique', () => {
    // Two blocks sharing an id would make one edit mutate both.
    const out = sanitizeCaptionCanvas({
      blocks: [block({ id: 'dup' }), block({ id: 'dup' }), block({ id: 999 })],
    })!
    const ids = out.blocks.map(b => b.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('returns null for empty, malformed, or block-less input', () => {
    expect(sanitizeCaptionCanvas(null)).toBeNull()
    expect(sanitizeCaptionCanvas('nope')).toBeNull()
    expect(sanitizeCaptionCanvas({ blocks: [] })).toBeNull()
    expect(sanitizeCaptionCanvas({ blocks: 'not-an-array' })).toBeNull()
    // every block invalid → nothing to keep
    expect(sanitizeCaptionCanvas({ blocks: [block({ url: 'javascript:alert(1)' })] })).toBeNull()
  })

  it('rejects unsafe image URLs', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', '', 'ftp://x/y']) {
      expect(sanitizeCaptionCanvas({ blocks: [block({ url })] })).toBeNull()
    }
    expect(sanitizeCaptionCanvas({ blocks: [block({ url: 'http://ok.com/a.png' })] })?.blocks).toHaveLength(1)
  })

  it('clamps coordinates so a block can never sit off the board', () => {
    const out = sanitizeCaptionCanvas({ h: 300, blocks: [block({ x: -500, y: -500, w: 9999, h: 9999 })] })
    const b = out!.blocks[0]
    expect(b.x).toBe(0)
    expect(b.y).toBe(0)
    expect(b.w).toBeLessThanOrEqual(640)
    expect(b.x + b.w).toBeLessThanOrEqual(640)
  })

  it('bounds blocks by THIS board height, not the global ceiling', () => {
    // A short board must not keep a block parked far below it — that block
    // would be invisible in the editor and clipped out of the PDF.
    const out = sanitizeCaptionCanvas({ h: 200, blocks: [block({ y: 1500, h: 900 })] })!
    const b = out.blocks[0]
    expect(out.h).toBe(200)
    expect(b.y + b.h).toBeLessThanOrEqual(out.h)
  })

  it('never renders taller than one PDF page', () => {
    // 0.6 scale into a 1032px page minus row chrome — see CANVAS_MAX_H.
    const out = sanitizeCaptionCanvas({ h: 99999, blocks: [block()] })!
    expect(out.h).toBeLessThanOrEqual(1200)
    expect(out.h * 0.6).toBeLessThan(1032 - 140)
  })

  it('strips HTML from text blocks and drops empty ones', () => {
    const out = sanitizeCaptionCanvas({
      blocks: [
        block({ id: 't1', type: 'text', text: '<b>Onam</b> sale<script>alert(1)</script>', url: undefined }),
        block({ id: 't2', type: 'text', text: '   ', url: undefined }),
      ],
    })
    expect(out!.blocks).toHaveLength(1)
    expect((out!.blocks[0] as { text: string }).text).toBe('Onam salealert(1)')
    expect(JSON.stringify(out)).not.toMatch(/<b>|<script/)
  })

  it('caps block count and enforces safe text styling', () => {
    const many = Array.from({ length: 80 }, (_, i) => block({ id: `b${i}` }))
    expect(sanitizeCaptionCanvas({ blocks: many })!.blocks.length).toBeLessThanOrEqual(40)

    const styled = sanitizeCaptionCanvas({
      blocks: [block({ type: 'text', text: 'hi', url: undefined, color: 'red; background:url(x)', align: 'justify', size: 999 })],
    })!.blocks[0] as Record<string, unknown>
    expect(styled.color).toBeUndefined()   // only #hex colours survive
    expect(styled.align).toBeUndefined()   // only left/center/right
    expect(styled.size).toBe(48)           // clamped to the max
  })
})

describe('canvasToText', () => {
  const t = (id: string, x: number, y: number, text: string) =>
    ({ id, type: 'text' as const, x, y, w: 100, h: 30, z: 1, text })

  it('reads top-to-bottom then left-to-right, skipping images', () => {
    const canvas = sanitizeCaptionCanvas({
      h: 400,
      blocks: [
        t('c', 10, 200, 'third'),
        t('b', 200, 20, 'second'),
        t('a', 10, 24, 'first'),      // same visual row as "second", further left
        { id: 'i', type: 'image', x: 0, y: 0, w: 50, h: 50, z: 0, url: 'https://x/y.png' },
      ],
    })
    expect(canvasToText(canvas)).toBe('first\nsecond\nthird')
  })

  it('is empty for a board with no text', () => {
    expect(canvasToText(null)).toBe('')
    expect(canvasToText({ w: 640, h: 360, blocks: [] })).toBe('')
  })
})

describe('formatShortDateRange', () => {
  it('single day, range, and empty', () => {
    expect(formatShortDateRange('2026-07-03')).toBe('03 Jul')
    expect(formatShortDateRange('2026-07-03', '2026-07-11')).toBe('03 Jul – 11 Jul')
    expect(formatShortDateRange('2026-07-03', '2026-07-03')).toBe('03 Jul') // equal end collapses
    expect(formatShortDateRange(null)).toBe('')
    expect(formatShortDateRange('')).toBe('')
  })
})

describe('captionHtmlToText', () => {
  it('projects rich captions to readable plain text', () => {
    expect(captionHtmlToText('<b>Bold</b> and <i>italic</i>')).toBe('Bold and italic')
    expect(captionHtmlToText('<ul><li>first</li><li>second</li></ul>')).toBe('• first\n• second')
    expect(captionHtmlToText('<ol><li>one</li><li>two</li></ol>')).toBe('1. one\n2. two')
    expect(captionHtmlToText('<div>line 1</div><div>line 2</div>')).toBe('line 1\nline 2')
    expect(captionHtmlToText('legacy plain caption')).toBe('legacy plain caption')
  })
})

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
      'Planned reel for 2026-08-05 (August content plan)\n\n' +
      'Platforms: Instagram, Facebook\n\n' +
      'Caption / copy:\nLights on! ✨\n\n' +
      'Notes:\nUse last year footage',
    )
  })

  it('describes undated ideas and includes the reference image', () => {
    const desc = composeRequestDescription({
      title: 'x', contentType: 'seo', platforms: [], scheduledDate: null,
      referenceUrls: ['https://cdn.example/ref.png'],
    })
    expect(desc).toBe(
      'Planned seo (date to be scheduled)\n\n' +
      'Reference image:\nhttps://cdn.example/ref.png',
    )
  })

  it('renders a scheduled date RANGE as "from X to Y"', () => {
    const desc = composeRequestDescription({
      title: 'Summer push', contentType: 'ad', platforms: ['instagram'],
      scheduledDate: '2026-08-01', scheduledEndDate: '2026-08-14',
      calendarTitle: 'August content plan',
    })
    expect(desc).toBe(
      'Planned ad campaign from 2026-08-01 to 2026-08-14 (August content plan)\n\n' +
      'Platforms: Instagram',
    )
  })

  it('lists MULTIPLE references and pluralises the label', () => {
    const desc = composeRequestDescription({
      title: 'x', contentType: 'post', platforms: [], scheduledDate: '2026-08-05',
      referenceUrls: ['https://cdn.example/a.png', 'https://cdn.example/b.png'],
    })
    expect(desc).toBe(
      'Planned post for 2026-08-05\n\n' +
      'Reference images:\nhttps://cdn.example/a.png\nhttps://cdn.example/b.png',
    )
  })

  it('omits empty sections and unknown content types pass through', () => {
    const desc = composeRequestDescription({
      title: 'x', contentType: 'meme', platforms: [], scheduledDate: '2026-08-05',
    })
    expect(desc).toBe('Planned meme for 2026-08-05')
  })

  it('lists variant formats in the brief, excluding the main type itself', () => {
    const desc = composeRequestDescription({
      title: 'x', contentType: 'post', platforms: [], scheduledDate: '2026-08-05',
      variants: ['story', 'post', 'reel'],
    })
    expect(desc).toBe(
      'Planned post for 2026-08-05\n\n' +
      'Also deliver as: Story, Reel (size/format variants of the same creative)',
    )
  })
})

describe('contentTypeWithVariants', () => {
  it('joins the main type with its variants and skips duplicates of itself', () => {
    expect(contentTypeWithVariants('post', ['story'])).toBe('Post + Story')
    expect(contentTypeWithVariants('post', ['post', 'story', 'reel'])).toBe('Post + Story + Reel')
    expect(contentTypeWithVariants('post', [])).toBe('Post')
    expect(contentTypeWithVariants('post', null)).toBe('Post')
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

  it('carries variants only when present', () => {
    expect(buildSocialMeta({
      calendarId: 'c1', itemId: 'i1', contentType: 'post',
      platforms: [], scheduledDate: '2026-08-01', variants: ['story'],
    })).toMatchObject({ variants: ['story'] })
    expect(buildSocialMeta({
      calendarId: 'c1', itemId: 'i1', contentType: 'post',
      platforms: [], scheduledDate: '2026-08-01', variants: [],
    })).not.toHaveProperty('variants')
  })

  it('carries scheduled_end_date only for real ranges', () => {
    expect(buildSocialMeta({
      calendarId: 'c1', itemId: 'i1', contentType: 'ad',
      platforms: [], scheduledDate: '2026-08-01', scheduledEndDate: '2026-08-14',
    })).toMatchObject({ scheduled_end_date: '2026-08-14' })
    expect(buildSocialMeta({
      calendarId: 'c1', itemId: 'i1', contentType: 'ad',
      platforms: [], scheduledDate: '2026-08-01', scheduledEndDate: null,
    })).not.toHaveProperty('scheduled_end_date')
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

describe('resolveItemProgress — direct task exit', () => {
  it('a directly-linked task owns the progress, with no request involved', () => {
    expect(resolveItemProgress('tasked', null, { status: 'pending' })).toBe('in_progress')
    expect(resolveItemProgress('tasked', null, { status: 'delivered' })).toBe('delivered')
    expect(resolveItemProgress('tasked', null, { status: 'paid' })).toBe('done')
    expect(resolveItemProgress('tasked', null, { status: 'cancelled' })).toBe('cancelled')
  })

  it('both routes report the same state for the same task status', () => {
    for (const s of ['pending', 'in_progress', 'delivered', 'done', 'invoiced', 'paid', 'cancelled']) {
      const direct = resolveItemProgress('tasked', null, { status: s })
      const viaRequest = resolveItemProgress('requested', { status: 'started', promoted_task: { status: s } })
      expect(direct).toBe(viaRequest)
    }
  })

  it('a soft-deleted task falls back instead of stranding the item', () => {
    // Trashing the task must not leave the calendar showing phantom progress.
    expect(resolveItemProgress('tasked', null, { status: 'pending', deleted_at: '2026-08-25' })).toBe('planned')
    // …and if a request also exists, that route still answers.
    expect(
      resolveItemProgress('requested', { status: 'submitted' }, { status: 'pending', deleted_at: '2026-08-25' }),
    ).toBe('requested')
  })

  it('an explicitly cancelled item beats any live task', () => {
    expect(resolveItemProgress('cancelled', null, { status: 'in_progress' })).toBe('cancelled')
  })
})

describe('isUnrouted', () => {
  it('a plain planned item can be sent down either pipe', () => {
    expect(isUnrouted({ status: 'planned' })).toBe(true)
  })

  it('anything already carrying live work is not offered again', () => {
    expect(isUnrouted({ status: 'requested', request_id: 'r1', request: { status: 'submitted' } })).toBe(false)
    expect(isUnrouted({ status: 'tasked', task_id: 't1', task: { status: 'pending' } })).toBe(false)
    expect(isUnrouted({ status: 'cancelled' })).toBe(false)
  })

  it('a closed request frees the item to be sent again', () => {
    expect(isUnrouted({ status: 'planned', request_id: 'r1', request: { status: 'cancelled' } })).toBe(true)
    expect(isUnrouted({ status: 'planned', request_id: 'r1', request: { status: 'rejected' } })).toBe(true)
  })

  it('a trashed direct task frees the item too', () => {
    expect(isUnrouted({ status: 'planned', task_id: 't1', task: { status: 'pending', deleted_at: '2026-08-25' } })).toBe(true)
  })

  it('a bare request id with no joined row counts as live', () => {
    // Pre-migration reads and permission-filtered joins both land here. Better
    // to under-offer the button than to double-push work that already exists.
    expect(isUnrouted({ status: 'requested', request_id: 'r1' })).toBe(false)
  })
})

describe('canPullBack', () => {
  it('an open, unpromoted request can be pulled back in one click', () => {
    expect(canPullBack({ status: 'requested', request_id: 'r1', request: { status: 'submitted' } })).toBe(true)
    expect(canPullBack({ status: 'requested', request_id: 'r1', request: { status: 'under_review' } })).toBe(true)
  })

  it('a closed request is still pullable — that is the re-plan escape hatch', () => {
    expect(canPullBack({ status: 'planned', request_id: 'r1', request: { status: 'cancelled' } })).toBe(true)
  })

  it('refuses once the request became a task — the task owns the schedule', () => {
    expect(canPullBack({
      status: 'requested', request_id: 'r1',
      request: { status: 'started', promoted_task: { status: 'pending' } },
    })).toBe(false)
  })

  it('refuses to rewrite work the client has already seen', () => {
    expect(canPullBack({ status: 'requested', request_id: 'r1', request: { status: 'completed' } })).toBe(false)
    expect(canPullBack({ status: 'requested', request_id: 'r1', request: { status: 'delivered' } })).toBe(false)
  })

  it('a direct task is pullable while unstarted, not once delivered', () => {
    expect(canPullBack({ status: 'tasked', task_id: 't1', task: { status: 'pending' } })).toBe(true)
    expect(canPullBack({ status: 'tasked', task_id: 't1', task: { status: 'in_progress' } })).toBe(true)
    expect(canPullBack({ status: 'tasked', task_id: 't1', task: { status: 'delivered' } })).toBe(false)
    expect(canPullBack({ status: 'tasked', task_id: 't1', task: { status: 'paid' } })).toBe(false)
  })

  it('there is nothing to pull back from an unrouted item', () => {
    expect(canPullBack({ status: 'planned' })).toBe(false)
  })
})

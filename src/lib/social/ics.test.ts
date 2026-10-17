import { describe, it, expect } from 'vitest'
import {
  escapeText, foldLine, formatUtc, triggerDuration, buildCalendar, postingEvent,
  type IcsEvent,
} from './ics'

const NOW = new Date('2026-10-17T06:00:00Z')
const AT = new Date('2026-10-19T14:00:00Z') // 19:30 IST

const lines = (ics: string) => ics.split('\r\n')
/** Unfold before asserting on a value — a long line is legally split. */
const unfold = (ics: string) => ics.replace(/\r\n /g, '')

describe('escapeText', () => {
  it('escapes the four characters that break a parser', () => {
    expect(escapeText('a;b,c\\d')).toBe('a\\;b\\,c\\\\d')
    expect(escapeText('one\ntwo')).toBe('one\\ntwo')
    expect(escapeText('one\r\ntwo')).toBe('one\\ntwo')
  })

  it('escapes backslashes before the escapes it adds, not after', () => {
    // Getting this order wrong yields 'a\\\\;b' — a literal backslash then an
    // unescaped semicolon, which ends the value early.
    expect(escapeText('a\\;b')).toBe('a\\\\\\;b')
  })
})

describe('foldLine', () => {
  it('leaves a short line alone', () => {
    expect(foldLine('SUMMARY:hello')).toBe('SUMMARY:hello')
  })

  it('folds at 75 octets with a leading space on continuations', () => {
    const folded = foldLine(`SUMMARY:${'x'.repeat(200)}`)
    const parts = folded.split('\r\n')
    expect(parts.length).toBeGreaterThan(1)
    expect(new TextEncoder().encode(parts[0]).length).toBeLessThanOrEqual(75)
    for (const p of parts.slice(1)) {
      expect(p.startsWith(' ')).toBe(true)
      expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(75)
    }
    expect(parts.join('').replace(/^ | /g, '')).toContain('x'.repeat(200))
  })

  it('counts octets, not characters, and never splits one character', () => {
    // Each emoji is 4 UTF-8 bytes; 30 of them is 120 octets in 30 characters.
    const folded = foldLine(`SUMMARY:${'\u{1F389}'.repeat(30)}`)
    for (const part of folded.split('\r\n')) {
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75)
    }
    // Unfolding restores every emoji intact — none cut in half.
    expect(folded.replace(/\r\n /g, '')).toBe(`SUMMARY:${'\u{1F389}'.repeat(30)}`)
  })
})

describe('formatUtc', () => {
  it('writes the UTC instant form', () => {
    expect(formatUtc(AT)).toBe('20261019T140000Z')
    expect(formatUtc(new Date('2026-01-02T03:04:05Z'))).toBe('20260102T030405Z')
  })
})

describe('triggerDuration', () => {
  it('writes the lead the way the spec wants it', () => {
    expect(triggerDuration(15)).toBe('-PT15M')
    expect(triggerDuration(60)).toBe('-PT1H')
    expect(triggerDuration(90)).toBe('-PT1H30M')
    expect(triggerDuration(0)).toBe('PT0S')
    expect(triggerDuration(-5)).toBe('PT0S')
  })
})

describe('buildCalendar', () => {
  const ev: IcsEvent = { uid: 'u1', start: AT, summary: 'Post it' }

  it('produces a document a calendar client will accept', () => {
    const out = buildCalendar([ev], { name: 'Cirqle Posting', now: NOW })
    const l = lines(out)
    expect(l[0]).toBe('BEGIN:VCALENDAR')
    expect(l).toContain('VERSION:2.0')
    expect(l).toContain('METHOD:PUBLISH')
    expect(l).toContain('X-WR-CALNAME:Cirqle Posting')
    expect(l.at(-2)).toBe('END:VCALENDAR')
    expect(out.endsWith('\r\n')).toBe(true)
  })

  it('terminates every line with CRLF, never a bare newline', () => {
    const out = buildCalendar([ev], { name: 'x', now: NOW })
    expect(out.includes('\n')).toBe(true)
    expect(/[^\r]\n/.test(out)).toBe(false)
  })

  it('tells subscribers how often to come back, in both spellings', () => {
    const out = buildCalendar([ev], { name: 'x', now: NOW })
    expect(out).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H')
    expect(out).toContain('X-PUBLISHED-TTL:PT1H')
  })

  it('defaults an event to a 15-minute block', () => {
    const out = buildCalendar([ev], { name: 'x', now: NOW })
    expect(out).toContain('DTSTART:20261019T140000Z')
    expect(out).toContain('DTEND:20261019T141500Z')
  })

  it('stamps every event with the same generation time', () => {
    const out = buildCalendar([ev, { ...ev, uid: 'u2' }], { name: 'x', now: NOW })
    expect(out.match(/DTSTAMP:20261017T060000Z/g)).toHaveLength(2)
  })

  it('keeps BEGIN/END balanced for several events', () => {
    const out = buildCalendar([ev, { ...ev, uid: 'u2' }, { ...ev, uid: 'u3' }], { name: 'x', now: NOW })
    expect(out.match(/BEGIN:VEVENT/g)).toHaveLength(3)
    expect(out.match(/END:VEVENT/g)).toHaveLength(3)
  })

  it('writes an alarm as its own block with the right trigger', () => {
    const out = buildCalendar(
      [{ ...ev, alarms: [{ minutesBefore: 15, description: 'Soon' }] }],
      { name: 'x', now: NOW },
    )
    const l = lines(out)
    const start = l.indexOf('BEGIN:VALARM')
    expect(start).toBeGreaterThan(-1)
    expect(l.slice(start, start + 5)).toEqual([
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'DESCRIPTION:Soon', 'END:VALARM',
    ])
  })

  it('is empty-safe', () => {
    const out = buildCalendar([], { name: 'Nothing planned', now: NOW })
    expect(out).toContain('BEGIN:VCALENDAR')
    expect(out).not.toContain('BEGIN:VEVENT')
  })
})

describe('postingEvent', () => {
  const base = {
    itemId: 'item-1',
    clientName: 'Sea Star Supermarket',
    title: 'Weekend offer reel',
    postAt: AT,
    contentType: 'reel',
    platforms: ['instagram', 'facebook'],
    url: 'https://app.cirqle.work/dashboard/social/queue',
  }

  it('reads on a lock screen: client first, then what it is', () => {
    expect(postingEvent(base).summary).toBe('Post: Sea Star Supermarket — Weekend offer reel')
  })

  it('carries a stable UID so re-publishing updates rather than duplicates', () => {
    expect(postingEvent(base).uid).toBe('social-post-item-1@cirqle.work')
    expect(postingEvent(base).uid).toBe(postingEvent({ ...base, title: 'Renamed' }).uid)
  })

  it('warns 15 minutes ahead and again at the moment', () => {
    const triggers = postingEvent(base).alarms!.map(a => a.minutesBefore)
    expect(triggers).toEqual([15, 0])
  })

  it('takes a custom lead', () => {
    expect(postingEvent({ ...base, reminderMinutes: 30 }).alarms![0].minutesBefore).toBe(30)
  })

  it('is the highest priority the format has', () => {
    expect(postingEvent(base).priority).toBe(1)
  })

  it('never blocks the person’s calendar as busy', () => {
    const out = buildCalendar([postingEvent(base)], { name: 'x', now: NOW })
    expect(out).toContain('TRANSP:TRANSPARENT')
  })

  it('says plainly when the client has not approved yet', () => {
    const ev = postingEvent({ ...base, awaitingApproval: true })
    expect(ev.status).toBe('TENTATIVE')
    expect(ev.description).toContain('Waiting on client approval')
  })

  it('emits a cancelled post rather than dropping it, so phones let go of it', () => {
    expect(postingEvent({ ...base, cancelled: true }).status).toBe('CANCELLED')
  })

  it('raises SEQUENCE when the post is edited, so subscribers refresh', () => {
    const older = postingEvent({ ...base, updatedAt: new Date('2026-10-01T00:00:00Z') })
    const newer = postingEvent({ ...base, updatedAt: new Date('2026-10-05T00:00:00Z') })
    expect(newer.sequence!).toBeGreaterThan(older.sequence!)
  })

  it('survives a client name with the characters that break .ics', () => {
    const out = buildCalendar(
      [postingEvent({ ...base, clientName: 'Tom; Dick, & Harry \\ Co' })],
      { name: 'x', now: NOW },
    )
    expect(unfold(out)).toContain('SUMMARY:Post: Tom\\; Dick\\, & Harry \\\\ Co — Weekend offer reel')
  })

  it('folds a very long title without corrupting it', () => {
    const title = 'Deepavali mega offer '.repeat(12).trim()
    const out = buildCalendar([postingEvent({ ...base, title })], { name: 'x', now: NOW })
    for (const line of out.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    }
    expect(unfold(out)).toContain(title)
  })

  it('leaves out detail lines it has nothing to say for', () => {
    const ev = postingEvent({ itemId: 'i', clientName: 'C', title: 'T', postAt: AT })
    expect(ev.description).toBe('')
    expect(ev.url).toBeUndefined()
  })
})

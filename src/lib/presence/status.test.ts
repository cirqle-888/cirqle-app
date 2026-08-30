import { describe, it, expect } from 'vitest'
import {
  derivePresence, resolveClearAfter, lastSeenLabel, isOnline, presenceTitle,
  ONLINE_WINDOW_MS, AWAY_WINDOW_MS,
  type PresenceRow,
} from './status'

const NOW = new Date('2026-08-31T10:00:00.000Z')   // Monday, 15:30 IST
const nowMs = NOW.getTime()

/** A row seen `agoMs` ago, with no manual pick unless overridden. */
function row(agoMs: number, over: Partial<PresenceRow> = {}): PresenceRow {
  return {
    employee_id: 'e1',
    manual_status: null,
    status_emoji: null,
    status_text: null,
    status_expires_at: null,
    last_seen_at: new Date(nowMs - agoMs).toISOString(),
    device: 'web',
    ...over,
  }
}

describe('derivePresence — the automatic half', () => {
  it('a fresh heartbeat is available', () => {
    expect(derivePresence(row(10_000), NOW).status).toBe('available')
  })

  it('goes away past the online window, offline past the away window', () => {
    expect(derivePresence(row(ONLINE_WINDOW_MS + 1_000), NOW).status).toBe('away')
    expect(derivePresence(row(AWAY_WINDOW_MS + 1_000), NOW).status).toBe('offline')
  })

  it('holds available right up to the boundary, not one ms past', () => {
    expect(derivePresence(row(ONLINE_WINDOW_MS), NOW).status).toBe('available')
    expect(derivePresence(row(ONLINE_WINDOW_MS + 1), NOW).status).toBe('away')
  })

  it('marks itself automatic so the UI can say "Active now" vs a chosen label', () => {
    expect(derivePresence(row(10_000), NOW).isAuto).toBe(true)
  })

  it('no row at all is offline, not a crash', () => {
    // Everyone who has not opened the app since this shipped has no row.
    const p = derivePresence(null, NOW, 'e9')
    expect(p.status).toBe('offline')
    expect(p.employeeId).toBe('e9')
  })

  it('a row with no last_seen_at is offline', () => {
    expect(derivePresence(row(0, { last_seen_at: null }), NOW).status).toBe('offline')
  })
})

describe('derivePresence — the manual half', () => {
  it('a pick wins over the automatic dot while the person is around', () => {
    const p = derivePresence(row(10_000, { manual_status: 'busy' }), NOW)
    expect(p.status).toBe('busy')
    expect(p.isAuto).toBe(false)
  })

  it('a pick stops speaking for someone who walked away', () => {
    // The whole point: a board full of people who look Busy and left at 6pm is
    // worse than no status at all.
    const p = derivePresence(row(AWAY_WINDOW_MS - 1_000, { manual_status: 'busy' }), NOW)
    expect(p.status).toBe('away')
    expect(p.isAuto).toBe(true)
    expect(p.manual).toBe('busy')   // the picker still shows what they chose
  })

  it('appear-offline outranks a live heartbeat', () => {
    const p = derivePresence(row(1_000, { manual_status: 'offline' }), NOW)
    expect(p.status).toBe('offline')
    expect(p.isAuto).toBe(false)
  })

  it('appear-offline leaks no last-seen time', () => {
    const p = derivePresence(row(1_000, { manual_status: 'offline' }), NOW)
    expect(lastSeenLabel(p, NOW)).toBeNull()
  })

  it('appear-away is honoured while active', () => {
    expect(derivePresence(row(1_000, { manual_status: 'away' }), NOW).status).toBe('away')
  })
})

describe('derivePresence — expiry', () => {
  const withNote = (expIso: string | null, ago = 1_000) =>
    row(ago, {
      manual_status: 'dnd', status_emoji: '🌴', status_text: 'On leave',
      status_expires_at: expIso,
    })

  it('an unexpired pick and its note both apply', () => {
    const p = derivePresence(withNote(new Date(nowMs + 60_000).toISOString()), NOW)
    expect(p.status).toBe('dnd')
    expect(p.note).toBe('On leave')
    expect(p.emoji).toBe('🌴')
  })

  it('an expired pick clears the dot AND the note', () => {
    const p = derivePresence(withNote(new Date(nowMs - 1).toISOString()), NOW)
    expect(p.status).toBe('available')  // back to the heartbeat
    expect(p.manual).toBeNull()
    expect(p.note).toBeNull()
    expect(p.emoji).toBeNull()
  })

  it('expiry is inclusive — a status due exactly now is gone', () => {
    const p = derivePresence(withNote(NOW.toISOString()), NOW)
    expect(p.manual).toBeNull()
  })

  it('a note survives the dot going stale — that is when it matters most', () => {
    const p = derivePresence(withNote(null, AWAY_WINDOW_MS + 1_000), NOW)
    expect(p.status).toBe('offline')
    expect(p.note).toBe('On leave')
  })
})

describe('resolveClearAfter', () => {
  it('never means never', () => {
    expect(resolveClearAfter('never', NOW)).toBeNull()
  })

  it('relative windows land where they say', () => {
    expect(resolveClearAfter('30m', NOW)).toBe(new Date(nowMs + 30 * 60_000).toISOString())
    expect(resolveClearAfter('1h', NOW)).toBe(new Date(nowMs + 60 * 60_000).toISOString())
    expect(resolveClearAfter('4h', NOW)).toBe(new Date(nowMs + 4 * 60 * 60_000).toISOString())
  })

  it('"today" ends at IST midnight, not UTC midnight', () => {
    // 2026-08-31 10:00Z is 15:30 IST on the 31st, so today ends at
    // 2026-09-01 00:00 IST = 2026-08-31 18:30Z.
    expect(resolveClearAfter('today', NOW)).toBe('2026-08-31T18:30:00.000Z')
  })

  it('"today" set late at night still means tonight, not last night', () => {
    // 2026-08-31 20:00Z = 01:30 IST on 1 Sep. Naive UTC maths would expire it
    // in the past; the business calendar puts it at the end of 1 Sep IST.
    const lateIst = new Date('2026-08-31T20:00:00.000Z')
    expect(resolveClearAfter('today', lateIst)).toBe('2026-09-01T18:30:00.000Z')
  })

  it('"this week" runs to next Monday IST', () => {
    // NOW is a Monday → the following Monday, 7 days out.
    expect(resolveClearAfter('week', NOW)).toBe('2026-09-06T18:30:00.000Z')
    // A Sunday → tomorrow.
    const sunday = new Date('2026-09-06T10:00:00.000Z')
    expect(resolveClearAfter('week', sunday)).toBe('2026-09-06T18:30:00.000Z')
  })

  it('every expiry it produces is in the future', () => {
    for (const id of ['30m', '1h', '4h', 'today', 'week'] as const) {
      expect(new Date(resolveClearAfter(id, NOW)!).getTime()).toBeGreaterThan(nowMs)
    }
  })
})

describe('lastSeenLabel', () => {
  it('says "Active now" for a live automatic dot', () => {
    expect(lastSeenLabel(derivePresence(row(1_000), NOW), NOW)).toBe('Active now')
  })

  it('names the chosen status instead when the dot was picked', () => {
    const p = derivePresence(row(1_000, { manual_status: 'dnd' }), NOW)
    expect(lastSeenLabel(p, NOW)).toBe('Do not disturb')
  })

  it('counts up in minutes, then hours, then days', () => {
    expect(lastSeenLabel(derivePresence(row(20 * 60_000), NOW), NOW)).toBe('Last seen 20m ago')
    expect(lastSeenLabel(derivePresence(row(3 * 3_600_000), NOW), NOW)).toBe('Last seen 3h ago')
    expect(lastSeenLabel(derivePresence(row(26 * 3_600_000), NOW), NOW)).toBe('Last seen yesterday')
    expect(lastSeenLabel(derivePresence(row(5 * 86_400_000), NOW), NOW)).toBe('Last seen 5d ago')
  })

  it('says nothing when there is nothing to say', () => {
    expect(lastSeenLabel(derivePresence(null, NOW), NOW)).toBeNull()
  })
})

describe('isOnline / presenceTitle', () => {
  it('every "around" state counts as online', () => {
    expect(['available', 'busy', 'dnd', 'brb'].every(s => isOnline(s as never))).toBe(true)
    expect(isOnline('away')).toBe(false)
    expect(isOnline('offline')).toBe(false)
  })

  it('the tooltip carries the note when there is one', () => {
    const p = derivePresence(row(1_000, {
      manual_status: 'busy', status_emoji: '🎧', status_text: 'In a call',
    }), NOW)
    expect(presenceTitle(p, NOW)).toBe('Busy — 🎧 In a call')
  })

  it('the tooltip degrades to status + last seen without a note', () => {
    expect(presenceTitle(derivePresence(row(20 * 60_000), NOW), NOW))
      .toBe('Offline · Last seen 20m ago')
  })
})

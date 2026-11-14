import { describe, it, expect } from 'vitest'
import {
  alertTargets, canSeeChat, chatsInQuestion, daysBetween, latestReports, messageText, normalizeReport, parseAccess,
  parseItems, pendingLines, serializeAccess, transcript, visibleChatIds, waitingChats, weeklyDigest,
  type ChatAccess, type LastMessage, type PendingItem,
} from './insights'

const admin = { isAdmin: true, employeeId: 'a', canViewRequests: true }
const staff = (id: string, requests = true) => ({ isAdmin: false, employeeId: id, canViewRequests: requests })
const access = (a: Partial<ChatAccess>): ChatAccess => ({ owner: null, viewers: [], everyone: false, ...a })

describe('who may see a chat', () => {
  it('is admins only until someone shares it', () => {
    expect(canSeeChat(admin, undefined)).toBe(true)
    expect(canSeeChat(staff('e1'), undefined)).toBe(false)
    expect(canSeeChat(null, access({ everyone: true }))).toBe(false)
  })

  it('lets in the responsible person and the people it is shared with', () => {
    const a = access({ owner: 'e1', viewers: ['e2'] })
    expect(canSeeChat(staff('e1', false), a)).toBe(true)
    expect(canSeeChat(staff('e2', false), a)).toBe(true)
    expect(canSeeChat(staff('e3'), a)).toBe(false)
  })

  it('"everyone" still needs the Requests inbox', () => {
    expect(canSeeChat(staff('e3'), access({ everyone: true }))).toBe(true)
    expect(canSeeChat(staff('e3', false), access({ everyone: true }))).toBe(false)
  })

  it('filters the chat list per person', () => {
    const all = { g1: access({ owner: 'e1' }), g2: access({ everyone: true }) }
    expect([...visibleChatIds(staff('e1'), ['g1', 'g2', 'g3'], all)]).toEqual(['g1', 'g2'])
    expect([...visibleChatIds(staff('e9', false), ['g1', 'g2', 'g3'], all)]).toEqual([])
    expect(visibleChatIds(admin, ['g1', 'g2', 'g3'], all).size).toBe(3)
  })

  it('reads and writes the settings text, ignoring junk', () => {
    expect(parseAccess('not json')).toEqual({})
    expect(parseAccess('{"g1":{"owner":"e1","viewers":["e2","e2",5],"everyone":"yes"},"g2":7}'))
      .toEqual({ g1: { owner: 'e1', viewers: ['e2'], everyone: false } })
    // Defaults and chats no longer listed are not stored.
    const text = serializeAccess({ g1: access({ owner: 'e1' }), g2: access({}), gone: access({ everyone: true }) }, ['g1', 'g2'])
    expect(JSON.parse(text)).toEqual({ g1: { owner: 'e1', viewers: [], everyone: false } })
  })
})

describe('what the AI reads', () => {
  it('turns a voice note or photo into text when its words are known', () => {
    expect(messageText({ type: 'ptt', body: null, media_text: 'flyer venam' })).toBe('[Voice note] flyer venam')
    expect(messageText({ type: 'image', body: 'new prices', media_text: null })).toBe('[Photo, not turned into text]\nnew prices')
    expect(messageText({ type: 'text', body: ' hello ', media_text: 'ignored' })).toBe('hello')
  })

  it('marks each line as client or Cirqle and drops the oldest when too long', () => {
    const m = (i: number, fromCirqle: boolean) => ({
      sent_at: new Date(Date.UTC(2026, 10, 14, 5, i)).toISOString(), sender_name: fromCirqle ? 'Safoora' : 'Rashid',
      sender_phone: null, from_cirqle: fromCirqle, type: 'text', body: `message ${i}`,
    })
    const text = transcript([m(1, false), m(2, true)])
    expect(text.split('\n')[0]).toMatch(/\| CLIENT Rashid: message 1$/)
    expect(text.split('\n')[1]).toMatch(/\| CIRQLE Safoora: message 2$/)
    const short = transcript(Array.from({ length: 50 }, (_, i) => m(i, false)), 200)
    expect(short).toContain('message 49')
    expect(short).not.toContain('message 0\n')
  })
})

describe('the report', () => {
  const before: PendingItem[] = [{ id: 'old1', text: 'Send Onam flyer', waitingOn: 'cirqle', who: null, since: '2026-11-10' }]
  let n = 0
  const opts = { today: '2026-11-14', newId: () => `new${++n}` }

  it('keeps an earlier item with its id and day, and gives new ones a fresh id', () => {
    n = 0
    const r = normalizeReport({
      summary: ' Client asked   for a banner. ',
      items: [
        { id: 'old1', text: 'Send Onam flyer', waitingOn: 'cirqle', who: 'null' },
        { text: 'Approve banner draft', waitingOn: 'client', who: 'Safoora' },
        { id: 'made-up', text: 'Banner 3x6 ft by Friday', waitingOn: 'something' },
        { text: '   ' },
      ],
    }, before, opts)
    expect(r.summary).toBe('Client asked for a banner.')
    expect(r.items.map(i => [i.id, i.waitingOn, i.who, i.since])).toEqual([
      ['old1', 'cirqle', null, '2026-11-10'],
      ['new1', 'client', 'Safoora', '2026-11-14'],
      ['new2', 'cirqle', null, '2026-11-14'],
    ])
    expect(r.newIds).toEqual(['new1', 'new2'])
  })

  it('does not let the AI use one earlier id twice', () => {
    n = 0
    const r = normalizeReport({ items: [{ id: 'old1', text: 'a' }, { id: 'old1', text: 'b' }] }, before, opts)
    expect(r.items.map(i => i.id)).toEqual(['old1', 'new1'])
  })

  it('survives a useless answer', () => {
    expect(normalizeReport(null, before, opts)).toEqual({ summary: '', items: [], newIds: [] })
    expect(parseItems('nope')).toEqual([])
    expect(parseItems([{ id: 'x', text: 'ok' }, { text: 'no id' }])).toHaveLength(1)
  })
})

describe('who gets told', () => {
  const employees = [{ id: 'e1', name: 'Safoora K' }, { id: 'e2', name: 'Sheya P' }, { id: 'e3', name: 'Sheya M' }]

  it('tells the person named in the chat when the name is one clear employee', () => {
    expect(alertTargets({ who: 'safoora' }, access({ owner: 'e2' }), employees)).toEqual(['e1'])
  })

  it('falls back to the responsible person when the name is unclear or missing', () => {
    expect(alertTargets({ who: 'Sheya' }, access({ owner: 'e2' }), employees)).toEqual(['e2'])
    expect(alertTargets({ who: null }, access({ owner: 'e2' }), employees)).toEqual(['e2'])
  })

  it('names nobody when the chat has no responsible person (the admins are told)', () => {
    expect(alertTargets({ who: null }, undefined, employees)).toEqual([])
  })
})

describe('the pending list', () => {
  it('takes each chat\'s newest report and lists the longest wait first', () => {
    const item = (id: string, since: string, waitingOn = 'cirqle') => ({ id, text: id, waitingOn, who: null, since })
    const latest = latestReports([
      { chat_id: 'g1', report_day: '2026-11-12', items: [item('stale', '2026-11-01')] },
      { chat_id: 'g1', report_day: '2026-11-14', items: [item('a', '2026-11-13')] },
      { chat_id: 'g2', report_day: '2026-11-13', items: [item('b', '2026-11-10', 'client')] },
    ])
    const lines = pendingLines(latest, '2026-11-14')
    expect(lines.map(l => [l.id, l.chatId, l.days])).toEqual([['b', 'g2', 4], ['a', 'g1', 1]])
    expect(daysBetween('2026-11-14', '2026-11-10')).toBe(0)
  })
})

describe('which chats a question is about', () => {
  const chats = [
    { chatId: 'g1', title: 'Sea Star@Cirqle', client: 'Sea Star Supermarket' },
    { chatId: 'g2', title: 'Zaiwa Nuts - Cirqle', client: '' },
    { chatId: 'g3', title: 'Creative Cirqle', client: '' },
  ]

  it('matches on the client or group name, not on words every chat has', () => {
    expect(chatsInQuestion('what is the current situation with sea star?', chats)).toEqual(['g1'])
    expect(chatsInQuestion('anything pending for zaiwa', chats)).toEqual(['g2'])
    expect(chatsInQuestion('what is pending in cirqle today', chats)).toEqual([])
  })
})

describe('clients still waiting for a reply', () => {
  const NOW = Date.parse('2026-11-14T14:00:00Z')
  const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString()
  const msg = (chat: string, id: string, hoursAgo: number, fromCirqle: boolean, body = 'Poster ayo', type = 'text'): LastMessage =>
    ({ chat_id: chat, message_id: id, from_cirqle: fromCirqle, type, body, sent_at: at(hoursAgo) })

  it('finds a chat where the client spoke last, and counts from the first unanswered message', () => {
    const out = waitingChats([msg('a', 'm3', 3, false), msg('a', 'm2', 5, false), msg('a', 'm1', 6, true)], NOW)
    expect(out).toEqual([{ chatId: 'a', messageId: 'm2', since: at(5), hours: 5 }])
  })
  it('leaves a chat alone once Cirqle has answered', () => {
    expect(waitingChats([msg('a', 'm2', 1, true), msg('a', 'm1', 5, false)], NOW)).toEqual([])
  })
  it('does not chase a closing "ok" or a thumbs-up', () => {
    expect(waitingChats([msg('a', 'm1', 5, false, 'Ok')], NOW)).toEqual([])
    expect(waitingChats([msg('a', 'm1', 5, false, '👍')], NOW)).toEqual([])
  })
  it('counts a voice note or photo as something to answer', () => {
    expect(waitingChats([msg('a', 'm1', 5, false, '', 'voice')], NOW)).toHaveLength(1)
  })
  it('ignores what is too fresh or too old', () => {
    expect(waitingChats([msg('a', 'm1', 1, false)], NOW)).toEqual([])
    expect(waitingChats([msg('a', 'm1', 100, false)], NOW)).toEqual([])
  })
  it('puts the longest wait first', () => {
    expect(waitingChats([msg('a', 'm1', 3, false), msg('b', 'm2', 9, false)], NOW).map(w => w.chatId)).toEqual(['b', 'a'])
  })
})

describe('the Monday note', () => {
  const title = (id: string) => ({ a: 'Sea Star', b: 'Bismi' } as Record<string, string>)[id] || id
  const item = (waitingOn: 'cirqle' | 'client', since: string) => ({ id: since + waitingOn, text: 't', waitingOn, who: '', since })
  it('says how busy the week was and what is open', () => {
    const text = weeklyDigest(
      [{ chat_id: 'a', message_count: 40 }, { chat_id: 'a', message_count: 10 }, { chat_id: 'b', message_count: 5 }],
      new Map([['a', { items: [item('cirqle', '2026-11-10'), item('client', '2026-11-13')] }]]),
      '2026-11-16', title,
    )
    expect(text).toContain('55 messages in 2 chats')
    expect(text).toContain('Busiest: Sea Star (50), Bismi (5).')
    expect(text).toContain('Waiting on Cirqle: 1, the oldest for 6 days (Sea Star).')
    expect(text).toContain('Waiting on clients: 1.')
  })
  it('stays quiet when nothing happened', () => {
    expect(weeklyDigest([], new Map(), '2026-11-16', title)).toBeNull()
  })
})

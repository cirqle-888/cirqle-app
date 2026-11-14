import { describe, expect, it } from 'vitest'
import { parseEnvelope, type ListenerMessage } from './rules'
import {
  chatDisplayName, chatLogRow, chatMedia, chatSummaries, groupByDay, indiaDay, isChatEvent, isMissingTable, messagePreview, senderLabel,
} from './chat-log'

const GROUP = '120363021234567890@g.us'
const NOW = Date.parse('2026-11-14T10:00:00Z')

function msg(data: Record<string, unknown> = {}, event = 'message.received'): ListenerMessage {
  return parseEnvelope({
    event, sessionId: 'desk', timestamp: '2026-11-14T09:59:00.000Z',
    data: {
      id: 'MSG1', from: GROUP, chatId: GROUP, body: 'Need Friday offer flyer', type: 'text', timestamp: 1794650000,
      isGroup: true, fromMe: false, author: '919876543210@c.us', contact: { pushName: 'Rahul' }, ...data,
    },
  }) as ListenerMessage
}
const plain = { fromCirqle: false, mediaPath: null, mediaMime: null, mediaNote: null, nowMs: NOW }

describe('what a chat is called', () => {
  it('uses the client name, else the group name without "@Cirqle"', () => {
    expect(chatDisplayName('Sea Star@Cirqle', 'Sea Star Supermarket', 'a@g.us')).toBe('Sea Star Supermarket')
    expect(chatDisplayName('Al Nahda@Cirqle', '', 'a@g.us')).toBe('Al Nahda')
    expect(chatDisplayName('Zaiwa Nuts @ cirqle ', null, 'a@g.us')).toBe('Zaiwa Nuts')
    expect(chatDisplayName('Accounts Cirqle', '', 'a@g.us')).toBe('Accounts Cirqle')
    expect(chatDisplayName('', '', 'a@g.us')).toBe('a@g.us')
  })
})

describe('chat log rows', () => {
  it('reads when a message was sent, in seconds, milliseconds or from the delivery time', () => {
    expect(msg().sentAtMs).toBe(1794650000000)
    expect(msg({ timestamp: 1794650000123 }).sentAtMs).toBe(1794650000123)
    expect(msg({ timestamp: undefined }).sentAtMs).toBe(Date.parse('2026-11-14T09:59:00.000Z'))
  })

  it('keeps a client text message with who sent it and when', () => {
    expect(chatLogRow(msg(), plain)).toEqual({
      message_id: 'MSG1', chat_id: GROUP, is_group: true, sender_id: '919876543210@c.us', sender_name: 'Rahul',
      sender_phone: '9876543210', from_cirqle: false, type: 'text', body: 'Need Friday offer flyer',
      media_path: null, media_mime: null, media_note: null, sent_at: new Date(1794650000000).toISOString(),
    })
  })

  it('marks Cirqle messages: our own number, a sent event, or a known Cirqle sender', () => {
    expect(chatLogRow(msg({ fromMe: true }), plain)?.from_cirqle).toBe(true)
    expect(chatLogRow(msg({}, 'message.sent'), plain)?.from_cirqle).toBe(true)
    expect(chatLogRow(msg(), { ...plain, fromCirqle: true })?.from_cirqle).toBe(true)
  })

  it('skips what is not a chat message, and uses now when the clock is wrong', () => {
    expect(chatLogRow(msg({}, 'session.status'), plain)).toBeNull()
    expect(chatLogRow(msg({ type: 'sticker' }), plain)).toBeNull()
    expect(chatLogRow(msg({ body: '   ' }), plain)).toBeNull()
    expect(isChatEvent('message.received') && isChatEvent('message.sent')).toBe(true)
    expect(isChatEvent('message.ack')).toBe(false)
    const future = chatLogRow(msg({ timestamp: (NOW + 86_400_000) / 1000 }), plain)
    expect(future?.sent_at).toBe(new Date(NOW).toISOString())
  })

  it('keeps a voice note with no text, and records the file or why there is none', () => {
    const audio = Buffer.from('fake-ogg').toString('base64')
    const voice = msg({ type: 'ptt', body: '', media: { mimetype: 'audio/ogg; codecs=opus', filename: 'v.ogg', data: audio } })
    const media = chatMedia(voice)
    expect(media.file).toMatchObject({ mime: 'audio/ogg', kind: 'audio' })
    expect(Buffer.from(media.file!.bytes).toString()).toBe('fake-ogg')
    expect(chatLogRow(voice, { ...plain, mediaPath: 'whatsapp-chat/x.ogg', mediaMime: 'audio/ogg', mediaNote: 'ignored' }))
      .toMatchObject({ type: 'ptt', body: null, media_path: 'whatsapp-chat/x.ogg', media_mime: 'audio/ogg', media_note: null })

    const omitted = msg({ type: 'image', body: '', media: { mimetype: 'image/jpeg', filename: 'p.jpg', omitted: true } })
    expect(chatMedia(omitted)).toEqual({ file: null, note: 'Photo not passed on by the gateway. Open WhatsApp to see it.' })
    expect(chatLogRow(omitted, { ...plain, mediaNote: chatMedia(omitted).note })?.media_note).toMatch(/not passed on/)
    expect(chatMedia(msg())).toEqual({ file: null, note: null })
  })
})

describe('showing chats', () => {
  it('previews and labels messages', () => {
    expect(messagePreview({ type: 'text', body: 'Hello\n  there' })).toBe('Hello there')
    expect(messagePreview({ type: 'image', body: null })).toBe('Photo')
    expect(messagePreview({ type: 'image', body: 'price list' })).toBe('Photo: price list')
    expect(messagePreview({ type: 'ptt', body: null })).toBe('Voice note')
    expect(senderLabel({ from_cirqle: false, sender_name: 'Rahul', sender_phone: '9876543210' })).toBe('Rahul')
    expect(senderLabel({ from_cirqle: false, sender_name: null, sender_phone: '9876543210' })).toBe('…3210')
    expect(senderLabel({ from_cirqle: true, sender_name: null, sender_phone: null })).toBe('Cirqle')
  })

  it('lists every allowed chat, latest activity first, quiet chats last in list order', () => {
    const groups = new Map([['a@g.us', 'Sea Star'], ['b@g.us', ''], ['c@g.us', 'Elmido'], ['d@g.us', 'Goodwill']])
    const out = chatSummaries(groups, { 'a@g.us': 'Sea Star@Cirqle', 'b@g.us': ' ' }, [
      { chat_id: 'c@g.us', sent_at: '2026-11-14T09:00:00Z', type: 'ptt', body: null, from_cirqle: false },
      { chat_id: 'a@g.us', sent_at: '2026-11-14T08:00:00Z', type: 'text', body: 'ok done', from_cirqle: true },
      { chat_id: 'c@g.us', sent_at: '2026-11-13T08:00:00Z', type: 'text', body: 'older', from_cirqle: false },
      { chat_id: 'zzz@g.us', sent_at: '2026-11-14T09:30:00Z', type: 'text', body: 'not listed', from_cirqle: false },
    ])
    expect(out.map(c => [c.chatId, c.title, c.lastPreview, c.lastFromCirqle])).toEqual([
      ['c@g.us', 'Elmido', 'Voice note', false],
      ['a@g.us', 'Sea Star', 'ok done', true],
      ['b@g.us', 'b@g.us', '', false],
      ['d@g.us', 'Goodwill', '', false],
    ])
  })

  it('splits a chat into India calendar days, whatever the server timezone', () => {
    // 19:00 UTC is 00:30 the next day in India.
    expect(indiaDay('2026-11-13T19:00:00Z')).toBe('2026-11-14')
    expect(indiaDay('2026-11-13T18:00:00Z')).toBe('2026-11-13')
    const days = groupByDay([{ sent_at: '2026-11-13T18:00:00Z' }, { sent_at: '2026-11-13T19:00:00Z' }, { sent_at: '2026-11-14T05:00:00Z' }])
    expect(days.map(d => [d.day, d.messages.length])).toEqual([['2026-11-13', 1], ['2026-11-14', 2]])
  })

  it('recognises the missing-table error from before the migration', () => {
    expect(isMissingTable({ code: 'PGRST205', message: '' })).toBe(true)
    expect(isMissingTable({ code: '42P01' })).toBe(true)
    expect(isMissingTable({ code: '23505', message: 'duplicate key' })).toBe(false)
    expect(isMissingTable(null)).toBe(false)
  })
})

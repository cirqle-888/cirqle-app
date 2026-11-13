import { createHmac } from 'crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  addSeen, appendedDescription, decide, isAcknowledgement, isCapturableType, listenerEnabled, parseEnvelope,
  parseGroupList, parseSeen, verifySignature, MAX_SEEN, type ListenerMessage,
  aiFilterOn, isBadSessionStatus, listenerHealth, parseSessionStatus, shouldWriteHeard, LISTENER_SERVER_KEYS, SILENT_AFTER_HOURS,
} from './rules'
import { handleListenerMessage, type ListenerDeps } from './handle'

const GROUP = '120363021234567890@g.us'

function envelope(data: Record<string, unknown> = {}, event = 'message.received') {
  return {
    event, timestamp: '2026-11-10T09:00:00.000Z', sessionId: 'desk', idempotencyKey: 'msg_desk_X_1', deliveryId: 'dlv_1',
    data: {
      id: 'MSG1', from: GROUP, to: '919000000001@c.us', chatId: GROUP, body: 'Need Friday offer flyer, 20 products',
      type: 'text', timestamp: 1794300000, isGroup: true, fromMe: false, kind: 'group',
      author: '919876543210@c.us', contact: { pushName: 'Rahul' }, ...data,
    },
  }
}
const msg = (data: Record<string, unknown> = {}, event?: string): ListenerMessage => parseEnvelope(envelope(data, event)) as ListenerMessage

describe('signature', () => {
  const body = JSON.stringify(envelope())
  const sign = (secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

  it('accepts only the exact HMAC of the raw body', () => {
    expect(verifySignature(body, sign('correct-secret-000'), 'correct-secret-000')).toBe(true)
    expect(verifySignature(body, sign('another-secret-000'), 'correct-secret-000')).toBe(false)
    expect(verifySignature(body + ' ', sign('correct-secret-000'), 'correct-secret-000')).toBe(false)
    expect(verifySignature(body, 'sha256=short', 'correct-secret-000')).toBe(false)
    expect(verifySignature(body, null, 'correct-secret-000')).toBe(false)
    expect(verifySignature(body, sign(''), '')).toBe(false)
  })
})

describe('reading a delivery', () => {
  it('reads a group text message', () => {
    expect(msg()).toMatchObject({
      event: 'message.received', sessionId: 'desk', id: 'MSG1', chatId: GROUP, isGroup: true, fromMe: false, type: 'text',
      body: 'Need Friday offer flyer, 20 products', senderId: '919876543210@c.us', senderPhone: '9876543210', senderName: 'Rahul', media: null,
    })
  })

  it('reads media, and knows when the bytes were left out', () => {
    expect(msg({ type: 'voice', body: '', media: { mimetype: 'audio/ogg; codecs=opus', data: 'AAAA' } }).media)
      .toEqual({ mimetype: 'audio/ogg; codecs=opus', filename: '', dataBase64: 'AAAA', omitted: false })
    expect(msg({ type: 'image', media: { mimetype: 'image/jpeg', omitted: true, sizeBytes: 9_000_000 } }).media)
      .toMatchObject({ dataBase64: null, omitted: true })
  })

  it('uses senderPhone for hidden-number senders and gives no phone when there is none', () => {
    expect(msg({ author: '12345678901234@lid', senderPhone: '919811122233' }).senderPhone).toBe('9811122233')
    expect(msg({ author: '12345678901234@lid' }).senderPhone).toBe('')
  })

  it('reads a direct chat and rejects junk', () => {
    const direct = msg({ chatId: '919876543210@c.us', from: '919876543210@c.us', isGroup: false, kind: 'individual', author: undefined })
    expect(direct).toMatchObject({ isGroup: false, senderId: '919876543210@c.us' })
    expect(parseEnvelope(null)).toBeNull()
    expect(parseEnvelope({ event: 'test' })).toBeNull()
    expect(parseEnvelope('message')).toBeNull()
  })
})

describe('settings', () => {
  it('is off unless switched on', () => {
    expect(listenerEnabled({})).toBe(false)
    expect(listenerEnabled({ whatsapp_listener_enabled: 'On' })).toBe(true)
    expect(listenerEnabled({ whatsapp_listener_enabled: 'off' })).toBe(false)
  })

  it('parses the allow-list and ignores anything that is not a chat id', () => {
    const map = parseGroupList(`# client groups\n${GROUP} = Sea Star Supermarket\n\n919876543210@c.us=Goodwill\n120363099@g.us\nnot a chat = Nobody\nhttps://chat.whatsapp.com/abc = X`)
    expect([...map.entries()]).toEqual([[GROUP, 'Sea Star Supermarket'], ['919876543210@c.us', 'Goodwill'], ['120363099@g.us', '']])
    expect(parseGroupList(null).size).toBe(0)
  })

  it('keeps a short list of unlisted chats, newest first, with no content', () => {
    let seen = parseSeen('not json')
    expect(seen).toEqual({})
    for (let i = 0; i < MAX_SEEN + 5; i++) seen = addSeen(seen, `g${i}@g.us`, 'Someone With A Very Long Display Name That Goes On', `2026-11-10T09:${String(i).padStart(2, '0')}:00Z`)
    expect(Object.keys(seen)).toHaveLength(MAX_SEEN)
    expect(seen['g0@g.us']).toBeUndefined()
    expect(seen[`g${MAX_SEEN + 4}@g.us`].by).toHaveLength(40)
  })
})

describe('acknowledgements and types', () => {
  it('recognises replies that carry no request', () => {
    for (const t of ['ok', 'OK!', 'Thanks 🙏', '👍', '👍👍', 'thank you', 'ശരി', 'Okay.', '', '...']) expect(isAcknowledgement(t), t).toBe(true)
    for (const t of ['ok change the price to 45', 'need flyer', '45', 'ഓണം ഓഫർ flyer വേണം', 'done the payment, send invoice']) expect(isAcknowledgement(t), t).toBe(false)
  })

  it('only captures text, voice and photos', () => {
    for (const t of ['text', 'image', 'voice', 'audio']) expect(isCapturableType(t)).toBe(true)
    for (const t of ['sticker', 'video', 'document', 'revoked', 'poll', 'call', 'location', 'unknown']) expect(isCapturableType(t)).toBe(false)
  })
})

describe('decision', () => {
  const base = { enabled: true, message: msg(), listed: true, fromStaff: false, duplicate: false, hasRecentRequest: false, looksLikeRequest: true as boolean | null }

  it('ignores for each reason, in order', () => {
    expect(decide({ ...base, enabled: false })).toEqual({ action: 'ignore', reason: 'disabled' })
    expect(decide({ ...base, message: msg({}, 'message.sent') })).toEqual({ action: 'ignore', reason: 'not-a-message' })
    expect(decide({ ...base, message: msg({ fromMe: true }) })).toEqual({ action: 'ignore', reason: 'from-us' })
    expect(decide({ ...base, listed: false })).toEqual({ action: 'ignore', reason: 'not-listed' })
    expect(decide({ ...base, message: msg({ type: 'sticker' }) })).toEqual({ action: 'ignore', reason: 'type' })
    expect(decide({ ...base, fromStaff: true })).toEqual({ action: 'ignore', reason: 'staff' })
    expect(decide({ ...base, duplicate: true })).toEqual({ action: 'ignore', reason: 'duplicate' })
    expect(decide({ ...base, message: msg({ body: 'ok thanks' }) })).toEqual({ action: 'ignore', reason: 'acknowledgement' })
    expect(decide({ ...base, looksLikeRequest: false })).toEqual({ action: 'ignore', reason: 'not-a-request' })
  })

  it('files when it looks like a request or the AI could not tell', () => {
    expect(decide(base)).toEqual({ action: 'file' })
    expect(decide({ ...base, looksLikeRequest: null })).toEqual({ action: 'file' })
  })

  it('always captures voice notes and photos, and appends follow-ups', () => {
    expect(decide({ ...base, message: msg({ type: 'voice', body: '' }), looksLikeRequest: false })).toEqual({ action: 'file' })
    expect(decide({ ...base, hasRecentRequest: true, looksLikeRequest: false })).toEqual({ action: 'append' })
    // An "ok" never joins a request, even right after one.
    expect(decide({ ...base, hasRecentRequest: true, message: msg({ body: 'ok' }) })).toEqual({ action: 'ignore', reason: 'acknowledgement' })
  })

  it('marks appended text as later', () => {
    expect(appendedDescription('From WhatsApp\n\nFirst', 'Second')).toBe('From WhatsApp\n\nFirst\n\n— later —\nSecond')
    expect(appendedDescription('First', '  ')).toBe('First')
  })
})

describe('handling a message', () => {
  function deps(over: Partial<ListenerDeps> = {}) {
    const d = {
      enabled: true,
      groups: new Map([[GROUP, 'Sea Star Supermarket']]),
      isStaffPhone: vi.fn(async () => false),
      isDuplicate: vi.fn(async () => false),
      recentRequest: vi.fn(async () => null),
      looksLikeRequest: vi.fn(async () => true as boolean | null),
      transcribe: vi.fn(async () => 'Weekend offer list, 12 items'),
      readImage: vi.fn(async () => null),
      store: vi.fn(async () => 'https://store.example/original'),
      parse: vi.fn(async () => ({ title: 'Friday offer flyer', client: 'Wrong Guess', service: 'Offer Flyer' })),
      file: vi.fn(async (r: { title: string; client?: string }) => ({ ok: true, id: 'req-1', ref: 'REQ-0080', title: r.title, client: r.client ?? null })),
      append: vi.fn(async () => true),
      logMessage: vi.fn(async () => {}),
      recordSeen: vi.fn(async () => {}),
      notify: vi.fn(async () => {}),
      ...over,
    }
    return d as typeof d & ListenerDeps
  }

  it('files a request from a listed group, with the client from the allow-list', async () => {
    const d = deps()
    expect(await handleListenerMessage(msg(), d)).toEqual({ result: 'filed', ref: 'REQ-0080' })
    const filed = d.file.mock.calls[0][0] as { client: string; notes: string; title: string }
    expect(filed.client).toBe('Sea Star Supermarket')
    expect(filed.title).toBe('Friday offer flyer')
    expect(filed.notes.split('\n')[0]).toBe('From WhatsApp · Sea Star Supermarket group · sent by Rahul')
    expect(d.logMessage).toHaveBeenCalledWith('req-1', expect.objectContaining({ id: 'MSG1' }), 'Need Friday offer flyer, 20 products')
    expect(d.notify).toHaveBeenCalledTimes(1)
  })

  it('does nothing and looks nothing up when switched off', async () => {
    const d = deps({ enabled: false })
    expect(await handleListenerMessage(msg(), d)).toEqual({ result: 'ignored', reason: 'disabled' })
    expect(d.isDuplicate).not.toHaveBeenCalled()
    expect(d.recordSeen).not.toHaveBeenCalled()
  })

  it('never reads an unlisted chat: it only notes that the chat exists', async () => {
    const d = deps({ groups: new Map() })
    expect(await handleListenerMessage(msg(), d)).toEqual({ result: 'ignored', reason: 'not-listed' })
    expect(d.recordSeen).toHaveBeenCalledWith(GROUP, 'Rahul')
    for (const f of [d.looksLikeRequest, d.parse, d.store, d.transcribe, d.file, d.isStaffPhone]) expect(f).not.toHaveBeenCalled()
  })

  it('skips staff, duplicates, chatter and our own messages', async () => {
    expect(await handleListenerMessage(msg(), deps({ isStaffPhone: vi.fn(async () => true) }))).toEqual({ result: 'ignored', reason: 'staff' })
    expect(await handleListenerMessage(msg(), deps({ isDuplicate: vi.fn(async () => true) }))).toEqual({ result: 'ignored', reason: 'duplicate' })
    expect(await handleListenerMessage(msg(), deps({ looksLikeRequest: vi.fn(async () => false) }))).toEqual({ result: 'ignored', reason: 'not-a-request' })
    expect(await handleListenerMessage(msg({ fromMe: true }), deps())).toEqual({ result: 'ignored', reason: 'from-us' })
    const d = deps()
    expect(await handleListenerMessage(msg({ body: '👍' }), d)).toEqual({ result: 'ignored', reason: 'acknowledgement' })
    expect(d.looksLikeRequest).not.toHaveBeenCalled()
  })

  it('transcribes a voice note without asking whether it is a request', async () => {
    const d = deps()
    const voice = msg({ id: 'V1', type: 'voice', body: '', media: { mimetype: 'audio/ogg; codecs=opus', data: Buffer.from('fake-ogg-bytes').toString('base64') } })
    expect(await handleListenerMessage(voice, d)).toEqual({ result: 'filed', ref: 'REQ-0080' })
    expect(d.looksLikeRequest).not.toHaveBeenCalled()
    expect(d.transcribe).toHaveBeenCalledWith(expect.anything(), 'voice-note.ogg')
    const filed = d.file.mock.calls[0][0] as { notes: string; extraLinks: unknown[] }
    expect(filed.notes).toContain('Voice note (transcribed by AI, check against the recording):\nWeekend offer list, 12 items')
    expect(filed.extraLinks).toEqual([{ label: 'WhatsApp voice note 1', url: 'https://store.example/original' }])
  })

  it('says so when the gateway did not pass the media on', async () => {
    const d = deps({ parse: vi.fn(async () => ({})) })
    await handleListenerMessage(msg({ type: 'image', body: '', media: { mimetype: 'image/jpeg', omitted: true } }), d)
    const filed = d.file.mock.calls[0][0] as { notes: string; title: string }
    expect(filed.notes).toContain('A photo was sent but the gateway did not pass it on. Open the WhatsApp chat to see it.')
    expect(d.store).not.toHaveBeenCalled()
  })

  it('adds a follow-up to the same person\'s recent request instead of filing another', async () => {
    const recent = { id: 'req-1', ref: 'REQ-0080', description: 'From WhatsApp · Sea Star Supermarket group · sent by Rahul\n\nNeed Friday offer flyer', extraLinks: [{ label: 'WhatsApp photo 1', url: 'u1' }] }
    const d = deps({ recentRequest: vi.fn(async () => recent) })
    const photo = msg({ id: 'P2', type: 'image', body: 'price list', media: { mimetype: 'image/jpeg', data: Buffer.from('jpg').toString('base64') } })
    expect(await handleListenerMessage(photo, d)).toEqual({ result: 'appended', ref: 'REQ-0080' })
    expect(d.file).not.toHaveBeenCalled()
    expect(d.notify).not.toHaveBeenCalled()
    const change = d.append.mock.calls[0][1] as { description: string; extraLinks: { label: string }[] }
    expect(change.description).toContain('Need Friday offer flyer\n\n— later —\n')
    expect(change.description).toContain('price list')
    expect(change.description.match(/From WhatsApp/g)).toHaveLength(1)
    expect(change.extraLinks.map(l => l.label)).toEqual(['WhatsApp photo 1', 'WhatsApp photo 2'])
    expect(d.logMessage).toHaveBeenCalledWith('req-1', expect.objectContaining({ id: 'P2' }), expect.any(String))
  })

  it('reports a failure instead of pretending', async () => {
    expect(await handleListenerMessage(msg(), deps({ file: vi.fn(async () => ({ ok: false, error: 'db down' })) }))).toEqual({ result: 'failed', error: 'db down' })
    const recent = { id: 'req-1', ref: 'REQ-0080', description: 'x', extraLinks: [] }
    expect(await handleListenerMessage(msg(), deps({ recentRequest: vi.fn(async () => recent), append: vi.fn(async () => false) })))
      .toEqual({ result: 'failed', error: 'Could not add the message to REQ-0080.' })
  })

  it('still files when lookups or AI steps throw', async () => {
    const d = deps({
      isStaffPhone: vi.fn(async () => { throw new Error('x') }),
      isDuplicate: vi.fn(async () => { throw new Error('x') }),
      recentRequest: vi.fn(async () => { throw new Error('x') }),
      looksLikeRequest: vi.fn(async () => { throw new Error('x') }),
      parse: vi.fn(async () => { throw new Error('x') }),
    })
    expect(await handleListenerMessage(msg(), d)).toEqual({ result: 'filed', ref: 'REQ-0080' })
    expect((d.file.mock.calls[0][0] as { title: string }).title).toBe('Need Friday offer flyer, 20 products')
  })
})


describe('listener health', () => {
  const NOW = Date.parse('2026-11-10T09:00:00Z')
  const on = { whatsapp_listener_enabled: 'on', whatsapp_listener_groups: `${GROUP} = Sea Star Supermarket` }
  const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

  it('says nothing while it is off or has no chats', () => {
    expect(listenerHealth({}, NOW)).toEqual({ state: 'off' })
    expect(listenerHealth({ whatsapp_listener_enabled: 'on' }, NOW)).toEqual({ state: 'no-chats' })
  })

  it('reports never-heard, healthy and silent', () => {
    expect(listenerHealth(on, NOW)).toEqual({ state: 'never' })
    expect(listenerHealth({ ...on, whatsapp_listener_last_heard: 'garbage' }, NOW)).toEqual({ state: 'never' })
    expect(listenerHealth({ ...on, whatsapp_listener_last_heard: hoursAgo(3) }, NOW)).toEqual({ state: 'ok', hours: 3 })
    expect(listenerHealth({ ...on, whatsapp_listener_last_heard: hoursAgo(SILENT_AFTER_HOURS - 1) }, NOW).state).toBe('ok')
    expect(listenerHealth({ ...on, whatsapp_listener_last_heard: hoursAgo(SILENT_AFTER_HOURS) }, NOW)).toEqual({ state: 'silent', hours: 24 })
    expect(listenerHealth({ ...on, whatsapp_listener_last_heard: hoursAgo(50) }, NOW)).toEqual({ state: 'silent', hours: 50 })
  })

  it('rewrites the last-heard time at most every ten minutes', () => {
    expect(shouldWriteHeard({}, NOW)).toBe(true)
    expect(shouldWriteHeard({ whatsapp_listener_last_heard: new Date(NOW - 5 * 60_000).toISOString() }, NOW)).toBe(false)
    expect(shouldWriteHeard({ whatsapp_listener_last_heard: new Date(NOW - 11 * 60_000).toISOString() }, NOW)).toBe(true)
  })

  it('reads session events and knows which ones mean it stopped listening', () => {
    expect(parseSessionStatus({ event: 'session.status', data: { status: 'CONNECTED' } })).toBe('connected')
    expect(parseSessionStatus({ event: 'session.disconnected', data: {} })).toBe('disconnected')
    expect(parseSessionStatus({ event: 'message.received', data: { status: 'x' } })).toBeNull()
    expect(parseSessionStatus(null)).toBeNull()
    for (const s of ['disconnected', 'logged_out', 'LOGOUT', 'banned', 'restriction', 'failed', 'reconnect_loop']) expect(isBadSessionStatus(s), s).toBe(true)
    for (const s of ['connected', 'ready', 'authenticated', 'qr', 'starting']) expect(isBadSessionStatus(s), s).toBe(false)
  })

  it('keeps the AI filter on unless switched off, and marks which rows the server owns', () => {
    expect(aiFilterOn({})).toBe(true)
    expect(aiFilterOn({ whatsapp_listener_ai_filter: 'on' })).toBe(true)
    expect(aiFilterOn({ whatsapp_listener_ai_filter: 'Off' })).toBe(false)
    expect([...LISTENER_SERVER_KEYS].sort()).toEqual(['whatsapp_listener_last_heard', 'whatsapp_listener_seen', 'whatsapp_listener_session'])
  })
})

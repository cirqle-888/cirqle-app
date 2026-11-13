import { describe, expect, it, vi } from 'vitest'
import {
  buildDescription, captureFromWhatsApp, classifyPart, combinedText, fallbackTitle, looksLikeText, safeStorageName,
  transcriptionFileName, MAX_FILE_BYTES, type CaptureDeps, type SharedFile,
} from './whatsapp-capture'

const bytes = (n = 10) => new Uint8Array(n).fill(1).buffer
const file = (name: string, type: string, size = 10): SharedFile => ({ name, type, bytes: bytes(size) })

function deps(over: Partial<CaptureDeps> = {}): CaptureDeps & { filed: Parameters<CaptureDeps['file']>[0][] } {
  const filed: Parameters<CaptureDeps['file']>[0][] = []
  return {
    filed,
    transcribe: vi.fn(async () => 'Need a flyer for Friday offers'),
    readImage: vi.fn(async () => null),
    store: vi.fn(async (f: SharedFile) => `https://store.example/${f.name}`),
    parse: vi.fn(async () => ({ client: 'Sea Star', title: 'Friday offer flyer', service: 'Offer Flyer', dueDate: '2026-11-13' })),
    file: vi.fn(async r => { filed.push(r); return { ok: true, ref: 'REQ-0070', title: r.title, client: r.client ?? null, matchedClient: !!r.client } }),
    ...over,
  }
}

describe('classifying shared files', () => {
  it('recognises WhatsApp voice notes, photos and text', () => {
    expect(classifyPart('PTT-20261110-WA0003.opus', '')).toBe('audio')
    expect(classifyPart('PTT-20261110-WA0003.opus', 'application/octet-stream')).toBe('audio')
    expect(classifyPart('audio.m4a', 'audio/mp4')).toBe('audio')
    expect(classifyPart('IMG-20261110-WA0001.jpg', 'image/jpeg')).toBe('image')
    expect(classifyPart('photo.HEIC', '')).toBe('image')
    expect(classifyPart('chat.txt', 'text/plain')).toBe('text')
  })

  it('does not treat video or documents as something it can read', () => {
    expect(classifyPart('clip.mp4', 'video/mp4')).toBe('unsupported')
    expect(classifyPart('offer.pdf', 'application/pdf')).toBe('unsupported')
    expect(classifyPart('', '')).toBe('unsupported')
  })

  it('renames .opus so the transcription service accepts it', () => {
    expect(transcriptionFileName('PTT-20261110-WA0003.opus')).toBe('voice-note.ogg')
    expect(transcriptionFileName('')).toBe('voice-note.ogg')
    expect(transcriptionFileName('note.m4a')).toBe('voice-note.m4a')
  })

  it('makes storage-safe names', () => {
    expect(safeStorageName('PTT 2026/11 (1).opus', 'audio')).toBe('PTT-2026-11-1.opus')
    expect(safeStorageName('', 'image')).toBe('image.jpg')
    expect(safeStorageName('../../etc/passwd', 'audio')).toBe('etc-passwd.ogg')
  })
})

describe('text building', () => {
  it('labels each piece and says where it came from', () => {
    const d = buildDescription({
      group: 'Sea Star Offers', sender: 'Rahul', message: 'Urgent',
      parts: [
        { kind: 'audio', text: 'Flyer for Friday', unread: false, link: 'x' },
        { kind: 'image', text: null, unread: false, link: 'y' },
        { kind: 'audio', text: null, unread: true, link: 'z' },
      ],
    })
    expect(d.split('\n')[0]).toBe('From WhatsApp · Sea Star Offers · sent by Rahul')
    expect(d).toContain('Urgent')
    expect(d).toContain('Voice note (transcribed by AI, check against the recording):\nFlyer for Friday')
    expect(d).toContain('Photo attached.')
    expect(d).toContain('Voice note: could not be transcribed. Listen to the recording.')
  })

  it('combines text in order and falls back to a plain title', () => {
    expect(combinedText('Hello', [{ kind: 'audio', text: 'World', unread: false, link: null }])).toBe('Hello\nWorld')
    expect(fallbackTitle('', [{ kind: 'audio', text: null, unread: true, link: null }])).toBe('WhatsApp voice note — listen and add details')
    expect(fallbackTitle('', [{ kind: 'image', text: null, unread: false, link: null }])).toBe('WhatsApp photo — open and add details')
    expect(fallbackTitle('x'.repeat(120), [])).toHaveLength(78)
  })
})

describe('capture', () => {
  it('transcribes a voice note, keeps the original and files a request', async () => {
    const d = deps()
    const r = await captureFromWhatsApp({ group: 'Sea Star Offers', files: [file('PTT-1.opus', '')] }, d)
    expect(r).toMatchObject({ ok: true, ref: 'REQ-0070', title: 'Friday offer flyer', client: 'Sea Star', heard: 'Need a flyer for Friday offers', needsListening: false })
    expect(d.transcribe).toHaveBeenCalledWith(expect.anything(), 'voice-note.ogg')
    expect(d.filed[0]).toMatchObject({ service: 'Offer Flyer', dueDate: '2026-11-13', extraLinks: [{ label: 'WhatsApp voice note 1', url: 'https://store.example/PTT-1.opus' }] })
    expect(d.filed[0].notes).toContain('From WhatsApp · Sea Star Offers')
  })

  it('still files the request when transcription fails, and says so', async () => {
    const d = deps({ transcribe: vi.fn(async () => null), parse: vi.fn(async () => ({})) })
    const r = await captureFromWhatsApp({ files: [file('PTT-1.opus', '')] }, d)
    expect(r).toMatchObject({ ok: true, title: 'WhatsApp voice note — listen and add details', needsListening: true, heard: null })
    expect(d.parse).not.toHaveBeenCalled()
    expect(d.filed[0].extraLinks).toHaveLength(1)
  })

  it('still files the request when the AI parser or storage throws', async () => {
    const d = deps({
      parse: vi.fn(async () => { throw new Error('rate limited') }),
      store: vi.fn(async () => { throw new Error('bucket missing') }),
    })
    const r = await captureFromWhatsApp({ message: 'Menu card reprint needed by Monday', files: [file('IMG-1.jpg', 'image/jpeg')] }, d)
    expect(r).toMatchObject({ ok: true, title: 'Menu card reprint needed by Monday' })
    expect(d.filed[0].extraLinks).toEqual([])
  })

  it('lets the person sharing name the client, overriding the AI', async () => {
    const d = deps()
    await captureFromWhatsApp({ message: 'two posters', client: 'Goodwill Hypermarket', files: [] }, d)
    expect(d.filed[0].client).toBe('Goodwill Hypermarket')
  })

  it('skips oversized, empty and unsupported files but keeps the rest', async () => {
    const d = deps()
    const r = await captureFromWhatsApp({
      message: 'see list',
      files: [file('big.opus', '', MAX_FILE_BYTES + 1), file('doc.pdf', 'application/pdf'), file('empty.jpg', 'image/jpeg', 0), file('ok.jpg', 'image/jpeg')],
    }, d)
    expect(r.ok && r.skipped).toEqual(['big.opus (over 4 MB)', 'doc.pdf (this kind of file is not supported)', 'empty.jpg (empty)'])
    expect(d.store).toHaveBeenCalledTimes(1)
  })

  it('refuses an empty share and reports a filing failure', async () => {
    expect(await captureFromWhatsApp({ files: [] }, deps())).toEqual({ ok: false, error: 'Nothing was shared. Send a message, voice note or photo.' })
    expect(await captureFromWhatsApp({ files: [file('doc.pdf', 'application/pdf')] }, deps())).toMatchObject({ ok: false })
    const failing = deps({ file: vi.fn(async () => ({ ok: false, error: 'db down' })) })
    expect(await captureFromWhatsApp({ message: 'hi', files: [] }, failing)).toEqual({ ok: false, error: 'db down' })
  })

  it('accepts shared text that arrives as a nameless file', async () => {
    const text = new TextEncoder().encode('ഓണം ഓഫർ flyer വേണം, Friday').buffer as ArrayBuffer
    expect(looksLikeText('', '', text)).toBe(true)
    expect(looksLikeText('message.txt', 'application/octet-stream', text)).toBe(true)
    expect(looksLikeText('offer.pdf', '', text)).toBe(false)
    expect(looksLikeText('', 'application/pdf', text)).toBe(false)
    expect(looksLikeText('', '', new Uint8Array([0xff, 0xfe, 0x00, 0x01]).buffer)).toBe(false)
    const d = deps()
    const r = await captureFromWhatsApp({ files: [{ name: '', type: '', bytes: text }] }, d)
    expect(r.ok).toBe(true)
    expect(d.parse).toHaveBeenCalledWith('ഓണം ഓഫർ flyer വേണം, Friday')
    expect(d.store).not.toHaveBeenCalled()
  })

  it('uses text read from a photo when image reading is set up', async () => {
    const d = deps({ readImage: vi.fn(async () => 'Sugar 1kg 45\nRice 5kg 310') })
    await captureFromWhatsApp({ files: [file('list.jpg', 'image/jpeg')] }, d)
    expect(d.parse).toHaveBeenCalledWith('Sugar 1kg 45\nRice 5kg 310')
    expect(d.filed[0].notes).toContain('Photo (read by AI, check against the photo):\nSugar 1kg 45')
  })
})

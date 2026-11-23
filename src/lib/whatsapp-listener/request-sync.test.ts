import { describe, expect, it } from 'vitest'
import { syncAction, syncNote, type SyncMessage } from './request-sync'

const H = 3_600_000
const T = Date.parse('2026-11-21T10:00:00Z')
const live = (sentAtMs: number, fromCirqle = false): SyncMessage => ({ sentAtMs, arrivedAtMs: sentAtMs + 5_000, fromCirqle })
const late = (sentAtMs: number, fromCirqle = false): SyncMessage => ({ sentAtMs, arrivedAtMs: sentAtMs + 30 * H, fromCirqle })

describe('keeping WhatsApp requests in step with the chat', () => {
  it('leaves a request alone while nobody from Cirqle has written after it', () => {
    expect(syncAction({ messages: [live(T)], replyNoted: false }, [])).toEqual({ action: 'none' })
    expect(syncAction({ messages: [live(T)], replyNoted: false }, [T - H])).toEqual({ action: 'none' })
    expect(syncAction({ messages: [late(T)], replyNoted: false }, [T - H])).toEqual({ action: 'none' })
    expect(syncAction({ messages: [], replyNoted: false }, [T + H])).toEqual({ action: 'none' })
  })

  it('archives a request whose every message came from a Cirqle number', () => {
    expect(syncAction({ messages: [live(T, true), live(T + 1000, true)], replyNoted: false }, [])).toEqual({ action: 'archive', why: 'own' })
    // One client message among them: it is a real request.
    expect(syncAction({ messages: [live(T, true), live(T + 1000)], replyNoted: false }, [])).toEqual({ action: 'none' })
  })

  it('archives a request that arrived late and was already answered, naming the first reply', () => {
    expect(syncAction({ messages: [late(T), late(T + 60_000)], replyNoted: false }, [T + 5 * H, T + 2 * H, T]))
      .toEqual({ action: 'archive', why: 'answered', repliedAtMs: T + 2 * H })
  })

  it('keeps a request that arrived live open when Cirqle replies, and notes the reply once', () => {
    expect(syncAction({ messages: [live(T)], replyNoted: false }, [T + H])).toEqual({ action: 'note-reply', repliedAtMs: T + H })
    expect(syncAction({ messages: [live(T)], replyNoted: true }, [T + H])).toEqual({ action: 'none' })
    // A late first message with a live follow-up is a live conversation.
    expect(syncAction({ messages: [late(T), live(T + 31 * H)], replyNoted: false }, [T + 32 * H])).toEqual({ action: 'note-reply', repliedAtMs: T + 32 * H })
  })

  it('measures the reply against the client\'s last message, not a Cirqle line inside the request', () => {
    expect(syncAction({ messages: [live(T), live(T + 2 * H, true)], replyNoted: false }, [T + 2 * H])).toEqual({ action: 'note-reply', repliedAtMs: T + 2 * H })
  })

  it('never archives a request a person has already decided about, but still notes the reply', () => {
    expect(syncAction({ messages: [late(T)], replyNoted: false, held: true }, [T + H])).toEqual({ action: 'note-reply', repliedAtMs: T + H })
    expect(syncAction({ messages: [late(T)], replyNoted: true, held: true }, [T + H])).toEqual({ action: 'none' })
    expect(syncAction({ messages: [live(T, true)], replyNoted: false, held: true }, [])).toEqual({ action: 'none' })
  })

  it('writes a line that says why', () => {
    const when = () => '21 Nov, 17:30'
    expect(syncNote({ action: 'archive', why: 'own' }, when)).toContain('sent from a Cirqle number')
    expect(syncNote({ action: 'archive', why: 'answered', repliedAtMs: T }, when)).toContain('already replied in the chat on 21 Nov, 17:30')
    expect(syncNote({ action: 'note-reply', repliedAtMs: T }, when)).toContain('Cirqle replied in the WhatsApp chat on 21 Nov, 17:30')
  })
})

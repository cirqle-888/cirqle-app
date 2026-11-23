/**
 * WhatsApp requests kept in step with the chat — the rules. Pure.
 *
 * The listener files a request the moment a client's message arrives. What
 * happens next happens in WhatsApp: someone from Cirqle answers, or it turns
 * out the "client" was a Cirqle number that was not on the list yet. Without
 * this the request sat in the inbox as New for ever, and the morning brief
 * reported work that was already dealt with.
 *
 * For a request that nobody has touched in Cirqle App (still New, no task):
 *
 *   own        every message in it came from a Cirqle number
 *              → archived: it was never a client's request.
 *   answered   it was filed while the gateway was catching up (every message
 *              reached us hours late) and Cirqle wrote in the chat after the
 *              last of them → archived: it was handled before we heard of it.
 *   replied    it arrived live and Cirqle has written in the chat since
 *              → stays open (a reply is not the finished work), with a line on
 *              its timeline saying when Cirqle replied.
 *
 * Archived requests are in the Archived tab and can be brought back there.
 * Nothing here sends anything to WhatsApp. The database side: request-sync-run.ts.
 */

import { isLateMessage } from './rules'

export interface SyncMessage {
  /** When WhatsApp says it was sent. */
  sentAtMs: number
  /** When it reached Cirqle App. */
  arrivedAtMs: number
  /** Is the sender a Cirqle number, by the list as it is today? */
  fromCirqle: boolean
}

export interface SyncRequest {
  messages: readonly SyncMessage[]
  /** A "Cirqle replied" line is already on its timeline. */
  replyNoted: boolean
}

export type SyncAction =
  | { action: 'none' }
  | { action: 'archive'; why: 'own' | 'answered'; repliedAtMs?: number }
  | { action: 'note-reply'; repliedAtMs: number }

/**
 * What to do with one untouched WhatsApp request.
 * `cirqleSentAtMs` is every time Cirqle wrote in that chat, in any order.
 */
export function syncAction(req: SyncRequest, cirqleSentAtMs: readonly number[]): SyncAction {
  if (!req.messages.length) return { action: 'none' }
  if (req.messages.every(m => m.fromCirqle)) return { action: 'archive', why: 'own' }

  // Only the client's own messages count: a Cirqle line folded into the request is not what needs answering.
  const last = Math.max(...req.messages.filter(m => !m.fromCirqle).map(m => m.sentAtMs))
  const replies = cirqleSentAtMs.filter(t => t > last)
  if (!replies.length) return { action: 'none' }
  const repliedAtMs = Math.min(...replies)

  if (req.messages.every(m => isLateMessage(m.sentAtMs, m.arrivedAtMs))) return { action: 'archive', why: 'answered', repliedAtMs }
  return req.replyNoted ? { action: 'none' } : { action: 'note-reply', repliedAtMs }
}

/** The line written on the request's timeline, so anyone can see why it moved. */
export function syncNote(a: Exclude<SyncAction, { action: 'none' }>, when: (ms: number) => string): string {
  if (a.action === 'note-reply') return `Cirqle replied in the WhatsApp chat on ${when(a.repliedAtMs)}. Close this request when the work is done.`
  if (a.why === 'own') return 'Archived by the WhatsApp listener: the message was sent from a Cirqle number, so it is not a client request.'
  return `Archived by the WhatsApp listener: the message reached Cirqle App late, and Cirqle had already replied in the chat${a.repliedAtMs ? ` on ${when(a.repliedAtMs)}` : ''}. Unarchive it if work is still pending.`
}

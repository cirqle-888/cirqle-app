/** Polls in chat: the question and options live in the message's metadata; votes in their own table. */

export interface PollOption { id: string; text: string }
export interface PollData {
  question: string
  options: PollOption[]
  multi: boolean
  /** option id → employee ids who chose it. Written back after every vote. */
  votes: Record<string, string[]>
}

export const POLL_MAX_OPTIONS = 10

/** Clean what someone typed into a poll. Returns an error message, or the poll. */
export function buildPoll(question: string, options: string[], multi: boolean): { ok: true; poll: PollData } | { ok: false; error: string } {
  const q = question.replace(/\s+/g, ' ').trim()
  if (!q) return { ok: false, error: 'Write the question.' }
  if (q.length > 300) return { ok: false, error: 'The question is too long.' }
  const seen = new Set<string>()
  const clean: string[] = []
  for (const raw of options) {
    const text = raw.replace(/\s+/g, ' ').trim().slice(0, 120)
    if (!text || seen.has(text.toLowerCase())) continue
    seen.add(text.toLowerCase())
    clean.push(text)
  }
  if (clean.length < 2) return { ok: false, error: 'Add at least two different options.' }
  if (clean.length > POLL_MAX_OPTIONS) return { ok: false, error: `A poll can have at most ${POLL_MAX_OPTIONS} options.` }
  return { ok: true, poll: { question: q, options: clean.map((text, i) => ({ id: `o${i + 1}`, text })), multi, votes: {} } }
}

/** Group raw vote rows by option, keeping only options the poll really has. */
export function tallyVotes(poll: Pick<PollData, 'options'>, rows: readonly { employee_id: string; option_id: string }[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const valid = new Set(poll.options.map(o => o.id))
  for (const r of rows) {
    if (!valid.has(r.option_id)) continue
    ;(out[r.option_id] ??= []).push(r.employee_id)
  }
  return out
}

export function pollTotals(poll: PollData): { voters: number; byOption: Record<string, number>; top: number } {
  const voters = new Set<string>()
  const byOption: Record<string, number> = {}
  let top = 0
  for (const o of poll.options) {
    const ids = poll.votes[o.id] ?? []
    ids.forEach(id => voters.add(id))
    byOption[o.id] = ids.length
    top = Math.max(top, ids.length)
  }
  return { voters: voters.size, byOption, top }
}

export function readPoll(metadata: Record<string, unknown>): PollData | null {
  const p = metadata.poll as Partial<PollData> | undefined
  if (!p || typeof p.question !== 'string' || !Array.isArray(p.options)) return null
  return { question: p.question, options: p.options as PollOption[], multi: !!p.multi, votes: (p.votes as Record<string, string[]>) ?? {} }
}

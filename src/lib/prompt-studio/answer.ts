/**
 * Prompt Studio — using an AI's answer in the next step.
 *
 * The workflow is a chain (ad ideas → shot list → one clip per shot), so the
 * answer from one template is usually the input of the next. These pure
 * helpers decide where an answer goes and read a Client Card out of the
 * "Client message to Client Card" answer.
 */
import type { ClientCard, PromptTemplate } from './types'
import { CLIENT_CARD_FIELDS } from './client-card'

/** Fields that are made to receive a previous answer, best first. */
const RECEIVERS = ['shots', 'script', 'old', 'footage', 'bible', 'need']

/** The field of `t` that a pasted answer should fill, or null if it has none. */
export function answerField(t: PromptTemplate): string | null {
  for (const key of RECEIVERS) {
    const f = t.fields.find(x => x.key === key)
    if (f && (f.type === 'textarea' || f.type === 'text')) return f.key
  }
  return t.fields.find(f => f.type === 'textarea')?.key ?? null
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')

/**
 * Read "Field: value" lines into a Client Card. Matches card labels loosely
 * ("Language" fills "Language for voice and text"). "ASK CLIENT" and blanks are
 * skipped, so they never overwrite what the card already holds.
 */
export function cardFromAnswer(answer: string): ClientCard {
  const out: ClientCard = {}
  for (const raw of answer.split('\n')) {
    const line = raw.replace(/^[\s*\-•\d.]+/, '').replace(/\*\*/g, '')
    const at = line.indexOf(':')
    if (at < 1) continue
    const label = norm(line.slice(0, at))
    const value = line.slice(at + 1).trim()
    if (!label || !value || /^ask client\.?$/i.test(value)) continue
    const field = CLIENT_CARD_FIELDS.find(f => {
      const l = norm(f.label)
      return l === label || l.startsWith(label) || label.startsWith(l)
    })
    if (field && !out[field.key]) out[field.key] = value
  }
  return out
}

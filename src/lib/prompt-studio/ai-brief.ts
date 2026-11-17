/**
 * Prompt Studio — "Copy for AI".
 *
 * One click on a client's page copies everything an outside AI (Codex, Gemini,
 * ChatGPT, Claude) needs: the Client Card, and with it one of the social
 * planning jobs. Built on the same templates as the Create tab, so the text is
 * the same whichever way it is made.
 */
import { renderClientCard, renderPrompt } from './render'
import { templateByKey } from './templates'
import { CLIENT_CARD_FIELDS } from './client-card'
import type { ClientCard } from './types'

export type AiJob = 'details' | 'trends' | 'calendar' | 'ideas' | 'poster' | 'reel'

export const AI_JOBS: { id: AiJob; label: string; template?: string }[] = [
  { id: 'trends',   label: 'Today’s trends',   template: 'social-trends-today' },
  { id: 'calendar', label: 'Monthly calendar', template: 'social-calendar-month' },
  { id: 'ideas',    label: 'Fresh ideas',      template: 'social-fresh-ideas' },
  { id: 'poster',   label: 'Poster brief',     template: 'social-post-brief' },
  { id: 'reel',     label: 'Reel script',      template: 'social-post-brief' },
  { id: 'details',  label: 'Client details only' },
]

export interface AiBriefOptions {
  /** "December 2026" — for the calendar. */
  month?: string
  mode?: 'Regular' | 'Random'
  /** One of COLOR_USE_OPTIONS, to override the card for this copy. */
  colorUse?: string
  /** For the poster brief and reel script. */
  idea?: string
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** The month a planner most likely means: this one, or the next once this one is nearly over. */
export function planMonthLabel(today: Date): string {
  const next = today.getDate() >= 20
  const d = new Date(today.getFullYear(), today.getMonth() + (next ? 1 : 0), 1)
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

/** The text that goes on the clipboard. Empty when there is no card to copy. */
export function buildAiBrief(card: ClientCard | null | undefined, job: AiJob, o: AiBriefOptions = {}): string {
  if (!card || !Object.values(card).some(v => (v ?? '').trim())) return ''
  const withColour = o.colorUse ? { ...card, colorUse: o.colorUse } : card
  const def = AI_JOBS.find(j => j.id === job)
  const t = def?.template ? templateByKey(def.template) : undefined
  if (!t) return renderClientCard(withColour)
  const values: Record<string, string> =
    job === 'calendar' ? { month: o.month || '', mode: o.mode || 'Regular' }
    : job === 'poster' ? { format: 'Poster', need: o.idea?.trim() || 'Ask me for the idea before you start.' }
    : job === 'reel' ? { format: 'Reel', need: o.idea?.trim() || 'Ask me for the idea before you start.' }
    : {}
  return renderPrompt(t, values, withColour)
}

/** What a social plan leans on. Empty ones are named on the button so the brief is not thin. */
const SOCIAL_NEEDS = ['business', 'location', 'audience', 'language', 'platforms', 'postsPerWeek']

/** Labels of the card fields a social plan needs that are still empty. */
export function socialGaps(card: ClientCard | null | undefined): string[] {
  return SOCIAL_NEEDS
    .filter(k => !(card?.[k] ?? '').trim())
    .map(k => CLIENT_CARD_FIELDS.find(f => f.key === k)?.label ?? k)
}

/**
 * Pending requests by client — what is waiting, for whom, and for how long.
 *
 * The Requests inbox answers "what came in"; this answers "who is waiting on
 * us right now". One row per client, oldest wait first, so the client who has
 * waited longest is at the top.
 *
 * Pure and dependency-free.
 */

/** Nobody at Cirqle has started it yet. */
const NOT_STARTED = new Set(['submitted', 'under_review', 'approved'])
/** Cirqle is working on it. */
const IN_PROGRESS = new Set(['started', 'in_progress'])
/** The ball is with the client: content missing, revision asked, or delivered for their review. */
const WITH_CLIENT = new Set(['waiting_for_content', 'revision_requested', 'delivered'])

export type PendingStage = 'not_started' | 'in_progress' | 'with_client'

export function pendingStage(status: string): PendingStage | null {
  if (NOT_STARTED.has(status)) return 'not_started'
  if (IN_PROGRESS.has(status)) return 'in_progress'
  if (WITH_CLIENT.has(status)) return 'with_client'
  return null // completed, cancelled, rejected, archived
}

export interface PendingRequest {
  id: string
  ref_no: number
  title: string
  status: string
  created_at: string
  due_date: string | null
  archived_at: string | null
  description: string | null
  client_id: string | null
  client_name: string | null
  /** Name typed by the sender when no client matched. */
  submitter_name: string | null
}

export interface PendingItem {
  id: string
  ref: string
  title: string
  stage: PendingStage
  daysWaiting: number
  overdue: boolean
  fromWhatsApp: boolean
}

export interface PendingClient {
  /** Client id, or `unmatched:<name>` for requests whose client was not found. */
  key: string
  clientId: string | null
  name: string
  matched: boolean
  notStarted: number
  inProgress: number
  withClient: number
  overdue: number
  fromWhatsApp: number
  /** Days the oldest request not yet started has waited; 0 when none. */
  oldestWaitDays: number
  /** A WhatsApp chat is on the listener's allow-list for this client. */
  hasListedChat: boolean
  /** Not started first, then in progress, then with the client; oldest first inside each. */
  items: PendingItem[]
}

const DAY = 86_400_000
const STAGE_ORDER: Record<PendingStage, number> = { not_started: 0, in_progress: 1, with_client: 2 }

/** Captured from WhatsApp, by the share shortcut or the listener (both write this first line). */
export function isFromWhatsApp(description: string | null | undefined): boolean {
  return (description || '').trimStart().startsWith('From WhatsApp')
}

const norm = (s: string | null | undefined) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ')

export function pendingByClient(
  requests: readonly PendingRequest[],
  /** Client names from the WhatsApp listener's allow-list. */
  listedClientNames: readonly string[],
  now: Date,
): PendingClient[] {
  const listed = new Set(listedClientNames.map(norm).filter(Boolean))
  const today = now.toISOString().slice(0, 10)
  const byKey = new Map<string, PendingClient>()

  for (const r of requests) {
    if (r.archived_at) continue
    const stage = pendingStage(r.status)
    if (!stage) continue

    const matched = !!r.client_id
    const name = (matched ? r.client_name : r.submitter_name)?.trim() || 'No client'
    const key = matched ? (r.client_id as string) : `unmatched:${norm(name)}`
    let c = byKey.get(key)
    if (!c) {
      c = {
        key, clientId: r.client_id, name, matched,
        notStarted: 0, inProgress: 0, withClient: 0, overdue: 0, fromWhatsApp: 0,
        oldestWaitDays: 0, hasListedChat: listed.has(norm(name)), items: [],
      }
      byKey.set(key, c)
    }

    const created = Date.parse(r.created_at)
    const daysWaiting = Number.isFinite(created) ? Math.max(0, Math.floor((now.getTime() - created) / DAY)) : 0
    const overdue = !!r.due_date && r.due_date.slice(0, 10) < today && stage !== 'with_client'
    const whatsapp = isFromWhatsApp(r.description)

    if (stage === 'not_started') { c.notStarted++; c.oldestWaitDays = Math.max(c.oldestWaitDays, daysWaiting) }
    else if (stage === 'in_progress') c.inProgress++
    else c.withClient++
    if (overdue) c.overdue++
    if (whatsapp) c.fromWhatsApp++
    c.items.push({
      id: r.id, ref: `REQ-${String(r.ref_no ?? 0).padStart(4, '0')}`, title: r.title,
      stage, daysWaiting, overdue, fromWhatsApp: whatsapp,
    })
  }

  const out = [...byKey.values()]
  for (const c of out) {
    c.items.sort((a, b) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] || b.daysWaiting - a.daysWaiting)
  }
  // Longest unanswered wait first; then most overdue; then most open work.
  return out.sort((a, b) =>
    b.oldestWaitDays - a.oldestWaitDays ||
    b.overdue - a.overdue ||
    (b.notStarted + b.inProgress) - (a.notStarted + a.inProgress) ||
    a.name.localeCompare(b.name))
}

export interface PendingTotals { clients: number; notStarted: number; inProgress: number; withClient: number; overdue: number }

export function pendingTotals(rows: readonly PendingClient[]): PendingTotals {
  return rows.reduce<PendingTotals>((t, c) => ({
    clients: t.clients + 1,
    notStarted: t.notStarted + c.notStarted,
    inProgress: t.inProgress + c.inProgress,
    withClient: t.withClient + c.withClient,
    overdue: t.overdue + c.overdue,
  }), { clients: 0, notStarted: 0, inProgress: 0, withClient: 0, overdue: 0 })
}

/** Allow-list client names that match no client in Cirqle (a typo means requests arrive unmatched). */
export function unmatchedListNames(listedClientNames: readonly string[], clientNames: readonly string[]): string[] {
  const known = new Set(clientNames.map(norm))
  return [...new Set(listedClientNames.map(n => n.trim()).filter(Boolean))].filter(n => !known.has(norm(n)))
}

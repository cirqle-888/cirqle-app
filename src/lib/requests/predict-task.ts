/**
 * Predict the Task (service) for a new design request, so staff usually
 * don't have to pick it at all.
 *
 * Learns from the team's own history rather than a hard-coded list:
 *
 *  1. The title. Every word in it is checked against
 *     - the service names ("poster" → Social Media Poster), and
 *     - past requests: if earlier "…flex…" requests were Hoarding Design,
 *       "Flex board for Diwali" points there too.
 *  2. The client. What this client usually asks for (recent requests count
 *     more), and the services they're committed to in the pricing matrix.
 *
 * Returns the best guess plus a short reason to show the user, and up to
 * three ranked candidates for one-tap chips. No guess when the evidence is
 * thin — an empty field is better than a confidently wrong one.
 */

export interface TaskHistoryRow {
  title?: string | null
  service_id?: string | null
  client_id?: string | null
  created_at?: string | null
}

export interface TaskPrediction {
  serviceId: string
  reason: string
  /** Up to three ranked candidates (the first is serviceId). */
  ranked: { serviceId: string; reason: string }[]
}

// Words that say nothing about WHICH task it is.
const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'new', 'set', 'design', 'designs', 'designing',
  'creative', 'creatives', 'service', 'services', 'work', 'job', 'request', 'media',
  'our', 'your', 'this', 'that', 'two', 'one', 'sides', 'side', 'update', 'final',
])

export function taskTokens(text: string | null | undefined): string[] {
  const out: string[] = []
  for (const raw of (text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw) || /^\d+$/.test(raw)) continue
    // Light stemming so "posters"/"reels"/"stories" meet "poster"/"reel"/"story".
    const w = raw.endsWith('ies') ? raw.slice(0, -3) + 'y' : raw.endsWith('s') && raw.length > 4 ? raw.slice(0, -1) : raw
    if (!out.includes(w)) out.push(w)
  }
  return out
}

export function predictTask(input: {
  title: string
  clientId?: string | null
  services: { id: string; name: string }[]
  history: TaskHistoryRow[]
  /** Active client ↔ service commitments (pricing matrix). */
  commitments?: { client_id: string; service_id: string }[]
  clientName?: string | null
}): TaskPrediction | null {
  const { services, history } = input
  if (!services.length) return null
  const live = new Set(services.map(s => s.id))
  const score = new Map<string, number>()
  const why = new Map<string, { w: number; text: string }>()
  const add = (id: string, pts: number, text: string) => {
    if (!live.has(id) || pts <= 0) return
    score.set(id, (score.get(id) ?? 0) + pts)
    const cur = why.get(id)
    if (!cur || pts > cur.w) why.set(id, { w: pts, text })
  }

  // ── 1. Title evidence ─────────────────────────────────────────────────────
  const words = taskTokens(input.title)
  if (words.length) {
    for (const s of services) {
      const nameWords = taskTokens(s.name)
      const hit = words.find(w => nameWords.includes(w))
      if (hit) add(s.id, 3, `"${hit}" is in the task name`)
    }
    // Word → service distribution learned from past request titles.
    const byWord = new Map<string, Map<string, number>>()
    for (const r of history) {
      if (!r.service_id) continue
      for (const w of taskTokens(r.title)) {
        if (!words.includes(w)) continue
        const m = byWord.get(w) ?? new Map<string, number>()
        m.set(r.service_id, (m.get(r.service_id) ?? 0) + 1)
        byWord.set(w, m)
      }
    }
    for (const [w, m] of byWord) {
      const total = [...m.values()].reduce((a, b) => a + b, 0)
      for (const [sid, n] of m) {
        // What the title says about THIS request outranks the client's habit
        // (max 2), even on a single past example; more examples firm it up.
        add(sid, 3 * (n / total) * (total >= 2 ? 1 : 0.8), `past "${w}" requests used this`)
      }
    }
  }

  // ── 2. Client evidence ────────────────────────────────────────────────────
  if (input.clientId) {
    const mine = history
      .filter(r => r.client_id === input.clientId && r.service_id)
      .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
      .slice(0, 20)
    if (mine.length) {
      const weights = new Map<string, number>()
      let total = 0
      mine.forEach((r, i) => {
        const w = 1 / (1 + i * 0.15)   // most recent counts most
        weights.set(r.service_id!, (weights.get(r.service_id!) ?? 0) + w)
        total += w
      })
      const who = input.clientName ? `for ${input.clientName}` : 'for this client'
      for (const [sid, w] of weights) add(sid, 2 * (w / total), `most used ${who}`)
    }
    const committed = (input.commitments ?? []).filter(c => c.client_id === input.clientId).map(c => c.service_id)
    const uniq = [...new Set(committed)].filter(id => live.has(id))
    for (const sid of uniq) add(sid, uniq.length === 1 ? 1.5 : 0.6, uniq.length === 1 ? "this client's committed task" : 'a committed task for this client')
  }

  const ranked = [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .filter(([, v]) => v >= 0.6)
    .slice(0, 3)
    .map(([serviceId]) => ({ serviceId, reason: why.get(serviceId)?.text ?? '' }))
  if (!ranked.length) return null
  const [best] = ranked
  // A near-tie between the top two is a guess, not a prediction — still offer
  // both as chips, but don't pre-fill.
  const top = score.get(best.serviceId)!
  const second = ranked[1] ? score.get(ranked[1].serviceId)! : 0
  if (top < 1 || (second && top - second < 0.25)) return { serviceId: '', reason: '', ranked }
  return { serviceId: best.serviceId, reason: best.reason, ranked }
}

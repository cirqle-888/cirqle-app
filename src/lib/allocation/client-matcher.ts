/**
 * Client Matching Engine for cashbook payment entries.
 *
 * Priority order (highest confidence first):
 *  1. client_id already set on the entry            → 100%  existing_client_id
 *  2. Linked invoice's client                       → 98%   linked_invoice
 *  3. Client code in description  (CQxxx / exact)  → 95%   client_code_exact
 *  4. Client name in description  (exact)           → 90%   client_name_exact
 *  5. Invoice number in description                 → 85%   invoice_ref
 *  6. Client name fuzzy match                       → 60-79% client_name_fuzzy
 *  7. No match / manual review required             → 0%    no_match
 *
 * PURE — no database calls. All data is passed in by the caller.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type MatchMethod =
  | 'existing_client_id'
  | 'linked_invoice'
  | 'client_code_exact'
  | 'client_name_exact'
  | 'invoice_ref'
  | 'client_name_fuzzy'
  | 'no_match'

export interface ClientMatch {
  client_id: string
  client_name: string
  client_code: string
  confidence: number      // 0-100
  method: MatchMethod
  requires_review: boolean
}

export interface MatchResult {
  entry_id: string
  entry_date: string
  amount_inr: number
  description: string
  reference: string
  currency: string

  best: ClientMatch | null        // top match (or null if none)
  alternatives: ClientMatch[]     // other possible matches (for ambiguous entries)

  status: 'matched' | 'low_confidence' | 'ambiguous' | 'no_match'
}

// ─── Input types ─────────────────────────────────────────────────────────────

export interface MatchableEntry {
  id: string
  entry_date: string
  description: string
  reference: string
  amount_inr: number
  currency: string
  client_id?: string | null
  invoice_id?: string | null       // already-linked invoice (populated at import time)
  invoice?: { client_id?: string | null } | null
}

export interface MatchableClient {
  id: string
  name: string
  code: string
}

export interface MatchableInvoice {
  id: string
  invoice_number: string
  client_id: string
}

// ─── Normalisation helpers ─────────────────────────────────────────────────

/** Lower-case, collapse whitespace / dashes / underscores, strip non-alphanumeric */
function norm(s: string): string {
  return (s || '').toLowerCase().replace(/[\s_\-]+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim()
}

/** Extract all client-code-like tokens from text (CQ + digits) */
function extractCodes(text: string): string[] {
  const matches = text.toUpperCase().match(/\bCQ\d+\b/g)
  return matches ? [...new Set(matches)] : []
}

/** Extract invoice-number-like tokens (INV-YYYY-NNN pattern) */
function extractInvNums(text: string): string[] {
  const matches = text.toUpperCase().match(/\bINV[-_]?\d{4}[-_]?\d{1,4}\b/g)
  return matches ? [...new Set(matches.map(m => m.replace(/[-_]/g, '-')))] : []
}

/**
 * Trigram similarity 0–1 between two normalised strings.
 * Fast approximation suitable for short strings (names).
 */
function trigramSim(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  function trigrams(s: string): Set<string> {
    const t = new Set<string>()
    const padded = `  ${s}  `
    for (let i = 0; i < padded.length - 2; i++) t.add(padded.slice(i, i + 3))
    return t
  }
  const ta = trigrams(a)
  const tb = trigrams(b)
  let inter = 0
  ta.forEach(t => { if (tb.has(t)) inter++ })
  return (2 * inter) / (ta.size + tb.size)
}

// ─── Core matcher ─────────────────────────────────────────────────────────────

/**
 * Match all entries against the provided client list.
 *
 * @param entries     Cashbook inflow entries
 * @param clients     All active clients
 * @param invoices    All invoices (for reference-based matching)
 */
export function matchEntriesToClients(
  entries: MatchableEntry[],
  clients: MatchableClient[],
  invoices: MatchableInvoice[],
): MatchResult[] {
  // Pre-build lookup maps for O(1) access.
  const clientById = new Map<string, MatchableClient>(clients.map(c => [c.id, c]))
  const clientByCode = new Map<string, MatchableClient>(
    clients.map(c => [c.code.toUpperCase(), c])
  )
  const clientByNormName = new Map<string, MatchableClient>(
    clients.map(c => [norm(c.name), c])
  )
  const invByNum = new Map<string, MatchableInvoice>(
    invoices.map(i => [i.invoice_number.toUpperCase(), i])
  )

  const toMatch = (c: MatchableClient, confidence: number, method: MatchMethod): ClientMatch => ({
    client_id: c.id, client_name: c.name, client_code: c.code,
    confidence, method,
    requires_review: confidence < 85,
  })

  return entries.map(entry => {
    const candidates: ClientMatch[] = []
    const text = `${entry.description || ''} ${entry.reference || ''}`.trim()

    // ── Priority 1: client_id already set ───────────────────────────────────
    if (entry.client_id) {
      const c = clientById.get(entry.client_id)
      if (c) candidates.push(toMatch(c, 100, 'existing_client_id'))
    }

    // ── Priority 2: linked invoice's client ─────────────────────────────────
    const linkedClientId = entry.invoice?.client_id || null
    if (linkedClientId && linkedClientId !== entry.client_id) {
      const c = clientById.get(linkedClientId)
      if (c) candidates.push(toMatch(c, 98, 'linked_invoice'))
    }

    // ── Priority 3: client code in description (CQ042 etc.) ─────────────────
    const foundCodes = extractCodes(text)
    for (const code of foundCodes) {
      const c = clientByCode.get(code)
      if (c && !candidates.find(x => x.client_id === c.id)) {
        candidates.push(toMatch(c, 95, 'client_code_exact'))
      }
    }

    // ── Priority 4: client name exact match in description ──────────────────
    const normText = norm(text)
    for (const [normName, c] of clientByNormName) {
      if (!normName) continue
      if (normText.includes(normName) && !candidates.find(x => x.client_id === c.id)) {
        candidates.push(toMatch(c, 90, 'client_name_exact'))
      }
    }

    // ── Priority 5: invoice reference in description ─────────────────────────
    const foundInvNums = extractInvNums(text)
    for (const invNum of foundInvNums) {
      const inv = invByNum.get(invNum)
      if (inv) {
        const c = clientById.get(inv.client_id)
        if (c && !candidates.find(x => x.client_id === c.id)) {
          candidates.push(toMatch(c, 85, 'invoice_ref'))
        }
      }
    }

    // ── Priority 6: fuzzy name match ─────────────────────────────────────────
    if (candidates.length === 0) {
      const fuzzy: ClientMatch[] = []
      for (const c of clients) {
        const sim = trigramSim(normText, norm(c.name))
        if (sim >= 0.45) {
          const conf = Math.round(40 + sim * 45) // maps 0.45→60 and 1.0→85
          fuzzy.push(toMatch(c, Math.min(conf, 79), 'client_name_fuzzy'))
        }
      }
      fuzzy.sort((a, b) => b.confidence - a.confidence)
      candidates.push(...fuzzy.slice(0, 3))
    }

    // ── Resolve best match ────────────────────────────────────────────────────
    candidates.sort((a, b) => b.confidence - a.confidence)
    const best = candidates[0] ?? null
    const alternatives = candidates.slice(1, 4)

    // ── Status ────────────────────────────────────────────────────────────────
    let status: MatchResult['status']
    if (!best) {
      status = 'no_match'
    } else if (candidates.length > 1 && candidates[0].confidence < 90
               && Math.abs(candidates[0].confidence - candidates[1].confidence) <= 10) {
      status = 'ambiguous'
    } else if (best.confidence < 85) {
      status = 'low_confidence'
    } else {
      status = 'matched'
    }

    return {
      entry_id: entry.id,
      entry_date: entry.entry_date,
      amount_inr: entry.amount_inr,
      description: entry.description || '',
      reference: entry.reference || '',
      currency: entry.currency || 'INR',
      best,
      alternatives,
      status,
    }
  })
}

// ─── Summary stats ────────────────────────────────────────────────────────────

export interface MatchSummary {
  total: number
  matched: number          // confidence ≥ 85 and unambiguous
  low_confidence: number   // any match but confidence < 85
  ambiguous: number        // multiple close matches
  no_match: number
  requires_review: number  // low_confidence + ambiguous + no_match
}

export function summarizeMatches(results: MatchResult[]): MatchSummary {
  const counts = { matched: 0, low_confidence: 0, ambiguous: 0, no_match: 0 }
  results.forEach(r => counts[r.status]++)
  return {
    total: results.length,
    ...counts,
    requires_review: counts.low_confidence + counts.ambiguous + counts.no_match,
  }
}

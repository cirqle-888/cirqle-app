import type { SearchFacet, FacetOp } from '@/components/ui/tokenized-search'

/** Apply an operator to a string field value. */
export function cmpText(val: string | null | undefined, op: FacetOp, text: string): boolean {
  const v = (val || '').toLowerCase()
  const q = text.toLowerCase()
  return op === 'is' ? v === q : v.includes(q)
}

/** Apply an operator to a numeric field value. Non-numeric query → no-op (matches). */
export function cmpNum(val: number | null | undefined, op: FacetOp, text: string): boolean {
  const n = Number(val ?? 0)
  const m = Number(text)
  if (!Number.isFinite(m)) return true
  switch (op) {
    case '>':  return n > m
    case '<':  return n < m
    case '>=': return n >= m
    case '<=': return n <= m
    case '!=': return n !== m
    default:   return n === m   // '=' and text ops fall back to equality
  }
}

export interface FacetFieldDef {
  type: 'text' | 'number'
  /** Pull the comparable value out of a record. */
  get: (rec: any) => string | number | null | undefined
}

/**
 * Shared facet combination used by every Cirqle search bar:
 *   • generic 'any' facets → AND (each narrows; matched against `genericGet`)
 *   • same named field     → OR
 *   • across fields        → AND
 *
 * `fields` maps a facet field key → how to read+compare it on a record.
 */
export function recordMatchesFacets(
  facets: SearchFacet[],
  rec: any,
  fields: Record<string, FacetFieldDef>,
  genericGet: (rec: any) => string,
): boolean {
  // Generic text facets: every one must match somewhere.
  for (const f of facets) {
    if (f.field === 'any' && !cmpText(genericGet(rec), 'contains', f.text)) return false
  }
  // Named fields: group, OR within a field, AND across fields.
  const byField: Record<string, SearchFacet[]> = {}
  for (const f of facets) if (f.field !== 'any') (byField[f.field] ||= []).push(f)
  for (const [key, fs] of Object.entries(byField)) {
    const def = fields[key]
    if (!def) continue
    const ok = fs.some(f =>
      def.type === 'number' ? cmpNum(Number(def.get(rec)), f.op, f.text)
        : cmpText(String(def.get(rec) ?? ''), f.op, f.text))
    if (!ok) return false
  }
  return true
}

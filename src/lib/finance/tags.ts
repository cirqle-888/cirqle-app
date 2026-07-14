/**
 * Finance Engine — spend-by-tag aggregation (pure).
 *
 * Tags are free-form labels on cashbook entries ("Photoshop", "Design", …),
 * orthogonal to the fixed category taxonomy. A tag doesn't split the money —
 * an entry tagged both "Software" and "Design Tools" contributes its full
 * spend to each tag (they're overlapping labels, not a partition).
 */

import type { JournalLine, TagSpendRow } from './types'

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100

/**
 * Aggregate journal lines (fetched with `includeTags: true`) into per-tag
 * spend. Only outflows count as "spend"; untagged lines and inflows are
 * ignored.
 */
export function buildTagSpend(lines: JournalLine[]): TagSpendRow[] {
  const byTag = new Map<string, TagSpendRow>()
  for (const line of lines) {
    if (!line.tags || line.tags.length === 0) continue
    const spend = Math.max(0, -line.amountInr)
    if (spend <= 0) continue
    for (const tag of line.tags) {
      let row = byTag.get(tag)
      if (!row) { row = { tag, totalInr: 0, entryCount: 0 }; byTag.set(tag, row) }
      row.totalInr = round2(row.totalInr + spend)
      row.entryCount += 1
    }
  }
  return [...byTag.values()].sort((a, b) => b.totalInr - a.totalInr)
}

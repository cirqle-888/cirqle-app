/**
 * Confidential staff costs in a unit's own views (pure).
 *
 * A unit carries part of the pay of people who are not on its team — the
 * owner, the office staff — through salary splits and General costs. The
 * unit's team (and a meeting with them in Focus mode) may see what those
 * costs add up to, but not who they are for or what anyone outside the team
 * earns. So in the unit's workspace every entry for a person outside the
 * team is folded into ONE line per month and kind, shown under the owner's
 * CQID, with this unit's share only — no names, no other CQIDs, no full
 * salary amounts.
 *
 * The full detail stays on the Admin's Cash Book allocation page.
 */

import { round2 } from '@/lib/calculations/currency'
import type { DeptConfig, DeptEntryRow } from './engine'

const CQID = /CQID\s*-?\s*(\d{3})/i

/** The CQID a unit's confidential costs are shown under: the owner on its agreement. */
export function ownerCqidOf(dept: Pick<DeptConfig, 'partners' | 'members'>, fallback = 'Cirqle'): string {
  const team = new Set(dept.members.map(m => m.employeeId))
  const owner = [...dept.partners].filter(p => !team.has(p.employeeId)).sort((a, b) => b.sharePct - a.sharePct)[0]
  return owner?.cqid || fallback
}

/** Is this row for a person who is not on the unit's team? */
export function isConfidential(row: Pick<DeptEntryRow, 'employeeId' | 'description'>, dept: Pick<DeptConfig, 'members'>): boolean {
  const teamIds = new Set(dept.members.map(m => m.employeeId))
  const teamCqids = new Set(dept.members.map(m => (m.cqid.match(/\d{3}/) ?? [''])[0]).filter(Boolean))
  if (row.employeeId) return !teamIds.has(row.employeeId)
  const m = (row.description ?? '').match(CQID)
  return !!m && !teamCqids.has(m[1])
}

/** The unit's rows with every confidential entry folded into one line per month and kind. */
export function confidentialRows(rows: readonly DeptEntryRow[], dept: Pick<DeptConfig, 'members' | 'partners'>, ownerCqid = ownerCqidOf(dept)): DeptEntryRow[] {
  const kept: DeptEntryRow[] = []
  const folded = new Map<string, { row: DeptEntryRow; net: number }>()
  for (const r of rows) {
    if (!isConfidential(r, dept)) { kept.push(r); continue }
    const key = `${r.date.slice(0, 7)}|${r.general ? 'g' : 'd'}`
    const signed = (r.type === 'outflow' ? 1 : -1) * r.shareInr
    const cur = folded.get(key)
    if (cur) {
      cur.net = round2(cur.net + signed)
      if (r.date > cur.row.date) cur.row.date = r.date
    } else {
      folded.set(key, {
        net: round2(signed),
        row: {
          entryId: `staff:${key}`, date: r.date, type: 'outflow',
          description: `${ownerCqid} — owner's team (staff pay and costs)`, categoryName: 'Staff',
          amountInr: 0, shareInr: 0, how: 'combined', general: r.general, employeeId: null,
        },
      })
    }
  }
  for (const { row, net } of folded.values()) {
    const share = Math.abs(net)
    kept.push({ ...row, type: net < 0 ? 'inflow' : 'outflow', amountInr: share, shareInr: share })
  }
  return kept.sort((a, b) => b.date.localeCompare(a.date))
}

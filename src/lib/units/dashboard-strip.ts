import 'server-only'

/**
 * "Units this month" — the Admin dashboard's line of Cirqle's units: each
 * unit's income and result this month, and income that landed in no unit.
 * Units that start later show their figures as a preview (as Cirqle HQ does).
 * Small and serialisable: it is streamed to the dashboard.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { round2 } from '@/lib/calculations/currency'
import { UNIT_KIND_LABEL } from './engine'
import { isInstalled, loadShares } from './load'

export interface UnitStripItem {
  slug: string
  name: string
  color: string | null
  kind: string
  incomeInr: number
  resultInr: number
  /** "December 2026" when the unit has not started yet — figures are a preview. */
  startsLabel: string | null
}

export interface UnitsStrip {
  monthLabel: string
  units: UnitStripItem[]
  /** Collected this month on invoices that belong to no unit. */
  noUnitIncomeInr: number
}

const label = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadUnitsStrip(admin: SupabaseClient<any, any, any>, month: string): Promise<UnitsStrip | null> {
  if (!(await isInstalled(admin))) return null
  const shares = await loadShares(admin, { fromMonth: month, toMonth: month, ignoreStart: true })
  // ignoreStart moves each ledger's start to this month; the real start is on
  // the unit as loaded.
  const startOf = new Map(shares.departments.map(d => [d.id, d.startsOn.slice(0, 7)]))
  const units = shares.result.ledgers.filter(l => l.department.isActive).map(l => {
    const m = l.months[0]
    const d = l.department
    const start = startOf.get(d.id) ?? d.startsOn.slice(0, 7)
    return {
      slug: d.slug, name: d.name, color: d.color, kind: UNIT_KIND_LABEL[d.kind].one,
      incomeInr: round2((m?.incomeInr ?? 0) + (m?.otherIncomeInr ?? 0)),
      resultInr: round2(m?.resultInr ?? 0),
      startsLabel: start > month ? label(start) : null,
    }
  })
  if (!units.length) return null
  return {
    monthLabel: label(month),
    units,
    noUnitIncomeInr: round2(shares.result.unassignedIncome.reduce((t, r) => t + r.collectedInr, 0)),
  }
}

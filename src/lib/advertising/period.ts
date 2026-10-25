/**
 * Reporting periods for the advertising screens.
 *
 * One small set of named periods shared by the overview, client workspace
 * and campaign page, so "last 30 days" means the same days everywhere. All
 * dates are business-calendar (India) YYYY-MM-DD strings; ranges are
 * inclusive. `lifetime` has no lower bound.
 */

import { addDaysISO } from '@/lib/utils/local-date'

export type PeriodKey = '7d' | '30d' | 'this_month' | 'last_month' | 'lifetime'

export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: '7d',         label: 'Last 7 days' },
  { key: '30d',        label: 'Last 30 days' },
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'lifetime',   label: 'Lifetime' },
]

export const DEFAULT_PERIOD: PeriodKey = '30d'

export function isPeriodKey(v: unknown): v is PeriodKey {
  return typeof v === 'string' && PERIODS.some(p => p.key === v)
}

export interface PeriodRange {
  key: PeriodKey
  /** null = no lower bound (lifetime). */
  from: string | null
  to: string
  label: string
}

/** The inclusive date range for a period, relative to `today` (YYYY-MM-DD). */
export function periodRange(key: PeriodKey, today: string): PeriodRange {
  const label = PERIODS.find(p => p.key === key)?.label ?? key
  const [y, m] = today.split('-').map(Number)
  const pad = (n: number) => String(n).padStart(2, '0')
  switch (key) {
    case '7d':  return { key, label, from: addDaysISO(today, -6), to: today }
    case '30d': return { key, label, from: addDaysISO(today, -29), to: today }
    case 'this_month': return { key, label, from: `${y}-${pad(m)}-01`, to: today }
    case 'last_month': {
      const py = m === 1 ? y - 1 : y
      const pm = m === 1 ? 12 : m - 1
      const last = new Date(Date.UTC(py, pm, 0)).getUTCDate()
      return { key, label, from: `${py}-${pad(pm)}-01`, to: `${py}-${pad(pm)}-${pad(last)}` }
    }
    case 'lifetime':
    default:
      return { key: 'lifetime', label: 'Lifetime', from: null, to: today }
  }
}

/** Rows whose metric_date falls inside the range. */
export function rowsInPeriod<T extends { metric_date: string }>(rows: T[], range: PeriodRange): T[] {
  return rows.filter(r => (range.from == null || r.metric_date >= range.from) && r.metric_date <= range.to)
}

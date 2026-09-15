import type { DateFilterValue } from '@/components/ui/date-filter'
import type { DateWindow } from './view'

/**
 * The date filter, expressed as a plain window.
 *
 * `matchesDateFilter` answers "is this date in the filter" one date at a time,
 * which is all a row-by-row scan ever needed. Day and month aggregates need
 * the same question asked once, as a range — so this turns the filter into its
 * bounds, and the aggregate view does the rest.
 *
 * Returns null for "no filter", meaning the whole window.
 */
export function dateFilterWindow(filter: DateFilterValue): DateWindow | null {
  if (!filter) return null
  const d = (date: Date) => date.toISOString().slice(0, 10)
  const today = new Date()
  today.setHours(12, 0, 0, 0)

  const daysAgo = (n: number) => {
    const x = new Date(today)
    x.setDate(x.getDate() - n)
    return x
  }
  const monthBounds = (year: number, month0: number): DateWindow => ({
    from: `${year}-${String(month0 + 1).padStart(2, '0')}-01`,
    to: d(new Date(Date.UTC(year, month0 + 1, 0))),
  })

  switch (filter.type) {
    case 'today':     return { from: d(today), to: d(today) }
    case 'yesterday': return { from: d(daysAgo(1)), to: d(daysAgo(1)) }
    case 'last7':     return { from: d(daysAgo(6)), to: d(today) }
    case 'last30':    return { from: d(daysAgo(29)), to: d(today) }
    case 'thisMonth': return monthBounds(today.getFullYear(), today.getMonth())
    case 'lastMonth': {
      const m = today.getMonth() - 1
      return m < 0 ? monthBounds(today.getFullYear() - 1, 11) : monthBounds(today.getFullYear(), m)
    }
    case 'month':     return monthBounds(filter.year, filter.month)
    case 'day':       return { from: filter.date, to: filter.date }
    case 'range':     return { from: filter.from, to: filter.to }
    default:          return null
  }
}

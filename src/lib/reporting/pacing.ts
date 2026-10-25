/**
 * Time-aware expected spend.
 *
 * Health used to compare a period's spend with the WHOLE campaign budget, so
 * a 30-day campaign reported after its first week was always "severely
 * underspending". Expected spend is the budget share for the campaign days
 * that fall inside the report period and have already happened.
 *
 * Returns null when the campaign has no budget or no start/end dates: pacing
 * then cannot be judged and must not be scored. Pauses are not modelled —
 * there is no pause history to read — so a paused campaign reads as behind.
 */

import { daySpan } from './config'

export function expectedSpendForPeriod(opts: {
  budget: number
  campaignStart: string | null
  campaignEnd: string | null
  periodFrom: string
  periodTo: string
  /** Today on the business calendar (YYYY-MM-DD); days after it have not happened. */
  today: string
}): number | null {
  const { budget, campaignStart, campaignEnd, periodFrom, periodTo, today } = opts
  if (!(budget > 0) || !campaignStart || !campaignEnd || campaignStart > campaignEnd) return null

  const totalDays = daySpan(campaignStart, campaignEnd)
  const from = maxISO(campaignStart, periodFrom)
  const to = minISO(campaignEnd, periodTo, today)
  if (from > to) return 0
  return budget * (daySpan(from, to) / totalDays)
}

const maxISO = (...d: string[]) => d.reduce((a, b) => (b > a ? b : a))
const minISO = (...d: string[]) => d.reduce((a, b) => (b < a ? b : a))

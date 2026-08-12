/**
 * The money badge for a retainer-covered task.
 *
 * A covered task bills the client 0 — the monthly retainer IS the invoice — so
 * every screen that shows task money has to answer "then what is the team paid
 * from?". The answer is the agreement item's work value, stamped onto the task
 * as `work_value` (agreement currency) and `work_value_inr` (pool currency).
 *
 * This lives in one place because Tasks and Contributions previously rendered
 * that number two different ways: Tasks as a labelled ⇄ badge, Contributions as
 * a bare "₹519.91" indistinguishable from client billing. Same figure, two
 * meanings on screen.
 *
 * Quoted in the AGREEMENT's currency when we have it, so the number is
 * checkable against the signed contract without reversing an exchange rate in
 * your head; the INR the pool actually runs on rides along in the tooltip, but
 * only when the agreement is billed in something other than rupees.
 *
 * The label/tooltip maths is a pure function so it can be tested without a DOM
 * — every covered task in the database is currently quantity 1, so the
 * per-unit branch would otherwise never be exercised by anything.
 */

import { Repeat } from 'lucide-react'
import { formatCurrency } from '@/lib/calculations/currency'
import type { Currency } from '@/types'

export interface CoveredValueTask {
  work_value?: number | null
  work_value_currency?: string | null
  work_value_inr?: number | null
}

export interface CoveredValueDisplay {
  /** Badge text — the work value, per unit when quantity > 1. */
  label: string
  tooltip: string
  /** False when the agreement item has no work value, so this pays nothing. */
  hasValue: boolean
}

/**
 * What the badge says.
 *
 * `divideBy` is the task quantity: pass it to get the per-unit rate, mirroring
 * how an uncovered task's rate is `billing_amount / quantity`. A one-time item
 * is quantity 1, so per-unit and full work value are the same number — correct
 * rather than a special case: there is one unit and it is worth the whole thing.
 */
export function coveredValueDisplay(
  task: CoveredValueTask,
  divideBy = 1,
): CoveredValueDisplay {
  const native = task.work_value ?? null
  const inr = task.work_value_inr ?? 0
  const qty = divideBy || 1
  const hasValue = native != null ? native > 0 : inr > 0

  const currency = (task.work_value_currency || 'INR') as Currency
  const shown = native != null
    ? formatCurrency(native / qty, currency)
    : formatCurrency(inr / qty, 'INR' as Currency)

  const unitSuffix = qty > 1 ? ' / unit' : ''

  // Only worth restating in rupees when the agreement bills in something else.
  // Since work values were converted to INR the two are usually the identical
  // number, and "₹519.91 pays the team (₹519.91)" reads like a bug.
  const showInrAside = inr > 0 && native != null && currency !== 'INR'

  const covered = 'Covered by retainer — the client pays the monthly fee, not this task. '

  return {
    hasValue,
    label: hasValue ? `${shown}${unitSuffix}` : 'No work value',
    tooltip: hasValue
      ? covered
        + `Agreement work value ${shown}${unitSuffix} pays the team`
        + (showInrAside ? ` (₹${(inr / qty).toLocaleString('en-IN')}${unitSuffix}).` : '.')
      : covered
        + 'No work value is set on the agreement item yet, so this pays contributors nothing.',
  }
}

export function CoveredValue({
  task,
  divideBy = 1,
  className = '',
}: {
  task: CoveredValueTask
  /** Pass the task quantity to show the per-unit rate instead of the total. */
  divideBy?: number
  className?: string
}) {
  const { label, tooltip, hasValue } = coveredValueDisplay(task, divideBy)

  const tone = hasValue
    ? 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/25'
    : 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25'

  return (
    <span
      title={tooltip}
      className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border whitespace-nowrap ${tone} ${className}`}
    >
      <Repeat className="w-3 h-3 shrink-0" aria-hidden />
      {label}
    </span>
  )
}

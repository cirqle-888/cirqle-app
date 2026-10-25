'use client'

// Dashboard — what is still to be paid to one person: unpaid payslips plus the
// month so far. Figures come from lib/dashboard/pending-pay.ts (unit-tested);
// this file is presentation only.

import Link from 'next/link'
import type { PendingPay } from '@/lib/dashboard/pending-pay'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function PendingPayPanel({ who, pending, thisMonthInr, monthLabel, fmt, onClose }: {
  /** The employee's label, already privacy-resolved by the caller. */
  who: string
  pending: PendingPay | undefined
  thisMonthInr: number
  monthLabel: string
  fmt: (v: number) => string
  onClose: () => void
}) {
  const slips = pending?.slips ?? []
  const total = (pending?.slipsTotalInr ?? 0) + thisMonthInr
  const cell = 'px-3 py-2 whitespace-nowrap'
  const num = `${cell} text-right font-mono tabular-nums`
  return (
    <div className="mx-3 mb-3 rounded-xl border border-amber-500/30 bg-amber-500/5">
      <div className="px-4 py-3 flex items-start justify-between gap-3 border-b border-amber-500/20">
        <div>
          <p className="text-sm font-semibold">{who}: <span className="text-amber-500">{fmt(total)}</span> to be paid</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">Unpaid payslips plus {monthLabel} so far. Not affected by the period filter.</p>
        </div>
        <button type="button" onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground shrink-0">Close</button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted-foreground border-b border-border/60">
              <th className="px-3 py-2 text-left font-semibold">For</th>
              <th className="px-3 py-2 text-left font-semibold">Payslip</th>
              <th className="px-3 py-2 text-right font-semibold">Contribution</th>
              <th className="px-3 py-2 text-right font-semibold">Ownership</th>
              <th className="px-3 py-2 text-right font-semibold">Other</th>
              <th className="px-3 py-2 text-right font-semibold">To pay</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {slips.map(s => (
              <tr key={`${s.year}-${s.month}`}>
                <td className={cell}>{MONTHS[s.month - 1]} {s.year}</td>
                <td className={`${cell} text-muted-foreground`}>{s.payslipNumber ?? 'Pending'}</td>
                <td className={num}>{fmt(s.commissionInr)}</td>
                <td className={num}>{fmt(s.ownershipInr)}</td>
                <td className={num}>{fmt(s.otherInr)}</td>
                <td className={`${num} font-semibold`}>{fmt(s.netInr)}</td>
              </tr>
            ))}
            {thisMonthInr > 0 && (
              <tr>
                <td className={cell}>{monthLabel}</td>
                <td className={`${cell} text-muted-foreground`}>Not generated yet</td>
                <td className={num}>{fmt(thisMonthInr)}</td>
                <td className={num}>—</td>
                <td className={num}>—</td>
                <td className={`${num} font-semibold`}>{fmt(thisMonthInr)}</td>
              </tr>
            )}
            {slips.length === 0 && thisMonthInr <= 0 && (
              <tr><td className={`${cell} text-muted-foreground`} colSpan={6}>Nothing to be paid.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-2.5 border-t border-amber-500/20 text-[11px] text-muted-foreground">
        {monthLabel} is contribution earned on this month’s tasks, before any bonus, adjustment or advance, which the payslip adds when it is generated.
        {(pending?.zeroSlips ?? 0) > 0 && <> {pending!.zeroSlips} more payslip{pending!.zeroSlips === 1 ? ' is' : 's are'} worth ₹0 and still open; marking {pending!.zeroSlips === 1 ? 'it' : 'them'} paid in Payroll clears {pending!.zeroSlips === 1 ? 'it' : 'them'}.</>}
        {' '}<Link href="/dashboard/payroll" className="text-primary hover:underline">Open Payroll →</Link>
      </p>
    </div>
  )
}

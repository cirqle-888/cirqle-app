/**
 * Closing a payslip that was paid outside the app (cash, an old bank transfer
 * from before the Cash Book was kept, a month settled by hand).
 *
 * Mark Paid writes a salary outflow into TODAY's Cash Book. For a payslip
 * from 2024 that is a fake payment: it moves today's balance and breaks bank
 * reconciliation. Closing marks the payslip paid and writes nothing to the
 * Cash Book.
 *
 * The paid date is the last day of the payslip's month (when salaries for
 * that month were due), or today if that day is still ahead.
 */
export function closedPaidDate(month: number, year: number, today: string): string {
  // Day 0 of the next month is the last day of this one.
  const last = new Date(Date.UTC(year, month, 0))
  const iso = last.toISOString().slice(0, 10)
  return iso > today ? today : iso
}

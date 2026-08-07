/**
 * The message shown after a contribution is saved into a CLOSED month.
 *
 * Lives here, not inline at the call sites, because two screens save
 * contributions (the Contributions page and the task-modal panel) and a
 * correction that is described differently depending on which screen you used
 * reads as two different behaviours. It is one behaviour.
 *
 * This is deliberately NOT an error. The save succeeded; the books did not
 * move. Saying "failed" would be false, and saying only "saved" would hide the
 * fact that the money is riding on a later payroll — so the notice states both
 * halves: what changed (the work record) and what did not (payroll history).
 *
 * Pure — no imports, safe in both client and server components.
 */

export interface CorrectionNotice {
  title: string
  body: string
}

export function closedPeriodNotice(
  month: string | undefined,
  adjustmentsRecorded: number | undefined,
): CorrectionNotice {
  const label = month ?? 'a closed period'
  const n = adjustmentsRecorded ?? 0

  if (n > 0) {
    return {
      title: `Saved as a ${label} correction`,
      body:
        `Historical payroll was not changed. ${n} prior-period adjustment${n === 1 ? '' : 's'} `
        + 'queued — the difference will be paid with the next open payroll.',
    }
  }

  // Zero is a normal outcome, not a failure, and it has two innocent causes.
  // Naming both stops it reading as "the correction did not work".
  return {
    title: `Saved as a ${label} correction`,
    body:
      'Historical payroll was not changed. No adjustment was queued — either the difference '
      + 'is under ₹1, or that month has not been paid yet and its own payroll will pick up the '
      + 'new figures. Run Check corrections on the month card to re-scan.',
  }
}

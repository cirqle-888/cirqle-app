/**
 * Finance Engine — employee cost split math (pure).
 *
 * An expense shared across N employees (e.g. one Photoshop seat used by two
 * designers) is divided equally; any rounding remainder (paisa left over
 * from an inexact division) is distributed one unit at a time to the first
 * employees in the given order, so the parts always sum EXACTLY to the
 * total — the split can never silently drift from the cashbook entry.
 */

export interface EmployeeSplitShare {
  employeeId: string
  amount: number
}

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100

/**
 * Split `total` equally across `employeeIds`. Order only decides where the
 * rounding remainder lands (the first N employees get the extra paisa).
 * Returns [] for an empty/duplicate-only list or a non-positive total.
 */
export function computeEqualSplit(total: number, employeeIds: string[]): EmployeeSplitShare[] {
  const ids = [...new Set(employeeIds.filter(Boolean))]
  if (ids.length === 0 || total <= 0) return []

  const cents = Math.round(total * 100)
  const baseCents = Math.floor(cents / ids.length)
  const remainder = cents - baseCents * ids.length   // 0..ids.length-1 leftover paisa

  return ids.map((employeeId, i) => ({
    employeeId,
    amount: round2((baseCents + (i < remainder ? 1 : 0)) / 100),
  }))
}

/** True when a set of split shares reconciles to `total` within rounding tolerance. */
export function splitsReconcile(shares: EmployeeSplitShare[], total: number): boolean {
  const sum = round2(shares.reduce((s, x) => s + x.amount, 0))
  return Math.abs(sum - round2(total)) <= 0.01
}

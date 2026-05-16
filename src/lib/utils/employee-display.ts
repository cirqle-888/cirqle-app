/**
 * CQID-first employee display.
 *
 * Default: show `CQID00X` everywhere.
 * Admin reveal toggle is the only way to expose real names, and only in admin-side views.
 * Non-admin viewers never see names regardless of toggle state.
 */
export interface EmployeeLike {
  cqid?: string | null
  name?: string | null
}

export function displayEmployee(
  emp: EmployeeLike | null | undefined,
  opts: { revealNames?: boolean; canReveal?: boolean } = {}
): string {
  if (!emp) return '—'
  const cqid = emp.cqid ?? ''
  const name = emp.name ?? ''
  if (opts.revealNames && opts.canReveal && name) return name
  return cqid || name || '—'
}

/**
 * For UI chips where we want both — CQID prominent, name as a hover tooltip (admin only).
 */
export function employeeTooltip(
  emp: EmployeeLike | null | undefined,
  opts: { revealNames?: boolean; canReveal?: boolean } = {}
): string {
  if (!emp || !opts.canReveal) return ''
  return opts.revealNames ? (emp.cqid ?? '') : (emp.name ?? '')
}

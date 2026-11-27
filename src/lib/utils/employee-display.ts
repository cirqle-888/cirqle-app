/**
 * CQID-only employee display.
 *
 * An employee's real name is private and is never shown anywhere in the app:
 * people are identified by `CQID00X`, for every viewer, admins included. There
 * is no reveal — the options below are accepted so older call sites keep
 * type-checking, and are ignored.
 *
 * The strongest protection is upstream: do not load `name` from the database
 * at all (scripts/check-name-privacy.mjs fails the build on a new read). This
 * helper is the second line — if a name does arrive, it still is not shown.
 */
export interface EmployeeLike {
  cqid?: string | null
  /** Accepted for compatibility with older row shapes. Never read. */
  name?: string | null
}

export function displayEmployee(
  emp: EmployeeLike | null | undefined,
  _opts?: { revealNames?: boolean; canReveal?: boolean },
): string {
  void _opts // accepted for older call sites; there is no reveal
  return emp?.cqid || '—'
}

/** Kept for older call sites. A name is never offered, not even on hover. */
export function employeeTooltip(
  _emp: EmployeeLike | null | undefined,
  _opts?: { revealNames?: boolean; canReveal?: boolean },
): string {
  void _emp; void _opts // accepted for older call sites; a name is never offered
  return ''
}

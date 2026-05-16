/**
 * Birthday helpers — compare month-day only, ignore year.
 */

export function isBirthdayToday(dob: string | null | undefined, now: Date = new Date()): boolean {
  if (!dob) return false
  const d = new Date(dob)
  if (Number.isNaN(d.getTime())) return false
  return d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
}

export function daysUntilBirthday(dob: string | null | undefined, now: Date = new Date()): number | null {
  if (!dob) return null
  const d = new Date(dob)
  if (Number.isNaN(d.getTime())) return null
  const thisYear = new Date(now.getFullYear(), d.getMonth(), d.getDate())
  if (thisYear < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
    thisYear.setFullYear(now.getFullYear() + 1)
  }
  const ms = thisYear.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return Math.round(ms / (1000 * 60 * 60 * 24))
}

/** Cookie-friendly key used to suppress the celebration banner after the user dismisses it. */
export function birthdayDismissKey(employeeId: string, now: Date = new Date()): string {
  return `cirqle.bday.${employeeId}.${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

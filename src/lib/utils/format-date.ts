/**
 * Standard date formatter — strict DD-MM-YYYY format.
 *   Input:  "2026-05-18"  (ISO YYYY-MM-DD)
 *   Output: "18-05-2026"
 */
export function formatTaskDate(iso: string | null | undefined): string {
  if (!iso) return ''
  // Fast path: parse the ISO string directly to avoid timezone surprises
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (m) return `${m[3]}-${m[2]}-${m[1]}`
  // Fallback for any other input — try Date and reformat
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  return `${dd}-${mm}-${yyyy}`
}

/**
 * Tooltip helper — long-form with weekday and month name.
 *   "Monday, 18 May 2026"
 */
export function fullTaskDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

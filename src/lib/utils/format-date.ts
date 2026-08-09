/**
 * Shared display-date helpers.
 *
 * These are for RENDERING ONLY. Never use them to build a value that is stored,
 * queried or compared — anything the database sees must stay ISO (YYYY-MM-DD).
 */

const EM_DASH = '—'

/**
 * Parse anything a call site might hand us into a Date, or null if it is not
 * usable. Bare `YYYY-MM-DD` is pinned to local midnight so the day never slips
 * across a timezone boundary.
 */
function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const s = value.trim()
  if (!s) return null
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * The house style for a date on screen.
 *   "12 Aug 2026"
 * Anything unusable (null, undefined, '', junk) renders as an em-dash.
 */
export function formatDate(value: string | number | Date | null | undefined): string {
  const d = toDate(value)
  if (!d) return EM_DASH
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * The house style for a timestamp on screen.
 *   "12 Aug 2026, 02:05 pm"
 * Same em-dash fallback as {@link formatDate}.
 */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  const d = toDate(value)
  if (!d) return EM_DASH
  return d.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

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

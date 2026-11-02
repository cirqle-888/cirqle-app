/**
 * Where it is safe to send someone back to: a path on this site, nothing else.
 *
 * Used for the `?next=` the proxy adds when a request is bounced to /login, and
 * for the last page an installed app reopens on. Both values round-trip through
 * the URL or localStorage, so both are untrusted — an unchecked `next` is an
 * open redirect (`?next=//evil.example`, `?next=/\evil.example`).
 *
 * Returns null for anything else, and the caller falls back to /dashboard.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 2000) return null
  // One leading slash: "//host" and "/\host" are read by browsers as another origin.
  if (!raw.startsWith('/') || raw.startsWith('//')) return null
  if (raw.includes('\\') || /[\u0000-\u001f\u007f]/.test(raw)) return null
  // Never send someone back into the screens that sent them here (a loop), or
  // to an API route (JSON, not a page).
  if (/^\/(login|forgot-password|reset-password|register|api)(?:[/?#]|$)/.test(raw)) return null
  return raw
}

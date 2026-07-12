/**
 * cirqle:// deep-link → in-app route resolver.
 *
 * Browser-safe and dependency-free so it can run inside the Capacitor WebView
 * (App plugin `appUrlOpen`) and be unit-tested. Mirrors the desktop mapping in
 * desktop/src/main/deeplinks.js — keep the two ROUTES tables in sync.
 *
 *   cirqle://dashboard | tasks | quotations | invoices | payroll | settings
 *   cirqle://tasks/123                    → /dashboard/tasks/123
 *   cirqle://open?path=/dashboard/foo     → /dashboard/foo   (escape hatch)
 */

const PROTOCOL = 'cirqle'

/** host → in-app path. Extend alongside desktop's ROUTES. */
export const DEEP_LINK_ROUTES: Record<string, string> = {
  dashboard: '/dashboard',
  tasks: '/dashboard/tasks',
  quotations: '/dashboard/quotations',
  invoices: '/dashboard/invoices',
  payroll: '/dashboard/payroll',
  settings: '/dashboard/settings',
}

/**
 * Resolve a cirqle:// URL to an in-app absolute path, or null if it isn't a
 * recognized deep link. Never returns an off-site or relative destination.
 */
export function routeForDeepLink(rawUrl: string): string | null {
  let u: URL
  try { u = new URL(rawUrl) } catch { return null }
  if (u.protocol !== `${PROTOCOL}:`) return null

  if (u.host === 'open') {
    const p = u.searchParams.get('path')
    // Only in-app absolute paths — never let a link steer navigation off-site.
    if (p && p.startsWith('/') && !p.startsWith('//')) return p
    return null
  }

  const base = DEEP_LINK_ROUTES[u.host]
  if (!base) return null
  // cirqle://tasks/123 → /dashboard/tasks/123
  return base + (u.pathname && u.pathname !== '/' ? u.pathname : '')
}

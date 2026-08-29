/**
 * Last-route memory for the Capacitor native shell.
 *
 * WHY THIS EXISTS: Capacitor always boots the WebView at `server.url`
 * (Bridge.java's `webView.loadUrl(appUrl)`), and ours is the site ROOT —
 * which the web app redirects to /dashboard. Nothing saves the WebView's URL:
 * Capacitor's saved instance state persists a pending plugin call and nothing
 * else. So an Android process death or a swipe-away relaunch silently drops
 * whatever page the user was on and drops them on the dashboard. There is no
 * fix available inside the native wrapper — Capacitor's own `reload()` is
 * `loadUrl(appUrl)` too — so the web app remembers the route instead.
 *
 * NATIVE ONLY. Callers gate on isNative(). The browser and the Electron
 * desktop app reload in place correctly on their own and must not be touched.
 *
 * The functions below are pure apart from storage access, so they are unit
 * tested directly against a fake window in ./last-route.test.ts.
 */

/** Where the route lives across app launches. */
const ROUTE_KEY = 'cirqle.native.lastRoute'
/**
 * Per-WebView-session "already restored" flag. sessionStorage is scoped to the
 * browsing context and is never written to disk, so a relaunched WebView gets
 * a clean one — which is exactly the "once per app launch" semantics we want.
 * If storage is unavailable the flag reads as consumed and we simply do not
 * restore: degrading to today's behaviour is the safe direction.
 */
const RESTORED_FLAG = 'cirqle.native.routeRestored'

/** Older than this and the route is not worth returning to. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Only /dashboard routes are ever stored or restored.
 *
 * - Keeps tokenised URLs (/portal, /intake, /i/, /feed/, /start/, /careers)
 *   out of localStorage — those tokens are bearer credentials.
 * - Rejects protocol-relative values like "//evil.com", which router.replace
 *   would treat as an external navigation.
 */
const DASHBOARD_ROUTE = /^\/dashboard(?:[/?#]|$)/

/** The landing page a cold start always arrives on. */
const DASHBOARD_HOME = '/dashboard'

interface StoredRoute { path: string; ts: number }

function store(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  try {
    if (typeof window === 'undefined') return null
    return window[kind]
  } catch {
    return null // storage disabled / partitioned
  }
}

/** True for a value we are willing to navigate to. */
export function isRestorableRoute(path: unknown): path is string {
  return typeof path === 'string' && path.length <= 2048 && DASHBOARD_ROUTE.test(path)
}

/**
 * Record the page the user is on. Non-dashboard routes are ignored rather than
 * cleared, so passing through /login on the way back in does not wipe the
 * route the user actually wants.
 */
export function rememberRoute(path: string, now: number = Date.now()): void {
  if (!isRestorableRoute(path)) return
  const ls = store('localStorage')
  if (!ls) return
  try {
    ls.setItem(ROUTE_KEY, JSON.stringify({ path, ts: now } satisfies StoredRoute))
  } catch {
    // Quota or private mode — the restore just won't happen.
  }
}

/**
 * Decide where a freshly launched shell should go, and burn the once-per-launch
 * flag so this can never fire twice (React re-mounts, StrictMode's double
 * effect, or a restore target that bounces us back to /dashboard).
 *
 * Returns null — meaning "stay put" — unless ALL of these hold:
 *   - this WebView session has not already restored,
 *   - we are sitting on the bare /dashboard landing page, so an intentional
 *     navigation anywhere else is never hijacked,
 *   - the middleware did not just bounce us here (?denied=1); restoring would
 *     only bounce us again,
 *   - a stored route exists, is a /dashboard route, is fresh, and is not
 *     already where we are.
 */
export function consumeRestoreRoute(current: string, now: number = Date.now()): string | null {
  const ss = store('sessionStorage')
  // No sessionStorage means no once-per-launch guard, and an unguarded restore
  // could loop. Fail closed.
  if (!ss) return null
  try {
    if (ss.getItem(RESTORED_FLAG)) return null
    ss.setItem(RESTORED_FLAG, '1')
  } catch {
    return null
  }

  const [pathname, query = ''] = current.split('?')
  if (pathname !== DASHBOARD_HOME) return null
  if (new URLSearchParams(query).has('denied')) return null

  const ls = store('localStorage')
  if (!ls) return null

  let saved: StoredRoute | null = null
  try {
    const raw = ls.getItem(ROUTE_KEY)
    saved = raw ? (JSON.parse(raw) as StoredRoute) : null
  } catch {
    return null // absent or corrupt
  }

  if (!saved || !isRestorableRoute(saved.path)) return null
  if (typeof saved.ts !== 'number' || !(now - saved.ts < MAX_AGE_MS)) return null
  if (saved.path === current || saved.path === DASHBOARD_HOME) return null

  return saved.path
}

/**
 * One pass of the native shell's route effect, in the order that matters:
 * restore first (so the /dashboard landing page cannot overwrite the route we
 * are about to return to), record only if we are staying put.
 *
 * Lives here rather than inline in the component so the launch sequence is
 * directly testable — see ./last-route.test.ts.
 */
export function syncRoute(
  current: string,
  navigate: (to: string) => void,
  now: number = Date.now(),
): void {
  const target = consumeRestoreRoute(current, now)
  if (target) {
    navigate(target)
    return
  }
  rememberRoute(current, now)
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rememberRoute, consumeRestoreRoute, isRestorableRoute, syncRoute } from './last-route'

/** Minimal in-memory Storage. `failOn` makes one method throw, as a locked-down
 *  or quota-exhausted WebView would. */
function fakeStorage(failOn?: 'get' | 'set'): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => {
      if (failOn === 'get') throw new Error('blocked')
      return map.get(k) ?? null
    },
    setItem: (k: string, v: string) => {
      if (failOn === 'set') throw new Error('quota')
      map.set(k, v)
    },
    removeItem: (k: string) => { map.delete(k) },
    clear: () => { map.clear() },
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size },
  } as Storage
}

/** A new WebView session: sessionStorage is wiped, localStorage survives. */
function installWindowKeepingLocal() {
  const win = (globalThis as { window?: { localStorage: Storage } }).window
  installWindow({ local: win?.localStorage, session: fakeStorage() })
}

function installWindow(opts: { local?: Storage | 'throws'; session?: Storage | 'throws' } = {}) {
  const local = opts.local ?? fakeStorage()
  const session = opts.session ?? fakeStorage()
  const win: Record<string, unknown> = {}
  Object.defineProperty(win, 'localStorage', {
    get() { if (local === 'throws') throw new Error('denied'); return local },
  })
  Object.defineProperty(win, 'sessionStorage', {
    get() { if (session === 'throws') throw new Error('denied'); return session },
  })
  ;(globalThis as { window?: unknown }).window = win
}

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

beforeEach(() => installWindow())
afterEach(() => { delete (globalThis as { window?: unknown }).window })

describe('isRestorableRoute', () => {
  it('accepts dashboard routes, with or without query', () => {
    expect(isRestorableRoute('/dashboard')).toBe(true)
    expect(isRestorableRoute('/dashboard/tasks')).toBe(true)
    expect(isRestorableRoute('/dashboard/tasks?status=open')).toBe(true)
  })

  it('rejects everything outside the dashboard', () => {
    // Tokenised surfaces — these URLs are bearer credentials.
    expect(isRestorableRoute('/portal/abc-token')).toBe(false)
    expect(isRestorableRoute('/intake/offer/tok')).toBe(false)
    expect(isRestorableRoute('/i/inv-token')).toBe(false)
    expect(isRestorableRoute('/login')).toBe(false)
    // Prefix confusion and protocol-relative escapes.
    expect(isRestorableRoute('/dashboardXYZ')).toBe(false)
    expect(isRestorableRoute('//evil.com')).toBe(false)
    expect(isRestorableRoute('https://evil.com/dashboard')).toBe(false)
    expect(isRestorableRoute(null)).toBe(false)
    expect(isRestorableRoute(42)).toBe(false)
  })
})

describe('rememberRoute + consumeRestoreRoute', () => {
  it('restores the last dashboard page on a fresh launch', () => {
    rememberRoute('/dashboard/tasks?status=open', NOW)
    expect(consumeRestoreRoute('/dashboard', NOW + 1000)).toBe('/dashboard/tasks?status=open')
  })

  it('only fires once per WebView session', () => {
    rememberRoute('/dashboard/tasks', NOW)
    expect(consumeRestoreRoute('/dashboard', NOW)).toBe('/dashboard/tasks')
    // A second mount (React StrictMode, a re-mount, or a bounce back to
    // /dashboard) must not navigate again.
    expect(consumeRestoreRoute('/dashboard', NOW)).toBeNull()
  })

  it('leaves normal in-app navigation alone', () => {
    rememberRoute('/dashboard/tasks', NOW)
    // Launched straight into another page (e.g. a deep link) — stay there.
    expect(consumeRestoreRoute('/dashboard/clients', NOW)).toBeNull()
  })

  it('does not restore when the middleware bounced us here', () => {
    rememberRoute('/dashboard/payroll', NOW)
    // Restoring would just bounce off the permission gate again.
    expect(consumeRestoreRoute('/dashboard?denied=1', NOW)).toBeNull()
  })

  it('ignores a route older than a week', () => {
    rememberRoute('/dashboard/tasks', NOW)
    expect(consumeRestoreRoute('/dashboard', NOW + 7 * DAY + 1)).toBeNull()
  })

  it('keeps a route just under the age limit', () => {
    rememberRoute('/dashboard/tasks', NOW)
    expect(consumeRestoreRoute('/dashboard', NOW + 7 * DAY - 1)).toBe('/dashboard/tasks')
  })

  it('does not redirect the dashboard to itself', () => {
    rememberRoute('/dashboard', NOW)
    expect(consumeRestoreRoute('/dashboard', NOW)).toBeNull()
  })

  it('never records non-dashboard routes', () => {
    rememberRoute('/portal/secret-token', NOW)
    rememberRoute('/login', NOW)
    expect(consumeRestoreRoute('/dashboard', NOW)).toBeNull()
  })

  it('does not clear a good route when passing through /login', () => {
    rememberRoute('/dashboard/tasks', NOW)
    rememberRoute('/login', NOW)
    expect(consumeRestoreRoute('/dashboard', NOW)).toBe('/dashboard/tasks')
  })
})

describe('hostile and degraded storage', () => {
  it('refuses a tampered off-site route', () => {
    const local = fakeStorage()
    local.setItem('cirqle.native.lastRoute', JSON.stringify({ path: '//evil.com', ts: NOW }))
    installWindow({ local })
    expect(consumeRestoreRoute('/dashboard', NOW)).toBeNull()
  })

  it('survives corrupt JSON', () => {
    const local = fakeStorage()
    local.setItem('cirqle.native.lastRoute', '{not json')
    installWindow({ local })
    expect(consumeRestoreRoute('/dashboard', NOW)).toBeNull()
  })

  it('survives a missing timestamp', () => {
    const local = fakeStorage()
    local.setItem('cirqle.native.lastRoute', JSON.stringify({ path: '/dashboard/tasks' }))
    installWindow({ local })
    expect(consumeRestoreRoute('/dashboard', NOW)).toBeNull()
  })

  it('fails closed when sessionStorage is unavailable', () => {
    // No once-per-launch guard means a restore could loop — so do nothing.
    installWindow({ session: 'throws' })
    rememberRoute('/dashboard/tasks', NOW)
    expect(consumeRestoreRoute('/dashboard', NOW)).toBeNull()
  })

  it('fails closed when sessionStorage writes throw', () => {
    installWindow({ session: fakeStorage('set') })
    rememberRoute('/dashboard/tasks', NOW)
    expect(consumeRestoreRoute('/dashboard', NOW)).toBeNull()
  })

  it('does not throw when localStorage writes are blocked', () => {
    installWindow({ local: fakeStorage('set') })
    expect(() => rememberRoute('/dashboard/tasks', NOW)).not.toThrow()
    expect(consumeRestoreRoute('/dashboard', NOW)).toBeNull()
  })

  it('does nothing at all on the server, where there is no window', () => {
    delete (globalThis as { window?: unknown }).window
    expect(() => rememberRoute('/dashboard/tasks', NOW)).not.toThrow()
    expect(consumeRestoreRoute('/dashboard', NOW)).toBeNull()
  })
})

/**
 * Drives syncRoute the way the shell's effect does: once on mount, then again
 * on every pathname change — including the one syncRoute itself causes. This
 * is the launch sequence, not a mock of it.
 */
function launch(startUrl: string, now = NOW) {
  const visited: string[] = []
  let url = startUrl
  const step = () => {
    visited.push(url)
    let next: string | null = null
    syncRoute(url, (to) => { next = to }, now)
    // A replace() changes the pathname, so React re-runs the effect.
    if (next && next.split('?')[0] !== url.split('?')[0]) { url = next; step() }
  }
  step()
  return { visited, final: url }
}

describe('launch sequence (as the shell effect drives it)', () => {
  it('lands the user back on their last page after a relaunch', () => {
    // Session 1: the user works, then the app is killed.
    launch('/dashboard')
    syncRoute('/dashboard/tasks?status=open', () => {}, NOW)

    // Session 2: a fresh WebView, so a fresh sessionStorage.
    installWindowKeepingLocal()
    const { final, visited } = launch('/dashboard')
    expect(visited).toEqual(['/dashboard', '/dashboard/tasks?status=open'])
    expect(final).toBe('/dashboard/tasks?status=open')
  })

  it('re-records the restored page, so the next relaunch works too', () => {
    launch('/dashboard')
    syncRoute('/dashboard/tasks', () => {}, NOW)

    installWindowKeepingLocal()
    expect(launch('/dashboard').final).toBe('/dashboard/tasks')

    installWindowKeepingLocal()
    expect(launch('/dashboard').final).toBe('/dashboard/tasks')
  })

  it('does not overwrite the saved route with the landing page', () => {
    syncRoute('/dashboard/clients/abc', () => {}, NOW)
    installWindowKeepingLocal()
    // The mount at /dashboard must read before it writes.
    expect(launch('/dashboard').final).toBe('/dashboard/clients/abc')
  })

  it('settles in one hop — no restore loop', () => {
    syncRoute('/dashboard/tasks', () => {}, NOW)
    installWindowKeepingLocal()
    expect(launch('/dashboard').visited).toHaveLength(2)
  })

  it('lets the user navigate to the dashboard on purpose', () => {
    launch('/dashboard')
    syncRoute('/dashboard/tasks', () => {}, NOW)
    // Same session: tapping the logo goes to /dashboard and STAYS there.
    let moved: string | null = null
    syncRoute('/dashboard', (to) => { moved = to }, NOW)
    expect(moved).toBeNull()
  })

  it('stays put when a deep link cold-starts the app elsewhere', () => {
    syncRoute('/dashboard/tasks', () => {}, NOW)
    installWindowKeepingLocal()
    expect(launch('/dashboard/leads').final).toBe('/dashboard/leads')
  })

  it('does not restore after signing in by hand', () => {
    syncRoute('/dashboard/payroll', () => {}, NOW)
    // Session 2 cold-starts logged out: /login burns the once-per-launch flag.
    installWindowKeepingLocal()
    syncRoute('/login', () => {}, NOW)
    let moved: string | null = null
    syncRoute('/dashboard', (to) => { moved = to }, NOW)
    expect(moved).toBeNull()
  })
})

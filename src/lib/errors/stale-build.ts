/**
 * "This tab is running an older build than the server."
 *
 * Cirqle deploys several times a day and the desktop app keeps tabs open for
 * hours. After a deploy, an old tab still holds the previous build's server
 * action ids and lazy-chunk file names. Its next background call (presence
 * heartbeat, chat polling) or lazy load (a chart) then fails, and with no
 * error boundary Next showed its bare "This page couldn't load" screen.
 *
 * These errors mean "reload to pick up the new build", not "something is
 * broken" — the error boundary reloads once instead of showing an error.
 */
const STALE_PATTERNS: RegExp[] = [
  /Server Action .* was not found on the server/i, // UnrecognizedActionError
  /failed-to-find-server-action/i,
  /ChunkLoadError/i,
  /Loading (CSS )?chunk [\w-]+ failed/i,            // webpack
  /Failed to load chunk/i,                           // Turbopack
  /Failed to fetch dynamically imported module/i,    // Chrome / Electron
  /Importing a module script failed/i,               // Safari
  /error loading dynamically imported module/i,      // Firefox
]

export function isStaleBuildError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { name?: unknown; message?: unknown }
  const text = `${typeof e.name === 'string' ? e.name : ''} ${typeof e.message === 'string' ? e.message : ''}`
  return STALE_PATTERNS.some(re => re.test(text))
}

/** sessionStorage key: when this tab last auto-reloaded for a stale build. */
export const STALE_RELOAD_KEY = 'cirqle:stale-build-reload'

/**
 * Reload at most once a minute, so a genuinely broken deploy (where reloading
 * cannot help) shows the error screen instead of reloading forever.
 */
export function shouldAutoReload(lastReloadAt: number | null, now: number): boolean {
  return lastReloadAt == null || now - lastReloadAt > 60_000
}

'use client'

import { createContext, useContext, useEffect, useState, ReactNode, useCallback, useMemo } from 'react'

/**
 * Theme system — light/dark with localStorage persistence + system preference fallback.
 *
 * Architecture (SSR-safe, zero hydration mismatch):
 *
 *   1. `public/theme-init.js` runs synchronously in <head> BEFORE React hydration.
 *      It reads localStorage (or `prefers-color-scheme`) and toggles the `.dark`
 *      class on <html>. This makes the first paint correct.
 *
 *   2. The CSS variables in globals.css cascade from `:root` (light) or `.dark`
 *      (dark). All theme-dependent visuals are driven by CSS, not React state.
 *
 *   3. Theme-dependent UI in components should use Tailwind's `dark:` variant
 *      (e.g. `block dark:hidden`) — NEVER `theme === 'dark' ? <A /> : <B />`,
 *      because that uses React state, which on SSR doesn't yet know what the
 *      browser will choose. Branching on React state causes hydration mismatch.
 *
 *   4. `useTheme()` still returns the current theme so handlers like
 *      `toggleTheme` know which way to flip — but the value is sourced from
 *      the DOM (via a post-mount effect), keeping React state in sync with
 *      whatever the init script set. Until that effect runs, `mounted` is
 *      false so callers that genuinely need the runtime value can wait.
 *
 *   5. `toggleTheme` reads the live class on <html> rather than relying on
 *      React state, so it works correctly even before the first sync effect.
 */

export type Theme = 'light' | 'dark'

interface ThemeContextType {
  /** Current theme. On server + first client render this is the SSR default
   *  ('dark'); becomes truthful after `mounted` flips. Treat as advisory unless
   *  `mounted` is also true. UI rendering should prefer CSS `dark:` classes. */
  theme: Theme
  /** True once the ThemeProvider has run its mount effect (i.e. client has
   *  loaded). Use this to gate runtime-only branches that need the real theme. */
  mounted: boolean
  setTheme: (t: Theme) => void
  toggleTheme: () => void
}

const STORAGE_KEY = 'cirqle.theme'
const SSR_DEFAULT: Theme = 'dark'

const ThemeContext = createContext<ThemeContextType>({
  theme: SSR_DEFAULT,
  mounted: false,
  setTheme: () => {},
  toggleTheme: () => {},
})

/**
 * Inline script as a fallback — kept for compatibility with anything that
 * imports it. Production uses /public/theme-init.js loaded in <head>.
 */
export const themeInitScript = `
(function(){
  try {
    var saved = localStorage.getItem('${STORAGE_KEY}');
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = saved === 'light' || saved === 'dark' ? saved : (prefersDark ? 'dark' : 'light');
    var root = document.documentElement;
    if (theme === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');
    root.style.colorScheme = theme;
  } catch (e) { /* localStorage blocked — fall back to whatever the CSS default is */ }
})();
`

/** Read the live theme from the DOM. Only safe to call on the client. */
function readDomTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // SSR-safe initial state: server and first client render both produce the
  // same value, so React never has to reconcile a mismatch.
  // Components must NOT branch JSX on `theme` until `mounted` is true —
  // prefer CSS `dark:` variants for theme-dependent visuals.
  const [theme, setThemeState] = useState<Theme>(SSR_DEFAULT)
  const [mounted, setMounted] = useState(false)

  // On mount, sync React state to whatever the inline init script set on <html>.
  // No JSX renders before this effect depend on `theme`, so the state update
  // does not cause visual flicker.
  useEffect(() => {
    setThemeState(readDomTheme())
    setMounted(true)
  }, [])

  // Apply theme to <html> and persist. Used by setTheme / toggleTheme.
  const applyTheme = useCallback((next: Theme) => {
    const root = document.documentElement
    if (next === 'dark') root.classList.add('dark')
    else root.classList.remove('dark')
    root.style.colorScheme = next
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // localStorage blocked — toggle still works for this session
    }
    setThemeState(next)
  }, [])

  const setTheme = useCallback((t: Theme) => applyTheme(t), [applyTheme])

  // Read from DOM rather than React state so the first toggle works correctly
  // even if the mount sync effect hasn't fired yet.
  const toggleTheme = useCallback(() => {
    const current: Theme =
      typeof document === 'undefined' ? theme : readDomTheme()
    applyTheme(current === 'dark' ? 'light' : 'dark')
  }, [theme, applyTheme])

  // Re-sync if another tab changes the preference.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEY || !e.newValue) return
      if (e.newValue === 'light' || e.newValue === 'dark') {
        applyTheme(e.newValue)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [applyTheme])

  // Stable value — consumers don't re-render when unrelated bits update.
  const value = useMemo<ThemeContextType>(
    () => ({ theme, mounted, setTheme, toggleTheme }),
    [theme, mounted, setTheme, toggleTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  return useContext(ThemeContext)
}

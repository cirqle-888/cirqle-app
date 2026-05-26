'use client'

import { createContext, useContext, useEffect, useState, ReactNode, useCallback, useMemo } from 'react'

/**
 * Theme system — light/dark/system with localStorage persistence.
 *
 * Architecture (SSR-safe, zero hydration mismatch):
 *
 *   1. `public/theme-init.js` runs synchronously in <head> BEFORE React hydration.
 *      It reads localStorage (or `prefers-color-scheme` for 'system'/absent) and
 *      toggles the `.dark` class on <html>. This makes the first paint correct.
 *
 *   2. The CSS variables in globals.css cascade from `:root` (light) or `.dark`
 *      (dark). All theme-dependent visuals are driven by CSS, not React state.
 *
 *   3. Theme-dependent UI in components should use Tailwind's `dark:` variant
 *      (e.g. `block dark:hidden`) — NEVER `theme === 'dark' ? <A /> : <B />`,
 *      because that uses React state, which on SSR doesn't yet know what the
 *      browser will choose. Branching on React state causes hydration mismatch.
 *
 *   4. `useTheme()` returns the USER'S CHOICE in `theme` (which may be 'system')
 *      and the RESOLVED value in `effectiveTheme` (always 'light' | 'dark').
 *      UI rendering should still prefer CSS `dark:` classes; the React values
 *      exist so the toggle UI knows what to show.
 */

export type Theme = 'light' | 'dark' | 'system'
export type EffectiveTheme = 'light' | 'dark'

interface ThemeContextType {
  /** User's saved preference. May be 'system'. SSR default = 'system'. */
  theme: Theme
  /** Resolved theme actually applied to the DOM. SSR default = 'dark'. */
  effectiveTheme: EffectiveTheme
  /** True once mounted on the client — gate runtime-only branches with this. */
  mounted: boolean
  setTheme: (t: Theme) => void
  /** Cycles light → dark → system → light. Wired to the sidebar button. */
  cycleTheme: () => void
  /**
   * Backwards-compatible name kept for any older call sites. Cycles through
   * light → dark → system just like `cycleTheme`.
   */
  toggleTheme: () => void
}

const STORAGE_KEY = 'cirqle.theme'
/** SSR default: 'system'. The init script resolves it to light/dark on first paint. */
const SSR_THEME: Theme = 'system'
const SSR_EFFECTIVE: EffectiveTheme = 'dark'

const ThemeContext = createContext<ThemeContextType>({
  theme: SSR_THEME,
  effectiveTheme: SSR_EFFECTIVE,
  mounted: false,
  setTheme: () => {},
  cycleTheme: () => {},
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
    var effective = (saved === 'light' || saved === 'dark') ? saved : (prefersDark ? 'dark' : 'light');
    var root = document.documentElement;
    if (effective === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');
    root.style.colorScheme = effective;
  } catch (e) { /* localStorage blocked */ }
})();
`

/** Read the live theme from the DOM. Only safe to call on the client. */
function readDomTheme(): EffectiveTheme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

/** Read the user's saved preference. Returns 'system' if nothing/unknown. */
function readSavedChoice(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
    return 'system'
  } catch {
    return 'system'
  }
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches
}

function applyDom(effective: EffectiveTheme) {
  const root = document.documentElement
  if (effective === 'dark') root.classList.add('dark')
  else root.classList.remove('dark')
  root.style.colorScheme = effective
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // SSR-safe initial state: server and first client render both produce the
  // same value, so React never has to reconcile a mismatch.
  const [theme, setThemeState] = useState<Theme>(SSR_THEME)
  const [effectiveTheme, setEffectiveTheme] = useState<EffectiveTheme>(SSR_EFFECTIVE)
  const [mounted, setMounted] = useState(false)

  // On mount, sync React state to the live DOM (set by the init script) and
  // load the saved choice from localStorage.
  useEffect(() => {
    setThemeState(readSavedChoice())
    setEffectiveTheme(readDomTheme())
    setMounted(true)
  }, [])

  /** Apply a choice: persist it, derive the effective theme, paint the DOM. */
  const setTheme = useCallback((next: Theme) => {
    const eff: EffectiveTheme =
      next === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : next
    applyDom(eff)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // localStorage blocked — toggle still works for this session
    }
    setThemeState(next)
    setEffectiveTheme(eff)
  }, [])

  /** light → dark → system → light. */
  const cycleTheme = useCallback(() => {
    setThemeState(prev => {
      const next: Theme = prev === 'light' ? 'dark' : prev === 'dark' ? 'system' : 'light'
      const eff: EffectiveTheme =
        next === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : next
      applyDom(eff)
      try { localStorage.setItem(STORAGE_KEY, next) } catch {}
      setEffectiveTheme(eff)
      return next
    })
  }, [])

  // While in 'system' mode, re-apply when the OS preference changes (e.g.
  // user toggles macOS dark mode, or the OS auto-switches at sunset).
  useEffect(() => {
    if (theme !== 'system') return
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => {
      const eff: EffectiveTheme = mq.matches ? 'dark' : 'light'
      applyDom(eff)
      setEffectiveTheme(eff)
    }
    // addEventListener is the modern API; Safari 14+ supports it.
    mq.addEventListener?.('change', handler)
    return () => mq.removeEventListener?.('change', handler)
  }, [theme])

  // Re-sync if another tab changes the preference.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEY) return
      const next = readSavedChoice()
      setTheme(next)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [setTheme])

  // Stable value — consumers don't re-render when unrelated bits update.
  const value = useMemo<ThemeContextType>(
    () => ({
      theme,
      effectiveTheme,
      mounted,
      setTheme,
      cycleTheme,
      toggleTheme: cycleTheme, // backwards-compat alias
    }),
    [theme, effectiveTheme, mounted, setTheme, cycleTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  return useContext(ThemeContext)
}

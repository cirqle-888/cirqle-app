'use client'

import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react'

/**
 * Theme system — light/dark with localStorage persistence + system preference fallback.
 *
 * How the no-flash trick works:
 *   - `ThemeInitScript` runs synchronously in <head> BEFORE React hydration.
 *   - It reads localStorage and adds/removes `dark` class on <html>.
 *   - The CSS variables in globals.css cascade from `:root` (light) or `.dark` (dark).
 *   - Result: first paint is always the correct theme, no flash.
 *
 * The ThemeProvider on the client side then syncs React state with the DOM state
 * the script already set, so toggling works reactively.
 */

export type Theme = 'light' | 'dark'

interface ThemeContextType {
  theme: Theme
  setTheme: (t: Theme) => void
  toggleTheme: () => void
}

const STORAGE_KEY = 'cirqle.theme'

const ThemeContext = createContext<ThemeContextType>({
  theme: 'dark',
  setTheme: () => {},
  toggleTheme: () => {},
})

/**
 * Inline script for <head> — runs before React hydrates. Picks up the user's
 * stored preference (or `prefers-color-scheme` if none) and sets the `.dark`
 * class on <html> synchronously so the first paint is the correct theme.
 *
 * Render this inside the root <head> via dangerouslySetInnerHTML so it executes
 * before the body renders.
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

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Initial state derived from the DOM (set by the init script) so SSR and
  // client agree on first render.
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'dark'
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  })

  // Apply theme to <html> and persist.
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

  const setTheme = useCallback(
    (t: Theme) => {
      applyTheme(t)
    },
    [applyTheme],
  )

  const toggleTheme = useCallback(() => {
    applyTheme(theme === 'dark' ? 'light' : 'dark')
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

  return <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  return useContext(ThemeContext)
}

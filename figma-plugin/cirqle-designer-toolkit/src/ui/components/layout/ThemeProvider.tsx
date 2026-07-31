import { useEffect, type ReactNode } from 'react';
import { useSettings } from '@ui/state/useSettings';

/** Figma injects --figma-color-* CSS variables into the iframe automatically
 * when the plugin calls `figma.showUI(html, { themeColors: true })` — those
 * already track the user's Figma theme. This component only needs to add a
 * `data-theme` attribute for our OWN token overrides (see tokens.css) and to
 * respect the user's explicit override in Settings (light/dark/system). */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();

  useEffect(() => {
    const root = document.documentElement;
    const apply = (mode: 'light' | 'dark') => root.setAttribute('data-theme', mode);

    if (settings.theme === 'system') {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      apply(mql.matches ? 'dark' : 'light');
      const listener = (e: MediaQueryListEvent) => apply(e.matches ? 'dark' : 'light');
      mql.addEventListener('change', listener);
      return () => mql.removeEventListener('change', listener);
    }

    apply(settings.theme);
    return undefined;
  }, [settings.theme]);

  return <>{children}</>;
}

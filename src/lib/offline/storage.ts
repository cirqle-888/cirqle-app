/**
 * Durable key/value storage for the offline layer.
 *
 * Native: @capacitor/preferences (survives WebView cache eviction). Web/desktop:
 * localStorage. Both are wrapped so a missing plugin or a disabled/again-full
 * store degrades to a no-op instead of throwing. SSR-safe.
 */
import { capPlugin, isNative } from '@/lib/native'

interface PreferencesPlugin {
  get: (o: { key: string }) => Promise<{ value: string | null }>
  set: (o: { key: string; value: string }) => Promise<void>
  remove: (o: { key: string }) => Promise<void>
}

function prefs(): PreferencesPlugin | null {
  return isNative() ? capPlugin<PreferencesPlugin>('Preferences') : null
}

export async function storageGet(key: string): Promise<string | null> {
  const P = prefs()
  if (P?.get) {
    try { return (await P.get({ key })).value } catch { /* fall through */ }
  }
  if (typeof localStorage !== 'undefined') {
    try { return localStorage.getItem(key) } catch { /* private mode / quota */ }
  }
  return null
}

export async function storageSet(key: string, value: string): Promise<void> {
  const P = prefs()
  if (P?.set) {
    try { await P.set({ key, value }); return } catch { /* fall through */ }
  }
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(key, value) } catch { /* private mode / quota */ }
  }
}

export async function storageRemove(key: string): Promise<void> {
  const P = prefs()
  if (P?.remove) {
    try { await P.remove({ key }); return } catch { /* fall through */ }
  }
  if (typeof localStorage !== 'undefined') {
    try { localStorage.removeItem(key) } catch { /* ignore */ }
  }
}

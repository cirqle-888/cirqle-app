/**
 * Connectivity detection for the offline layer.
 *
 * Native: @capacitor/network. Web/desktop: navigator.onLine + the window
 * online/offline events. A cached flag is kept up to date by the listener so
 * the sync engine can read online-ness synchronously in its hot path.
 */
import { capPlugin, isNative } from '@/lib/native'

interface NetworkStatus { connected: boolean; connectionType?: string }
interface NetworkListenerHandle { remove: () => Promise<void> }
interface NetworkPlugin {
  getStatus: () => Promise<NetworkStatus>
  addListener: (
    event: 'networkStatusChange',
    cb: (status: NetworkStatus) => void,
  ) => Promise<NetworkListenerHandle> | NetworkListenerHandle
}

// Optimistic default: assume online until told otherwise (avoids blocking the
// first mutation on a device that is actually connected).
let cachedOnline = true

/** Last known connectivity, read synchronously. */
export function isOnlineCached(): boolean {
  if (typeof navigator !== 'undefined' && 'onLine' in navigator) {
    // navigator.onLine is authoritative on web; the cache tracks native.
    cachedOnline = isNative() ? cachedOnline : navigator.onLine
  }
  return cachedOnline
}

/** Fetch the current connectivity (async on native, sync-ish on web). */
export async function checkOnline(): Promise<boolean> {
  if (isNative()) {
    const N = capPlugin<NetworkPlugin>('Network')
    if (N?.getStatus) {
      try { cachedOnline = (await N.getStatus()).connected; return cachedOnline } catch { /* fall through */ }
    }
  }
  return isOnlineCached()
}

/**
 * Subscribe to connectivity changes. Returns an unsubscribe function. Also
 * primes the cache. No-op cleanup off-browser.
 */
export function onNetworkChange(cb: (online: boolean) => void): () => void {
  if (typeof window === 'undefined') return () => {}

  const update = (online: boolean) => { cachedOnline = online; cb(online) }

  if (isNative()) {
    const N = capPlugin<NetworkPlugin>('Network')
    if (N?.addListener) {
      void checkOnline().then(cb).catch(() => {})
      let handle: NetworkListenerHandle | null = null
      Promise.resolve(N.addListener('networkStatusChange', s => update(s.connected)))
        .then(h => { handle = h }).catch(() => {})
      return () => { void handle?.remove().catch(() => {}) }
    }
  }

  const onOnline = () => update(true)
  const onOffline = () => update(false)
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  cachedOnline = 'onLine' in navigator ? navigator.onLine : true
  return () => {
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
  }
}

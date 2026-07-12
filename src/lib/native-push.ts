/**
 * Native push registration (Capacitor iOS/APNs + Android/FCM).
 *
 * The web app already ships Web Push (VAPID) via <PushToggle>; that keeps
 * working in mobile browsers. Inside the native shell, however, the OS delivers
 * pushes through APNs/FCM, which need a device *registration token* handed to
 * the server so it can target the device. This module drives the runtime-
 * injected PushNotifications plugin, persists the token via a server action,
 * and exposes tap/received handlers.
 *
 * Off-native every export is a graceful no-op (returns null / empty cleanup),
 * so importing this anywhere is safe on web and desktop. Nothing here adds a
 * build-time `@capacitor/*` dependency — the plugin is only present at runtime
 * inside the native app (installed in mobile/package.json).
 *
 * Server delivery (sending a push to a stored token) requires FCM/APNs
 * credentials on the backend and is out of scope for the client abstraction —
 * see docs/MOBILE_NATIVE.md for the Firebase/APNs setup the account owner must
 * complete before pushes actually arrive.
 */
import { capPlugin, isNative, getPlatform } from '@/lib/native'
import { saveNativePushToken, removeNativePushToken } from '@/lib/push/native-actions'

type PermState = 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied'

interface PushListenerHandle { remove: () => Promise<void> }

export interface PushNotificationPayload {
  title?: string
  body?: string
  id?: string
  /** Arbitrary key/value data delivered with the push. */
  data?: Record<string, unknown>
}

interface PushPlugin {
  checkPermissions: () => Promise<{ receive: PermState }>
  requestPermissions: () => Promise<{ receive: PermState }>
  register: () => Promise<void>
  removeAllListeners: () => Promise<void>
  addListener: (
    event: 'registration' | 'registrationError' | 'pushNotificationReceived' | 'pushNotificationActionPerformed',
    cb: (data: unknown) => void,
  ) => Promise<PushListenerHandle> | PushListenerHandle
}

export interface NativePushRegistration {
  token: string
  platform: 'ios' | 'android'
}

/**
 * Request permission, register with APNs/FCM, and persist the resulting device
 * token server-side. Resolves the registration on success, or null if off-
 * native, permission denied, the plugin is missing, or registration times out.
 * Safe to call more than once (the server action upserts on the unique token).
 */
export async function registerNativePush(timeoutMs = 15000): Promise<NativePushRegistration | null> {
  if (!isNative()) return null
  const platform = getPlatform()
  if (platform !== 'ios' && platform !== 'android') return null

  const Push = capPlugin<PushPlugin>('PushNotifications')
  if (!Push?.register) return null

  // Ask for permission (idempotent — checkPermissions first avoids re-prompting).
  try {
    let perm = await Push.checkPermissions()
    if (perm.receive !== 'granted') perm = await Push.requestPermissions()
    if (perm.receive !== 'granted') return null
  } catch { return null }

  return new Promise<NativePushRegistration | null>((resolve) => {
    let settled = false
    const handles: PushListenerHandle[] = []
    const finish = (result: NativePushRegistration | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      handles.forEach(h => { void h.remove().catch(() => {}) })
      resolve(result)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    const track = (h: Promise<PushListenerHandle> | PushListenerHandle) => {
      Promise.resolve(h).then(handle => handles.push(handle)).catch(() => {})
    }

    track(Push.addListener('registration', (data) => {
      const token = (data as { value?: string })?.value
      if (!token) return finish(null)
      // Persist server-side; resolve regardless of the network result so the
      // caller isn't blocked on a flaky connection (retry happens next launch).
      void saveNativePushToken({ token, platform }).catch(() => {})
      finish({ token, platform })
    }))
    track(Push.addListener('registrationError', () => finish(null)))

    Push.register().catch(() => finish(null))
  })
}

/**
 * Subscribe to foreground-received pushes and notification taps. Returns a
 * cleanup function; off-native it's a no-op returning an empty cleanup.
 */
export function addPushNotificationHandlers(handlers: {
  onReceived?: (n: PushNotificationPayload) => void
  onActionPerformed?: (n: PushNotificationPayload) => void
}): () => void {
  if (!isNative()) return () => {}
  const Push = capPlugin<PushPlugin>('PushNotifications')
  if (!Push?.addListener) return () => {}

  const handles: PushListenerHandle[] = []
  const track = (h: Promise<PushListenerHandle> | PushListenerHandle) => {
    Promise.resolve(h).then(handle => handles.push(handle)).catch(() => {})
  }
  const normalize = (raw: unknown): PushNotificationPayload => {
    const n = (raw as { notification?: Record<string, unknown> })?.notification ?? raw
    const o = (n ?? {}) as Record<string, unknown>
    return {
      title: o.title as string | undefined,
      body: o.body as string | undefined,
      id: o.id as string | undefined,
      data: o.data as Record<string, unknown> | undefined,
    }
  }

  if (handlers.onReceived) {
    track(Push.addListener('pushNotificationReceived', raw => handlers.onReceived!(normalize(raw))))
  }
  if (handlers.onActionPerformed) {
    track(Push.addListener('pushNotificationActionPerformed', raw => handlers.onActionPerformed!(normalize(raw))))
  }
  return () => { handles.forEach(h => { void h.remove().catch(() => {}) }) }
}

/** Remove this device's token server-side (e.g. on sign-out). No-op off-native. */
export async function unregisterNativePush(token: string): Promise<void> {
  if (!isNative()) return
  await removeNativePushToken(token).catch(() => {})
}

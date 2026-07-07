'use client'

/**
 * <PushToggle> — enable/disable browser push notifications for this device.
 * Registers /push-sw.js, subscribes with the VAPID public key, and stores the
 * subscription server-side. Renders nothing when the browser can't do push or
 * VAPID isn't configured (graceful).
 */

import { useEffect, useState } from 'react'
import { Bell, BellOff, Loader2 } from 'lucide-react'
import { savePushSubscription, removePushSubscription } from '@/lib/push/actions'

const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY

function urlBase64ToBuffer(base64String: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  // Dedicated ArrayBuffer (not SharedArrayBuffer) so it types as BufferSource.
  const buf = new ArrayBuffer(raw.length)
  const view = new Uint8Array(buf)
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i)
  return buf
}

export function PushToggle({ className = '' }: { className?: string }) {
  const [supported, setSupported] = useState(false)
  const [subscribed, setSubscribed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const ok = typeof window !== 'undefined'
      && 'serviceWorker' in navigator
      && 'PushManager' in window
      && !!VAPID_PUBLIC
    // Deferred — no sync setState in an effect body (react-compiler lint rule).
    const t = setTimeout(() => {
      setSupported(ok)
      if (!ok) return
      navigator.serviceWorker.getRegistration('/push-sw.js')
        .then(reg => reg?.pushManager.getSubscription())
        .then(sub => setSubscribed(!!sub))
        .catch(() => {})
    }, 0)
    return () => clearTimeout(t)
  }, [])

  if (!supported) return null

  const enable = async () => {
    setBusy(true)
    try {
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') { setBusy(false); return }
      const reg = await navigator.serviceWorker.register('/push-sw.js')
      await navigator.serviceWorker.ready
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBuffer(VAPID_PUBLIC!),
      })
      const json = sub.toJSON()
      const res = await savePushSubscription({
        endpoint: sub.endpoint,
        p256dh: json.keys?.p256dh ?? '',
        auth: json.keys?.auth ?? '',
        userAgent: navigator.userAgent,
      })
      if (res.ok) setSubscribed(true)
    } catch { /* user dismissed or blocked */ }
    setBusy(false)
  }

  const disable = async () => {
    setBusy(true)
    try {
      const reg = await navigator.serviceWorker.getRegistration('/push-sw.js')
      const sub = await reg?.pushManager.getSubscription()
      if (sub) {
        await removePushSubscription(sub.endpoint)
        await sub.unsubscribe()
      }
      setSubscribed(false)
    } catch { /* ignore */ }
    setBusy(false)
  }

  return (
    <button
      onClick={subscribed ? disable : enable}
      disabled={busy}
      title={subscribed ? 'Push notifications on — click to turn off' : 'Enable browser push notifications'}
      className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
        subscribed
          ? 'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20'
          : 'bg-muted text-muted-foreground hover:text-foreground'
      } ${className}`}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : subscribed ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
      {subscribed ? 'Push on' : 'Enable push'}
    </button>
  )
}

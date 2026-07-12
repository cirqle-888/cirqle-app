'use client'

/**
 * Small connectivity/sync status pill for the native shell.
 *
 * Shows "Offline — N pending" when disconnected, "Syncing N…" while draining
 * queued mutations, and nothing when online with an empty queue. Gated by
 * isNative() so web and desktop are visually untouched (renders null there).
 */
import { useEffect, useState } from 'react'
import { CloudOff, RefreshCw } from 'lucide-react'
import { isNative } from '@/lib/native'
import { subscribeQueue, subscribeOnline } from '@/lib/offline'

export function OfflineIndicator() {
  const [online, setOnline] = useState(true)
  const [pending, setPending] = useState(0)
  const [flushing, setFlushing] = useState(false)

  useEffect(() => {
    if (!isNative()) return
    const offQueue = subscribeQueue(s => { setPending(s.size); setFlushing(s.flushing) })
    const offOnline = subscribeOnline(setOnline)
    return () => { offQueue(); offOnline() }
  }, [])

  // Nothing to say when connected and fully synced.
  if (online && pending === 0) return null

  const offline = !online
  const label = offline
    ? `Offline${pending ? ` — ${pending} pending` : ''}`
    : `Syncing${pending ? ` ${pending}` : ''}…`

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-center pb-safe"
    >
      <div
        className={`mb-3 flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium shadow-lg ${
          offline
            ? 'bg-amber-500/95 text-amber-950'
            : 'bg-sky-500/95 text-sky-950'
        }`}
      >
        {offline
          ? <CloudOff className="h-3.5 w-3.5" />
          : <RefreshCw className={`h-3.5 w-3.5 ${flushing ? 'animate-spin' : ''}`} />}
        {label}
      </div>
    </div>
  )
}

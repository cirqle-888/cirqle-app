'use client'

/**
 * "Turn on notifications" — the phone app's one, explained request.
 *
 * Android 13 and later will not show a notification until the person has
 * allowed it, and only a system dialog can ask. That dialog used to appear by
 * itself the moment the app opened, before anyone knew what it was for. It now
 * appears only after a tap here, where the reason is written out. "Not now"
 * puts this away for a week; once notifications are on, or refused, it never
 * shows again. Renders nothing on the web, the desktop app and iOS.
 */
import { useEffect, useState } from 'react'
import { BellRing, X } from 'lucide-react'
import { enableNativePush, nativePushState } from '@/lib/native-push'

const SNOOZE_KEY = 'cirqle.notifyPrompt.snoozedUntil'
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000

function snoozed(): boolean {
  try { return Number(window.localStorage.getItem(SNOOZE_KEY) ?? 0) > Date.now() } catch { return false }
}

export function NotifyPrompt({ active }: { active: boolean }) {
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!active) return
    let alive = true
    void nativePushState().then((state) => { if (alive) setShow(state === 'ask' && !snoozed()) })
    return () => { alive = false }
  }, [active])

  if (!active || !show) return null

  const later = () => {
    try { window.localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)) } catch { /* shows again next launch */ }
    setShow(false)
  }
  const turnOn = async () => {
    setBusy(true)
    await enableNativePush()
    // Allowed or refused, the question has been answered — put this away.
    setShow(false)
  }

  return (
    <div className="pointer-events-auto fixed inset-x-3 top-[calc(env(safe-area-inset-top,0px)+0.75rem)] z-[60] mx-auto max-w-md rounded-xl border border-border bg-card p-3 shadow-lg">
      <div className="flex items-start gap-3">
        <BellRing className="mt-0.5 h-5 w-5 shrink-0 text-violet-500" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Get alerted to new messages</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Cirqle can notify you about chat messages and urgent notes when the app is closed. Nothing else is collected.
          </p>
          <div className="mt-2.5 flex gap-2">
            <button onClick={turnOn} disabled={busy} className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60">Turn on</button>
            <button onClick={later} className="rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted">Not now</button>
          </div>
        </div>
        <button onClick={later} aria-label="Not now" className="rounded p-1 text-muted-foreground hover:bg-muted"><X className="h-4 w-4" /></button>
      </div>
    </div>
  )
}

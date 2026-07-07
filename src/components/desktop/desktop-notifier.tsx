'use client'

/**
 * DesktopNotifier — app-wide native-notification bridge for the Cirqle Desktop
 * (Electron) app. Does NOTHING in a normal browser (the web already has its
 * own in-app toasts + Web Push); it only activates when the desktop preload
 * bridge (`window.__CIRQLE_DESKTOP__.notify`) is present.
 *
 * It fires a native OS notification (system tone + high-priority dock bounce,
 * handled in the desktop main process) for:
 *   1. new CHAT messages in any of my conversations (messages table, RLS-scoped
 *      by realtime so I only ever receive my own conversations' events), and
 *   2. new BELL notifications addressed to me (notifications table — requires
 *      migration 023 to be in the realtime publication).
 *
 * Mounted once, app-wide, in the dashboard layout — so chat alerts fire no
 * matter which Cirqle page is open (or if the user is in the WhatsApp pane).
 */
import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/contexts/permission-context'

interface DesktopBridge {
  notify?: (p: { title: string; body: string; tag?: string; url?: string }) => void
}
function desktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = (window as any).__CIRQLE_DESKTOP__ as DesktopBridge | undefined
  return b && typeof b.notify === 'function' ? b : null
}

/** True while the user is actively looking at conversation `convId` in-app. */
function isActivelyViewing(convId: string): boolean {
  if (typeof document === 'undefined') return false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const active = (window as any).__cirqleActiveConv as string | null | undefined
  return active === convId && document.visibilityState === 'visible'
}

function messagePreview(kind: string, body: string): string {
  if (kind === 'voice') return '🎤 Voice message'
  if (kind === 'file') return '📎 File'
  if (kind === 'approval') return '🟡 Approval request'
  return (body || '').slice(0, 140)
}

export function DesktopNotifier() {
  const { user } = usePermissions()
  const employeeId = user.employeeId

  useEffect(() => {
    const bridge = desktopBridge()
    if (!bridge?.notify || !employeeId) return // browser, or not signed in → no-op

    const supabase = createClient()
    const channel = supabase
      .channel('desktop-notifier')
      // ── Chat messages (RLS delivers only my conversations) ──
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          const row = payload.new as Record<string, unknown>
          const convId = String(row.conversation_id ?? '')
          if (!convId) return
          if (row.sender_id === employeeId) return          // my own message
          if (row.parent_id) return                          // thread reply — quieter
          if (row.deleted_at) return
          if (isActivelyViewing(convId)) return              // I'm reading it right now
          bridge.notify!({
            title: '💬 New message',
            body: messagePreview(String(row.kind ?? 'text'), String(row.body ?? '')),
            tag: `msg:${convId}`,
            url: `/dashboard/chat?c=${convId}`,
          })
        })
      // ── Bell notifications addressed to me (needs migration 023) ──
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `employee_id=eq.${employeeId}` },
        (payload) => {
          const row = payload.new as Record<string, unknown>
          bridge.notify!({
            title: String(row.title ?? 'Cirqle'),
            body: String(row.message ?? ''),
            tag: row.source_key ? `notif:${row.source_key}` : `notif:${row.id}`,
            url: typeof row.link === 'string' ? row.link : '/dashboard',
          })
        })
      .subscribe()

    return () => { void supabase.removeChannel(channel) }
  }, [employeeId])

  return null
}

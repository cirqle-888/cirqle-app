'use client'

import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { Bell, Check, ExternalLink } from 'lucide-react'
import { getMyNotifications, markNotificationRead, markAllNotificationsRead, type NotificationRow } from '@/app/api/notifications/actions'
import { PushToggle } from '@/components/notifications/push-toggle'
import { SoundToggle } from '@/components/notifications/sound-toggle'
import { useVisibleInterval } from '@/lib/hooks/use-visible-interval'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/contexts/permission-context'

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

const PANEL_WIDTH = 320

export function NotificationBell({ isCollapsed = false }: { isCollapsed?: boolean }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<NotificationRow[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    const res = await getMyNotifications()
    if (res.ok && res.data) {
      setRows(res.data.rows)
      setUnreadCount(res.data.unreadCount)
    }
    setLoaded(true)
  }, [])

  // Load once, then rely on realtime (below). A slow poll stays only as a
  // reconnect/missed-event safety net.
  //
  // EGRESS: this polls exactly the same getMyNotifications() as the floating
  // comms widget, which is mounted on every dashboard page — so the two ran
  // back-to-back every 120s. Visibility-gated and slowed to 300s; realtime
  // (below) is what actually keeps the badge live.
  useVisibleInterval(() => { void refresh() }, 300_000)

  // Realtime: new notifications for me land instantly (migration 023 published
  // the table). Prepends the row + bumps the badge with no poll lag.
  const { user } = usePermissions()
  const employeeId = user.employeeId
  useEffect(() => {
    if (!employeeId) return
    const supabase = createClient()
    // Unique per mount — supabase-js reuses a channel object when a topic name
    // is still registered (removeChannel() on unmount is async), so a static
    // name breaks under React Strict Mode's double-effect dev remount:
    // .on() would fire on an already-subscribed() channel and throw.
    const channel = supabase
      .channel(`notif-bell-${crypto.randomUUID()}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `employee_id=eq.${employeeId}` },
        (payload) => {
          const row = payload.new as unknown as NotificationRow
          setRows(prev => prev.some(n => n.id === row.id) ? prev : [row, ...prev].slice(0, 30))
          if (!row.read) setUnreadCount(c => c + 1)
        })
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [employeeId])

  // The sidebar root has `overflow-hidden` (for its collapse-width animation),
  // which clips any absolutely-positioned descendant to the sidebar's own
  // bounding box — the dropdown was rendering as a sliver instead of the full
  // panel. Portal it to <body> and position it via the button's real
  // viewport rect instead, same pattern as components/ui/filter-dropdown.tsx.
  const recomputePos = useCallback(() => {
    if (!btnRef.current) return
    const rect = btnRef.current.getBoundingClientRect()
    const left = Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 8)
    setPanelPos({ top: rect.bottom + 8, left: Math.max(8, left) })
  }, [])

  useLayoutEffect(() => {
    if (!open) { setPanelPos(null); return }
    recomputePos()
    const handler = () => recomputePos()
    window.addEventListener('scroll', handler, true)
    window.addEventListener('resize', handler)
    return () => {
      window.removeEventListener('scroll', handler, true)
      window.removeEventListener('resize', handler)
    }
  }, [open, recomputePos])

  useEffect(() => {
    if (!open) return
    function onClickOutside(e: MouseEvent) {
      const target = e.target as Node
      if (btnRef.current?.contains(target)) return
      if (panelRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  function handleOpen() {
    setOpen(o => !o)
    if (!loaded) void refresh()
  }

  function handleRowClick(row: NotificationRow) {
    if (!row.read) {
      setRows(prev => prev.map(r => r.id === row.id ? { ...r, read: true } : r))
      setUnreadCount(c => Math.max(0, c - 1))
      void markNotificationRead(row.id)
    }
    if (row.link) window.location.href = row.link
  }

  function handleMarkAllRead() {
    setRows(prev => prev.map(r => ({ ...r, read: true })))
    setUnreadCount(0)
    void markAllNotificationsRead()
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={handleOpen}
        className={`relative flex items-center justify-center h-8 ${isCollapsed ? 'w-8' : 'w-8'} rounded-lg text-muted-foreground/60 bg-foreground/[0.03] border border-foreground/[0.06] hover:border-foreground/[0.12] hover:text-muted-foreground transition-all shrink-0`}
        title="Notifications"
      >
        <Bell className="w-3.5 h-3.5" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-red-500 text-white text-[9px] font-semibold flex items-center justify-center leading-none">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && panelPos && typeof document !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          onMouseDown={e => e.stopPropagation()}
          style={{ position: 'fixed', top: panelPos.top, left: panelPos.left, width: PANEL_WIDTH, zIndex: 1000 }}
          className="max-h-[70dvh] overflow-y-auto rounded-xl border border-border bg-card shadow-2xl shadow-black/30 animate-in fade-in slide-in-from-top-1 duration-100"
        >
          <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border sticky top-0 bg-card">
            <h3 className="text-xs font-semibold text-foreground">Notifications</h3>
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <SoundToggle />
              <PushToggle />
              {unreadCount > 0 && (
                <button onClick={handleMarkAllRead} className="text-[11px] text-violet-500 hover:underline flex items-center gap-1">
                  <Check className="w-3 h-3" /> Mark all read
                </button>
              )}
            </div>
          </div>
          {rows.length === 0 ? (
            <p className="text-xs text-muted-foreground/60 px-3.5 py-6 text-center">No notifications yet</p>
          ) : (
            <div className="divide-y divide-border/60">
              {rows.map(row => (
                <button
                  key={row.id}
                  onClick={() => handleRowClick(row)}
                  className={`w-full text-left px-3.5 py-2.5 hover:bg-secondary/60 transition-colors flex items-start gap-2 ${!row.read ? 'bg-violet-500/[0.04]' : ''}`}
                >
                  {!row.read && <span className="w-1.5 h-1.5 rounded-full bg-violet-500 mt-1.5 shrink-0" />}
                  <div className={`flex-1 min-w-0 ${row.read ? 'pl-3.5' : ''}`}>
                    <p className="text-xs font-medium text-foreground leading-snug">{row.title}</p>
                    {row.message && <p className="text-[11px] text-muted-foreground/70 mt-0.5 line-clamp-2">{row.message}</p>}
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[10px] text-muted-foreground/50">{relativeTime(row.created_at)}</span>
                      {row.link && <ExternalLink className="w-2.5 h-2.5 text-muted-foreground/40" />}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}

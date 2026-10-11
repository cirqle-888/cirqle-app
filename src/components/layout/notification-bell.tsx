'use client'

import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Bell, Check, ExternalLink, ChevronDown, Clock, Info } from 'lucide-react'
import { markNotificationRead, markAllNotificationsRead, type NotificationRow } from '@/app/api/notifications/actions'
import { fetchSharedNotifications } from '@/lib/notifications/shared-fetch'
import {
  groupNotifications, notificationMetrics, groupRowIds, type NotificationGroup,
} from '@/lib/notifications/digest'
import {
  readSnoozes, writeSnoozes, isSnoozed, withSnooze, SNOOZE_OPTIONS, type SnoozeMap,
} from '@/lib/notifications/snooze'
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

/**
 * Full document navigation, deliberately — a notification's link may point at
 * any screen, including ones outside the dashboard router, and the target is
 * expected to load with its own deep-link params honoured. Kept out of the
 * component so the one assignment lives in one place.
 */
function followLink(href: string) {
  window.location.href = href
}

export function NotificationBell({ isCollapsed = false }: { isCollapsed?: boolean }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<NotificationRow[]>([])
  const [loaded, setLoaded] = useState(false)
  /** Snoozed group keys → when they come back. Per device; see lib/notifications/snooze. */
  const [snoozes, setSnoozes] = useState<SnoozeMap>({})
  /** Which folded groups the user has opened. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  /** The group whose snooze menu is open. */
  const [snoozeMenu, setSnoozeMenu] = useState<string | null>(null)
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    // Shared with FloatingCommsWidget — see lib/notifications/shared-fetch.
    const res = await fetchSharedNotifications()
    if (res.ok && res.data) setRows(res.data.rows)
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

  // Snoozes are durable per device, so load them once the viewer is known.
  useEffect(() => {
    if (!employeeId) return
    let cancelled = false
    void readSnoozes(employeeId).then(map => { if (!cancelled) setSnoozes(map) })
    return () => { cancelled = true }
  }, [employeeId])

  // ── What the panel actually shows ────────────────────────────────────────
  // Repeats folded into one line, snoozed groups hidden, and informational
  // groups shown but never counted. See lib/notifications/digest for why.
  const groups = useMemo(() => groupNotifications(rows), [rows])
  const visibleGroups = useMemo(
    () => groups.filter(g => !isSnoozed(snoozes, g.key)),
    [groups, snoozes],
  )
  const snoozedCount = groups.length - visibleGroups.length

  // The badge counts unread ACTIONABLE notifications in groups that are not
  // snoozed. A badge inflated by "post published" and by things the user has
  // explicitly deferred is a badge people stop reading.
  const metrics = useMemo(
    () => notificationMetrics(visibleGroups.flatMap(g => g.rows)),
    [visibleGroups],
  )
  const unreadCount = metrics.actionableUnread
  /** Unread at all — what "Mark all read" acts on. */
  const anyUnread = metrics.unread > 0

  function handleOpen() {
    setOpen(o => !o)
    if (!loaded) void refresh()
  }

  function markRead(ids: string[]) {
    const unread = new Set(ids.filter(id => rows.some(r => r.id === id && !r.read)))
    if (unread.size === 0) return
    setRows(prev => prev.map(r => unread.has(r.id) ? { ...r, read: true } : r))
    for (const id of unread) void markNotificationRead(id)
  }

  function handleGroupClick(group: NotificationGroup) {
    // A folded group opens rather than navigating: its members may be about
    // different records, and marking all of them read on one click would bury
    // the ones the user has not looked at.
    if (group.count > 1 && !expanded.has(group.key)) {
      setExpanded(prev => new Set(prev).add(group.key))
      return
    }
    markRead(groupRowIds(group))
    if (group.link) followLink(group.link)
  }

  function handleRowClick(row: NotificationRow) {
    markRead([row.id])
    if (row.link) followLink(row.link)
  }

  function handleSnooze(group: NotificationGroup, ms: number) {
    setSnoozeMenu(null)
    const next = withSnooze(snoozes, group.key, ms)
    setSnoozes(next)
    if (employeeId) void writeSnoozes(employeeId, next)
  }

  function handleMarkAllRead() {
    setRows(prev => prev.map(r => ({ ...r, read: true })))
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
              {anyUnread && (
                <button onClick={handleMarkAllRead} className="text-[11px] text-violet-500 hover:underline flex items-center gap-1">
                  <Check className="w-3 h-3" /> Mark all read
                </button>
              )}
            </div>
          </div>

          {/* The backlog, stated. The plan asks to measure unread and ignored
              alerts; said to the person it concerns rather than collected,
              which also keeps notification contents — they name clients and
              invoices — out of any analytics pipeline. */}
          {(metrics.ignored > 0 || snoozedCount > 0) && (
            <div className="px-3.5 py-2 border-b border-border/60 bg-secondary/40 text-[10px] text-muted-foreground/70 flex flex-wrap gap-x-3">
              {metrics.ignored > 0 && (
                <span>{metrics.ignored} unread for over a week</span>
              )}
              {snoozedCount > 0 && (
                <span>{snoozedCount} snoozed on this device</span>
              )}
            </div>
          )}

          {visibleGroups.length === 0 ? (
            <p className="text-xs text-muted-foreground/60 px-3.5 py-6 text-center">
              {snoozedCount > 0 ? 'Nothing right now — the rest is snoozed' : 'No notifications yet'}
            </p>
          ) : (
            <div className="divide-y divide-border/60">
              {visibleGroups.map(group => {
                const isOpen = expanded.has(group.key)
                const informational = group.kind === 'informational'
                return (
                  <div
                    key={group.key}
                    className={group.unread > 0 && !informational ? 'bg-violet-500/[0.04]' : ''}
                  >
                    <div className="flex items-start gap-1">
                      <button
                        onClick={() => handleGroupClick(group)}
                        className="flex-1 min-w-0 text-left pl-3.5 pr-1 py-2.5 hover:bg-secondary/60 transition-colors flex items-start gap-2"
                      >
                        {group.unread > 0
                          ? <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${informational ? 'bg-muted-foreground/40' : 'bg-violet-500'}`} />
                          : <span className="w-1.5 shrink-0" />}
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-foreground leading-snug flex items-start gap-1.5">
                            <span className="min-w-0">{group.title}</span>
                            {group.count > 1 && (
                              <span className="shrink-0 px-1.5 rounded-full bg-foreground/10 text-[10px] font-semibold tabular-nums">
                                {group.count}
                              </span>
                            )}
                          </p>
                          {group.message && group.count === 1 && (
                            <p className="text-[11px] text-muted-foreground/70 mt-0.5 line-clamp-2">{group.message}</p>
                          )}
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-[10px] text-muted-foreground/50">{relativeTime(group.latestAt)}</span>
                            {informational && (
                              <span title="For information — not counted in the badge">
                                <Info className="w-2.5 h-2.5 text-muted-foreground/40" />
                              </span>
                            )}
                            {group.link && <ExternalLink className="w-2.5 h-2.5 text-muted-foreground/40" />}
                            {group.count > 1 && (
                              <ChevronDown className={`w-2.5 h-2.5 text-muted-foreground/40 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                            )}
                          </div>
                        </div>
                      </button>

                      {/* Snooze. "Not now" is the honest answer to a lot of
                          alerts, and without it the only options are leave it
                          unread or mark it read before dealing with it. */}
                      <div className="relative pr-2 pt-2.5">
                        <button
                          onClick={() => setSnoozeMenu(k => k === group.key ? null : group.key)}
                          title="Snooze"
                          aria-label={`Snooze ${group.title}`}
                          className="p-1 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-foreground/10 transition-colors"
                        >
                          <Clock className="w-3 h-3" />
                        </button>
                        {snoozeMenu === group.key && (
                          <div className="absolute right-2 top-8 z-10 w-36 rounded-lg border border-border bg-card shadow-xl py-1">
                            {SNOOZE_OPTIONS.map(opt => (
                              <button
                                key={opt.label}
                                onClick={() => handleSnooze(group, opt.ms)}
                                className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-secondary transition-colors"
                              >
                                {opt.label}
                              </button>
                            ))}
                            <p className="px-3 pt-1.5 pb-0.5 text-[9px] text-muted-foreground/50 border-t border-border/60 mt-1">
                              This device only
                            </p>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Opened group: each member on its own line, so one click
                        cannot mark several different records as read. */}
                    {isOpen && group.count > 1 && (
                      <div className="pl-7 pr-3.5 pb-2 space-y-1.5">
                        {group.rows.map(member => (
                          <button
                            key={member.id}
                            onClick={() => handleRowClick(member)}
                            className="w-full text-left hover:bg-secondary/60 rounded-md px-2 py-1 transition-colors"
                          >
                            <p className={`text-[11px] leading-snug ${member.read ? 'text-muted-foreground/70' : 'text-foreground'}`}>
                              {member.message || member.title}
                            </p>
                            <span className="text-[10px] text-muted-foreground/50">{relativeTime(member.created_at)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}

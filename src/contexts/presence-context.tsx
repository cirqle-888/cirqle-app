'use client'

/**
 * PresenceProvider — who is around, app-wide.
 *
 * Mounted once in the dashboard layout, so every page gets dots without each
 * one fetching anything. Three jobs:
 *
 *   1. SYNC        One server action per tab per minute, whenever the person
 *                  is actually at this device: it writes their heartbeat and
 *                  returns the whole roster. Only ONE tab writes — they share
 *                  a localStorage lease — so six pinned tabs still produce one
 *                  heartbeat, and each costs a single round trip.
 *
 *                  "At this device" is NOT the same question in a browser tab,
 *                  the desktop app and the phone — presence/activity.ts owns
 *                  that, and getting it wrong on desktop is what makes a
 *                  presence feature useless.
 *
 *   2. LISTEN      Subscribe to Realtime on top, so a status someone sets
 *                  reaches other people's screens in under a second instead of
 *                  within the minute. An ACCELERATOR, not the source of truth:
 *                  the sync above is what makes the dots correct, so a
 *                  Realtime publication that is missing, throttled or dropped
 *                  degrades the feature from instant to a minute — never to
 *                  wrong.
 *
 *   3. AGE         Re-derive on a timer. Nobody writes a row when someone goes
 *                  idle — going Away is the ABSENCE of a heartbeat — so the
 *                  transition has to happen on the reading side.
 *
 * Degrades to nothing: before migration 20260831120000 is applied the sync
 * returns null, `available` stays false, and every consumer renders as if the
 * feature weren't there. No error, no toast, no broken page.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVisibleInterval } from '@/lib/hooks/use-visible-interval'
import { currentDevice, isPresentHere, subscribeAppState } from '@/lib/presence/activity'
import { syncPresence } from '@/lib/presence/actions'
import {
  derivePresence, HEARTBEAT_MS,
  type EffectivePresence, type PresenceRow,
} from '@/lib/presence/status'

// ── Cross-tab heartbeat lease ────────────────────────────────────────────────
// Without this, N open tabs write N times a minute for one person sitting at
// one desk. The lease is a timestamp in localStorage: a tab may beat only if
// the last beat (by any tab) is older than the interval. Cheap, needs no
// coordination protocol, and self-heals — a crashed tab's lease just expires.

const LEASE_KEY = 'cirqle_presence_beat'

function claimHeartbeatLease(now = Date.now()): boolean {
  try {
    const last = Number(localStorage.getItem(LEASE_KEY) || 0)
    // 5s of slack so two tabs ticking on the same second don't both beat.
    if (now - last < HEARTBEAT_MS - 5_000) return false
    localStorage.setItem(LEASE_KEY, String(now))
    return true
  } catch {
    return true   // no storage (private mode) → just beat; correctness over cost
  }
}

// ── Context ──────────────────────────────────────────────────────────────────

interface PresenceContextValue {
  /** Resolved status for one employee. Always returns something — an unknown
   *  id reads as offline, which is the honest answer for someone with no row. */
  presenceOf: (employeeId: string | null | undefined) => EffectivePresence
  /** The signed-in user's own resolved status. */
  mine: EffectivePresence
  /** Everyone with a row, resolved. For roster views. */
  all: EffectivePresence[]
  /** Apply a row the caller just wrote, without waiting for the round trip. */
  applyRow: (row: PresenceRow) => void
  /**
   * True once the table has actually answered a read.
   *
   * This is the difference between "loaded, and everyone happens to be
   * offline" and "presence does not exist here" — before migration
   * 20260831120000 is applied the read 404s, and every dot in the app must
   * stay hidden rather than telling the whole org it is offline. Sticky once
   * set, so a dropped connection doesn't blink every dot off.
   */
  available: boolean
}

const Ctx = createContext<PresenceContextValue | null>(null)

/** Realtime rows arrive untyped; keep only the columns we know about. */
function normalise(raw: Record<string, unknown>): PresenceRow | null {
  const id = raw.employee_id
  if (typeof id !== 'string' || !id) return null
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
  return {
    employee_id: id,
    manual_status: str(raw.manual_status) as PresenceRow['manual_status'],
    status_emoji: str(raw.status_emoji),
    status_text: str(raw.status_text),
    status_expires_at: str(raw.status_expires_at),
    last_seen_at: str(raw.last_seen_at),
    device: str(raw.device),
  }
}

export function PresenceProvider(
  { myEmployeeId, enabled = true, children }:
  { myEmployeeId: string; enabled?: boolean; children: ReactNode },
) {
  const [rows, setRows] = useState<Map<string, PresenceRow>>(() => new Map())
  const [available, setAvailable] = useState(false)
  // Advancing this is what turns a green dot yellow when someone walks off —
  // see job 3 above. Held as state (not a ref) precisely so it re-renders.
  const [tick, setTick] = useState(() => Date.now())

  const applyRow = useCallback((row: PresenceRow) => {
    setRows(prev => {
      const next = new Map(prev)
      next.set(row.employee_id, row)
      return next
    })
    // A row coming back from a write is proof the table exists, even if the
    // browser's own read is being blocked by something else.
    setAvailable(true)
  }, [])

  // ── 1 + 2a. Sync: heartbeat out, roster back ───────────────────────────────
  const sync = useCallback(async () => {
    // Is the person at THIS device? Platform-specific — a hidden browser tab
    // means gone, a hidden desktop window does not. When the answer is no we
    // make no request at all: no heartbeat to lie with, no roster to render.
    if (!(await isPresentHere())) return

    // Only the lease-holding tab writes; the rest read. `beat` is decided here
    // rather than inside the action so the server never has to guess which of
    // someone's six tabs is the canonical one.
    const beat = !!myEmployeeId && claimHeartbeatLease()
    const rows = await syncPresence(currentDevice(), beat)
    // null = the table isn't there (or the request failed). Say nothing rather
    // than declaring the whole org offline.
    if (!rows) return
    const next = new Map<string, PresenceRow>()
    for (const row of rows) if (row?.employee_id) next.set(row.employee_id, row)
    setRows(next)
    // An empty array still proves the table exists — that is a workspace where
    // nobody has heartbeat yet, not a workspace without presence.
    setAvailable(true)
  }, [myEmployeeId])

  // NOT useVisibleInterval: that hook is right for polls nobody is waiting on,
  // and wrong here. On the desktop app a hidden window is not an absent person
  // (see presence/activity.ts), so the tick has to keep running and `sync` has
  // to be the thing that decides. The decision costs one IPC call on desktop
  // and a boolean everywhere else, and a tick that decides "not here" makes no
  // network request at all — so a backgrounded tab is still silent.
  useEffect(() => {
    if (!enabled) return
    const tickNow = () => { void sync() }
    tickNow()
    const id = setInterval(tickNow, HEARTBEAT_MS)
    // Coming back to the app should refresh the roster immediately rather than
    // showing up to a minute of stale dots.
    document.addEventListener('visibilitychange', tickNow)
    // Native foreground/background is a separate signal from visibility, and on
    // iOS it is the accurate one.
    const stopAppState = subscribeAppState(tickNow)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', tickNow)
      stopAppState()
    }
  }, [enabled, sync])

  // Hand the lease back when this tab goes away, so a sibling tab can beat
  // immediately instead of waiting out the dead tab's remaining interval.
  // Best-effort: a killed process releases nothing, and the lease expires on
  // its own a minute later anyway.
  useEffect(() => {
    if (!enabled || !myEmployeeId) return
    const release = () => { try { localStorage.removeItem(LEASE_KEY) } catch { /* ignore */ } }
    window.addEventListener('pagehide', release)
    return () => window.removeEventListener('pagehide', release)
  }, [enabled, myEmployeeId])

  // ── 2b. Realtime — the accelerator ─────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return
    const supabase = createClient()
    // Unique topic per mount — a static name collides with the previous mount's
    // not-yet-finished removeChannel under Strict Mode's double effect.
    const channel = supabase
      .channel(`presence-${crypto.randomUUID()}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'employee_presence' },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            const gone = (payload.old as Record<string, unknown>)?.employee_id
            if (typeof gone === 'string') {
              setRows(prev => {
                if (!prev.has(gone)) return prev
                const next = new Map(prev); next.delete(gone); return next
              })
            }
            return
          }
          const row = normalise(payload.new as Record<string, unknown>)
          if (row) applyRow(row)
        })
      .subscribe()

    return () => { void supabase.removeChannel(channel) }
  }, [enabled, applyRow])

  // ── 3. Age the map ─────────────────────────────────────────────────────────
  // 30s is half the heartbeat: fine enough that a dot is never more than half a
  // minute stale, coarse enough to be invisible in a profiler.
  useVisibleInterval(() => setTick(Date.now()), 30_000, enabled)

  const derived = useMemo(() => {
    const map = new Map<string, EffectivePresence>()
    for (const [id, row] of rows) map.set(id, derivePresence(row, tick, id))
    return map
  }, [rows, tick])

  const value = useMemo<PresenceContextValue>(() => ({
    presenceOf: (id) => (id && derived.get(id)) || derivePresence(null, tick, id ?? ''),
    mine: derived.get(myEmployeeId) ?? derivePresence(null, tick, myEmployeeId),
    all: Array.from(derived.values()),
    applyRow,
    available,
  }), [derived, myEmployeeId, tick, applyRow, available])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/**
 * Presence for the whole app. Safe outside the provider (the portal, the
 * careers site, tests) — returns an inert value where every employee is
 * offline, so a component can use it without knowing where it's mounted.
 */
export function usePresence(): PresenceContextValue {
  const ctx = useContext(Ctx)
  // `now` is irrelevant here: with no row, derivePresence returns offline
  // whatever the clock says. Passing a constant keeps this pure — reading
  // Date.now() during render is exactly the instability the rule guards.
  const fallback = useMemo<PresenceContextValue>(() => ({
    presenceOf: (id) => derivePresence(null, 0, id ?? ''),
    mine: derivePresence(null, 0, ''),
    all: [],
    applyRow: () => {},
    available: false,
  }), [])
  return ctx ?? fallback
}

/** Convenience for the common case: one employee's resolved status. */
export function useEmployeePresence(employeeId: string | null | undefined): EffectivePresence {
  const { presenceOf } = usePresence()
  return presenceOf(employeeId)
}

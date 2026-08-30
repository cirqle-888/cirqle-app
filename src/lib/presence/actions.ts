'use server'

/**
 * Presence server actions.
 *
 * Every mutation runs here on the service role, and each one only ever touches
 * the CALLER's own row — that is what stops one employee from setting another's
 * status.
 *
 * The roster read lives here too (syncPresence). `employee_presence` is also
 * granted SELECT to `authenticated` so browsers can subscribe to it over
 * Realtime — it holds no name, no email and nothing derived from them — but the
 * polled read through this module is what the feature's correctness rests on.
 * Realtime only makes it feel instant.
 *
 * Pre-migration safety: every action swallows a missing-table error and reports
 * failure quietly. Presence is decoration — it must never be the reason a page
 * throws for someone who hasn't applied 20260831120000 yet.
 *
 * NOTE: this module is 'use server' — every export must be an async function.
 * The types live in ./status.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser } from '@/lib/permissions/check'
import {
  resolveClearAfter, MANUAL_CHOICES,
  type ManualStatus, type ClearAfterId, type PresenceRow,
} from './status'

/** Named, never `*`, so a later column addition can't widen what a write
 *  hands back by accident. Kept in step with presence-context's own read. */
const COLS = 'employee_id, manual_status, status_emoji, status_text, status_expires_at, last_seen_at, device'

type Device = 'web' | 'desktop' | 'mobile'
const DEVICES: Device[] = ['web', 'desktop', 'mobile']
const VALID_STATUS = new Set<string>(MANUAL_CHOICES.map(c => c.status))

/**
 * Who may write presence right now.
 *
 * Refuses during an admin's view-as preview, mirroring requirePermission: a
 * preview must not make the previewed employee light up green, which would be
 * a lie told in someone else's name. No permission key — being signed in and
 * unarchived is the whole gate, exactly like being able to appear in chat.
 */
async function writer(): Promise<string | null> {
  const me = await loadCurrentUser().catch(() => null)
  if (!me || me.isArchived || me.isViewAs) return null
  return me.employeeId || null
}

/**
 * One round trip per tab per minute: optionally write the caller's heartbeat,
 * always read back the roster.
 *
 * Folded into a single action deliberately. The browser could read the roster
 * from PostgREST itself (it holds the grant, for Realtime's sake), but then
 * every tab costs two requests a minute instead of one, and the feature's
 * correctness would depend on the Realtime transport actually delivering —
 * which is not something a status dot should bet on. Realtime, when it works,
 * makes this feel instant; this makes it CORRECT within the minute either way.
 *
 * `beat` is false for every tab except the one holding the cross-tab lease, so
 * six open tabs still produce exactly one write.
 *
 * Returns null — not [] — when the table isn't there, so the caller can tell
 * "presence doesn't exist here" from "nobody is online". The first hides every
 * dot in the app; the second is a real, renderable answer.
 */
export async function syncPresence(
  device: string = 'web',
  beat: boolean = true,
): Promise<PresenceRow[] | null> {
  const employeeId = await writer()

  try {
    const db = createAdminClient()

    if (beat && employeeId) {
      const dev = DEVICES.includes(device as Device) ? (device as Device) : 'web'
      const nowIso = new Date().toISOString()
      // A heartbeat says "this connection is alive" and nothing else — it must
      // never touch the manual status.
      await db.from('employee_presence').upsert(
        { employee_id: employeeId, last_seen_at: nowIso, device: dev, updated_at: nowIso },
        { onConflict: 'employee_id' },
      )
    }

    // One row per employee, so the 1000-row PostgREST ceiling is only reachable
    // by an org of 1000 people; the explicit order keeps any truncation
    // deterministic if that ever happens.
    const { data, error } = await db
      .from('employee_presence')
      .select(COLS)
      .order('last_seen_at', { ascending: false })
      .limit(1000)

    if (error) return null
    return (data as unknown as PresenceRow[]) ?? []
  } catch {
    return null
  }
}

/**
 * Set (or clear) the caller's own status.
 *
 * `status: null` with no note means "follow my activity" — the row keeps its
 * heartbeat and the dot goes back to being automatic.
 */
export async function setMyStatus(input: {
  status?: ManualStatus | null
  emoji?: string | null
  text?: string | null
  clearAfter?: ClearAfterId
}): Promise<{ ok: true; row: PresenceRow } | { ok: false; error: string }> {
  const employeeId = await writer()
  if (!employeeId) return { ok: false, error: 'Not signed in, or preview is read-only.' }

  const status = input.status ?? null
  if (status !== null && !VALID_STATUS.has(status)) {
    return { ok: false, error: 'Unknown status.' }
  }

  // Trim to the column's CHECK so a paste of an essay fails in the UI's own
  // language rather than as a Postgres constraint error.
  const text = (input.text ?? '').trim().slice(0, 80) || null
  const emoji = (input.emoji ?? '').trim().slice(0, 8) || null

  const expires = input.clearAfter ? resolveClearAfter(input.clearAfter) : null
  const nowIso = new Date().toISOString()

  try {
    const db = createAdminClient()
    const { data, error } = await db
      .from('employee_presence')
      .upsert(
        {
          employee_id: employeeId,
          manual_status: status,
          status_emoji: emoji,
          status_text: text,
          status_expires_at: expires,
          // Setting a status is itself proof of life — without this, choosing
          // "Busy" after a long idle spell would show Away to everyone else,
          // because the pick only applies while the heartbeat is fresh.
          last_seen_at: nowIso,
          updated_at: nowIso,
        },
        { onConflict: 'employee_id' },
      )
      .select(COLS)
      .single()

    if (error || !data) return { ok: false, error: 'Could not save your status.' }
    return { ok: true, row: data as unknown as PresenceRow }
  } catch {
    return { ok: false, error: 'Could not save your status.' }
  }
}

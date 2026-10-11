/**
 * Snoozing a notification group.
 *
 * "Not now" is the honest answer to a lot of alerts, and without it the only
 * two options are leave it unread (so the badge keeps shouting) or mark it
 * read (so it is gone before it is dealt with). Both train people to ignore
 * the bell.
 *
 * ── A DELIBERATE LIMITATION ───────────────────────────────────────────────
 *
 * Snoozes are stored on the device, not in the database, because the
 * `notifications` table is written by a dozen crons and server actions and
 * this pass must not change the production schema. So a snooze set on a
 * laptop does not follow the user to their phone. That is a real limitation
 * and the UI says so rather than implying otherwise; making it durable means
 * one nullable `snoozed_until` column, which is the right follow-up.
 *
 * The pure part — which keys are snoozed at a given instant — is here and
 * tested; the storage binding is at the bottom and degrades to a no-op when
 * storage is unavailable, exactly like the draft store.
 */
import { storageGet, storageSet } from '@/lib/offline/storage'

/** Snooze lengths offered in the UI. */
export const SNOOZE_OPTIONS: readonly { label: string; ms: number }[] = [
  { label: 'For an hour', ms: 60 * 60 * 1000 },
  { label: 'Until tomorrow', ms: 24 * 60 * 60 * 1000 },
  { label: 'For a week', ms: 7 * 24 * 60 * 60 * 1000 },
]

/** key → epoch ms at which it comes back. */
export type SnoozeMap = Record<string, number>

/**
 * Drop entries that have expired.
 *
 * Called on every read, so the map cannot grow without bound and a snooze
 * that has come due is indistinguishable from one that was never set.
 */
export function pruneSnoozes(map: SnoozeMap, now: number = Date.now()): SnoozeMap {
  const out: SnoozeMap = {}
  for (const [key, until] of Object.entries(map)) {
    if (typeof until === 'number' && Number.isFinite(until) && until > now) out[key] = until
  }
  return out
}

export function isSnoozed(map: SnoozeMap, key: string, now: number = Date.now()): boolean {
  const until = map[key]
  return typeof until === 'number' && until > now
}

/** Add or replace a snooze. Re-snoozing an already-snoozed key extends it. */
export function withSnooze(
  map: SnoozeMap, key: string, ms: number, now: number = Date.now(),
): SnoozeMap {
  return { ...pruneSnoozes(map, now), [key]: now + Math.max(0, ms) }
}

export function withoutSnooze(map: SnoozeMap, key: string): SnoozeMap {
  const out = { ...map }
  delete out[key]
  return out
}

// ── Storage binding ────────────────────────────────────────────────────────

/** Per employee: a shared device must not leak one person's snoozes to another. */
function storageKey(employeeId: string): string {
  return `cirqle:notif:snooze:v1:${employeeId}`
}

export async function readSnoozes(
  employeeId: string, now: number = Date.now(),
): Promise<SnoozeMap> {
  if (!employeeId) return {}
  const raw = await storageGet(storageKey(employeeId))
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return pruneSnoozes(parsed as SnoozeMap, now)
  } catch {
    return {}
  }
}

export async function writeSnoozes(employeeId: string, map: SnoozeMap): Promise<void> {
  if (!employeeId) return
  await storageSet(storageKey(employeeId), JSON.stringify(map))
}

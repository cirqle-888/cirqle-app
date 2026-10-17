'use server'

/**
 * Posting times — server actions.
 *
 * Three things live here, and the split between them is the whole point:
 *
 *   SLOTS are the plan. A client's standing weekly template, typed in by
 *   whoever read their page analytics. They decide what gets scheduled.
 *
 *   BEST TIMES are evidence. Hourly engagement, from Meta or read off a
 *   screenshot. They only ever suggest — nothing here lets a sync write a
 *   slot, because a number cannot know that a client asked for 7pm.
 *
 *   ASSIGNMENT is the bulk planner, and it is deliberately a two-step:
 *   planAssignment() computes and returns what WOULD happen, applyAssignment()
 *   writes it. Scheduling forty posts is not something anyone should discover
 *   the result of afterwards.
 *
 * Permissions follow the existing split: setting a client's slots is planning
 * (social.manage), assigning times in bulk is publishing (social.publish).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission, requireReadPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { columnExists } from '@/lib/supabase/server'
import { logActivity } from '@/lib/activity/log'
import { revalidatePath } from 'next/cache'
import {
  normalizeTime, assignTimes, weekdayOf,
  type PostingSlot, type BestTime, type PlannableItem, type Weekday,
} from './posting-time'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const NOT_READY = 'Posting times are not switched on yet — the database migration has not been applied.'

/**
 * Does a table exist yet?
 *
 * server.ts has columnExists but no table equivalent, and these two tables are
 * NEW — before the migration runs, every read here would throw a PostgREST
 * 42P01 and take the planning screen down with it. Cached per process like
 * columnExists, for the same reason: this must not become a round-trip on
 * every keystroke.
 */
const TABLE_CACHE = new Map<string, Promise<boolean>>()
function tableExists(admin: ReturnType<typeof createAdminClient>, table: string): Promise<boolean> {
  const cached = TABLE_CACHE.get(table)
  if (cached) return cached
  const probe = Promise.resolve(admin.from(table).select('*', { head: true, count: 'exact' }).limit(1))
    .then(({ error }) => {
      // 42P01 is "undefined_table". Anything else — a permissions problem, a
      // network blip — is NOT evidence of absence, so it reports present and
      // lets the real query surface the real error.
      const missing = error?.code === '42P01' || /does not exist/i.test(error?.message ?? '')
      return !missing
    })
    .catch(() => true)
  TABLE_CACHE.set(table, probe)
  return probe
}

async function slotsReady(admin: ReturnType<typeof createAdminClient>): Promise<boolean> {
  return tableExists(admin, 'social_posting_slots')
}

// ── Slots ────────────────────────────────────────────────────────────────────

export interface SlotView {
  id: string
  weekday: Weekday
  time: string
  platforms: string[]
  label: string | null
  priority: number
  active: boolean
}

export async function listSlots(clientId: string): Promise<ActionResult<SlotView[]>> {
  const guard = await requireReadPermission(PERMS.SOCIAL_VIEW)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  if (!(await slotsReady(admin))) return { ok: true, data: [] }

  const { data, error } = await admin
    .from('social_posting_slots')
    .select('id, weekday, time_of_day, platforms, label, priority, active')
    .eq('client_id', clientId)
    .order('weekday').order('priority').order('time_of_day')
  if (error) return { ok: false, error: error.message }

  return {
    ok: true,
    data: (data ?? []).map((r: Row) => ({
      id: String(r.id),
      weekday: Number(r.weekday) as Weekday,
      time: normalizeTime(r.time_of_day) ?? '00:00',
      platforms: Array.isArray(r.platforms) ? r.platforms : [],
      label: r.label ?? null,
      priority: Number(r.priority ?? 0),
      active: r.active !== false,
    })),
  }
}

export async function saveSlot(input: {
  id?: string
  clientId: string
  weekday: number
  time: string
  platforms?: string[]
  label?: string | null
  priority?: number
  active?: boolean
}): Promise<ActionResult<{ id: string }>> {
  const guard = await requirePermission(PERMS.SOCIAL_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const time = normalizeTime(input.time)
  if (!time) return { ok: false, error: 'Enter a time as HH:MM, for example 19:30.' }
  if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) {
    return { ok: false, error: 'Pick a day of the week.' }
  }

  const admin = createAdminClient()
  if (!(await slotsReady(admin))) return { ok: false, error: NOT_READY }

  const row = {
    client_id: input.clientId,
    weekday: input.weekday,
    time_of_day: time,
    platforms: input.platforms ?? [],
    label: input.label?.trim() || null,
    priority: Number.isFinite(input.priority) ? Math.trunc(input.priority as number) : 0,
    active: input.active !== false,
  }

  if (input.id) {
    const { error } = await admin.from('social_posting_slots').update(row).eq('id', input.id)
    if (error) return { ok: false, error: error.message }
    revalidatePath('/dashboard/social-calendar')
    return { ok: true, data: { id: input.id } }
  }

  const { data, error } = await admin
    .from('social_posting_slots')
    .insert({ ...row, created_by: guard.employeeId ?? null })
    .select('id').single()
  // The unique index is (client, weekday, time): re-adding 19:30 Monday is an
  // edit, not a second slot that would silently double-book the bulk planner.
  if (error) {
    if (error.code === '23505') return { ok: false, error: 'That client already has a slot at this time on this day.' }
    return { ok: false, error: error.message }
  }

  revalidatePath('/dashboard/social-calendar')
  return { ok: true, data: { id: String((data as Row).id) } }
}

export async function deleteSlot(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  if (!(await slotsReady(admin))) return { ok: true }

  const { error } = await admin.from('social_posting_slots').delete().eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard/social-calendar')
  return { ok: true }
}

// ── Evidence ─────────────────────────────────────────────────────────────────

export async function listBestTimes(clientId: string): Promise<ActionResult<BestTime[]>> {
  const guard = await requireReadPermission(PERMS.SOCIAL_VIEW)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  if (!(await tableExists(admin, 'social_best_times'))) return { ok: true, data: [] }

  const { data, error } = await admin
    .from('social_best_times')
    .select('weekday, hour, score, source')
    .eq('client_id', clientId)
    .order('score', { ascending: false })
    .limit(200)
  if (error) return { ok: false, error: error.message }

  return {
    ok: true,
    data: (data ?? []).map((r: Row) => ({
      weekday: Number(r.weekday) as Weekday,
      hour: Number(r.hour),
      score: Number(r.score ?? 0),
      source: (r.source === 'screenshot' ? 'screenshot' : r.source === 'manual' ? 'manual' : 'meta'),
    })),
  }
}

/**
 * Replace one source's figures for a client.
 *
 * DELETE-then-INSERT rather than an upsert: a re-sync should leave exactly
 * what the source currently says, not that plus whatever it said last month.
 * Scoped to the one source so a Meta sync never touches a screenshot import.
 */
export async function replaceBestTimes(input: {
  clientId: string
  accountId?: string | null
  source: 'meta' | 'screenshot' | 'manual'
  rows: Array<{ weekday: number; hour: number; score: number }>
  note?: string | null
}): Promise<ActionResult<{ written: number }>> {
  const guard = await requirePermission(PERMS.SOCIAL_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  if (!(await tableExists(admin, 'social_best_times'))) return { ok: false, error: NOT_READY }

  const clean = input.rows.filter(r =>
    Number.isInteger(r.weekday) && r.weekday >= 0 && r.weekday <= 6 &&
    Number.isInteger(r.hour) && r.hour >= 0 && r.hour <= 23 &&
    Number.isFinite(r.score))
  if (!clean.length) return { ok: false, error: 'Nothing readable in that data.' }

  let del = admin.from('social_best_times').delete()
    .eq('client_id', input.clientId).eq('source', input.source)
  del = input.accountId ? del.eq('account_id', input.accountId) : del.is('account_id', null)
  const { error: delErr } = await del
  if (delErr) return { ok: false, error: delErr.message }

  const { error } = await admin.from('social_best_times').insert(clean.map(r => ({
    client_id: input.clientId,
    account_id: input.accountId ?? null,
    source: input.source,
    weekday: r.weekday,
    hour: r.hour,
    score: r.score,
    note: input.note?.trim() || null,
    created_by: guard.employeeId ?? null,
  })))
  if (error) return { ok: false, error: error.message }

  revalidatePath('/dashboard/social-calendar')
  return { ok: true, data: { written: clean.length } }
}

// ── The bulk planner ─────────────────────────────────────────────────────────

export interface PlannedChange {
  itemId: string
  title: string
  clientName: string
  isoDate: string
  from: string | null
  to: string
  source: string
}

export interface AssignmentPreview {
  changes: PlannedChange[]
  unplaced: Array<{ itemId: string; title: string; isoDate: string; reason: string }>
  skipped: Array<{ itemId: string; title: string; reason: string }>
}

/** Load the items a bulk assignment would consider, with their client's slots. */
async function loadPlannable(
  admin: ReturnType<typeof createAdminClient>,
  opts: { clientId: string; fromISO: string; toISO: string },
) {
  const { data, error } = await admin
    .from('social_calendar_items')
    .select('id, title, scheduled_date, scheduled_time, post_asap, posting_priority, display_order, calendar:calendar_id!inner(client_id, client:client_id(name))')
    .gte('scheduled_date', opts.fromISO)
    .lte('scheduled_date', opts.toISO)
    .neq('status', 'cancelled')
    .order('scheduled_date')
  if (error) throw new Error(error.message)

  const rows = (data ?? []).filter((r: Row) => {
    const cal = Array.isArray(r.calendar) ? r.calendar[0] : r.calendar
    return cal?.client_id === opts.clientId
  })
  return rows.map((r: Row) => {
    const cal = Array.isArray(r.calendar) ? r.calendar[0] : r.calendar
    const client = Array.isArray(cal?.client) ? cal.client[0] : cal?.client
    return {
      row: r,
      clientName: client?.name ?? 'Client',
      item: {
        id: String(r.id),
        isoDate: String(r.scheduled_date),
        time: normalizeTime(r.scheduled_time),
        asap: !!r.post_asap,
        priority: Number(r.posting_priority ?? 0),
        displayOrder: Number(r.display_order ?? 0),
      } as PlannableItem,
    }
  })
}

/**
 * What a bulk assignment WOULD do. Writes nothing.
 *
 * Returned rather than applied because the result is forty scheduling
 * decisions, and the honest place to disagree with them is before they exist.
 */
/* Read guard, not the write one: this computes and returns, it never writes.
   Behind requirePermission an admin previewing a social manager would get a
   preview that silently refuses to plan — a lie about what that role can do. */
export async function planAssignment(input: {
  clientId: string
  fromISO: string
  toISO: string
  overwrite?: boolean
}): Promise<ActionResult<AssignmentPreview>> {
  const guard = await requireReadPermission(PERMS.SOCIAL_PUBLISH)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  if (!(await columnExists(admin, 'social_calendar_items', 'scheduled_time'))) {
    return { ok: false, error: NOT_READY }
  }

  const [slotsRes, bestRes] = await Promise.all([listSlots(input.clientId), listBestTimes(input.clientId)])
  if (!slotsRes.ok) return { ok: false, error: slotsRes.error }

  let loaded
  try { loaded = await loadPlannable(admin, input) }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Could not read the plan.' } }

  const byId = new Map(loaded.map(l => [l.item.id, l]))
  const result = assignTimes(
    loaded.map(l => l.item),
    (slotsRes.data ?? []) as PostingSlot[],
    { bestTimes: bestRes.data ?? [], overwrite: input.overwrite },
  )

  const name = (id: string) => byId.get(id)?.row.title ?? 'Post'
  return {
    ok: true,
    data: {
      changes: result.assignments.map(a => ({
        itemId: a.itemId,
        title: name(a.itemId),
        clientName: byId.get(a.itemId)?.clientName ?? 'Client',
        isoDate: a.isoDate,
        from: byId.get(a.itemId)?.item.time ?? null,
        to: a.time,
        source: a.source,
      })),
      unplaced: result.unplaced.map(u => ({ ...u, title: name(u.itemId) })),
      skipped: result.skipped.map(s => ({ ...s, title: name(s.itemId) })),
    },
  }
}

/**
 * Write a previewed assignment.
 *
 * Takes the explicit list of changes rather than recomputing, so what gets
 * written is what was shown — recomputing here would let a plan edited in
 * another tab between preview and apply silently change the answer.
 */
export async function applyAssignment(
  changes: Array<{ itemId: string; to: string }>,
): Promise<ActionResult<{ written: number }>> {
  const guard = await requirePermission(PERMS.SOCIAL_PUBLISH)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!changes.length) return { ok: true, data: { written: 0 } }

  const admin = createAdminClient()
  if (!(await columnExists(admin, 'social_calendar_items', 'scheduled_time'))) {
    return { ok: false, error: NOT_READY }
  }

  let written = 0
  for (const change of changes) {
    const time = normalizeTime(change.to)
    if (!time) continue
    const { error } = await admin
      .from('social_calendar_items')
      .update({ scheduled_time: time, updated_at: new Date().toISOString() })
      .eq('id', change.itemId)
    if (error) return { ok: false, error: `${error.message} (after ${written} of ${changes.length})` }
    written++
  }

  await logActivity({
    action: 'social_posting_times_assigned',
    entityType: 'task',
    entityId: changes[0]?.itemId ?? 'bulk',
    detail: { count: written },
  }).catch(() => {})

  revalidatePath('/dashboard/social-calendar')
  revalidatePath('/dashboard/social/queue')
  return { ok: true, data: { written } }
}

/** One post, one time. The per-row control on the planning screen. */
export async function setPostingTime(
  itemId: string,
  time: string | null,
  opts: { asap?: boolean } = {},
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  if (!(await columnExists(admin, 'social_calendar_items', 'scheduled_time'))) {
    return { ok: false, error: NOT_READY }
  }

  const clean = time === null ? null : normalizeTime(time)
  if (time !== null && !clean) return { ok: false, error: 'Enter a time as HH:MM, for example 19:30.' }

  const patch: Record<string, unknown> = { scheduled_time: clean, updated_at: new Date().toISOString() }
  // ASAP and a time are mutually exclusive: one says "no slot", the other
  // names one. Setting either clears the other rather than leaving a row that
  // claims both.
  if (opts.asap !== undefined) patch.post_asap = !!opts.asap
  if (clean) patch.post_asap = false

  const { error } = await admin.from('social_calendar_items').update(patch).eq('id', itemId)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/dashboard/social-calendar')
  revalidatePath('/dashboard/social/queue')
  return { ok: true }
}

/** Confirm a post actually went out, from the posting view. */
export async function markPostingDone(itemId: string, done = true): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_PUBLISH)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  if (!(await columnExists(admin, 'social_calendar_items', 'posted_at'))) {
    return { ok: false, error: NOT_READY }
  }

  const { error } = await admin.from('social_calendar_items').update({
    posted_at: done ? new Date().toISOString() : null,
    posted_by: done ? (guard.employeeId ?? null) : null,
    updated_at: new Date().toISOString(),
  }).eq('id', itemId)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/dashboard/social/queue')
  return { ok: true }
}

/** The suggestions a planning row offers for a date. Read-only. */
export async function timeSuggestionsFor(
  clientId: string,
  isoDate: string,
): Promise<ActionResult<{ slots: SlotView[]; best: BestTime[]; taken: string[] }>> {
  const guard = await requireReadPermission(PERMS.SOCIAL_VIEW)
  if (!guard.ok) return { ok: false, error: guard.error }

  try { weekdayOf(isoDate) }
  catch { return { ok: false, error: 'Pick a date first.' } }

  const admin = createAdminClient()
  const [slotsRes, bestRes] = await Promise.all([listSlots(clientId), listBestTimes(clientId)])

  let taken: string[] = []
  if (await columnExists(admin, 'social_calendar_items', 'scheduled_time')) {
    const { data } = await admin
      .from('social_calendar_items')
      .select('scheduled_time, calendar:calendar_id!inner(client_id)')
      .eq('scheduled_date', isoDate)
      .not('scheduled_time', 'is', null)
    taken = (data ?? [])
      .filter((r: Row) => {
        const cal = Array.isArray(r.calendar) ? r.calendar[0] : r.calendar
        return cal?.client_id === clientId
      })
      .map((r: Row) => normalizeTime(r.scheduled_time))
      .filter((t): t is string => t !== null)
  }

  return { ok: true, data: { slots: slotsRes.data ?? [], best: bestRes.data ?? [], taken } }
}

// ── Where evidence comes from ────────────────────────────────────────────────

/**
 * Pull hourly follower activity from a client's connected Instagram account.
 *
 * Soft everywhere. No connected account, a retired metric, an account too
 * small for Meta to report on — each returns a sentence someone can act on
 * rather than an error, because the client's own slots were always the
 * authority and keep working regardless.
 */
export async function syncOnlineFollowers(clientId: string): Promise<ActionResult<{ written: number; days: number; account: string }>> {
  const guard = await requirePermission(PERMS.SOCIAL_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  if (!(await tableExists(admin, 'social_best_times'))) return { ok: false, error: NOT_READY }

  const { data: accounts } = await admin
    .from('social_accounts')
    .select('id, platform, external_id, name, status, insights_enabled')
    .eq('client_id', clientId)
    .eq('platform', 'instagram')
    .neq('status', 'disconnected')
  const account = (accounts ?? [])[0] as Row | undefined
  if (!account) {
    return { ok: false, error: 'No connected Instagram account for this client. Connect one, or paste the numbers instead.' }
  }

  // Reuse the sync's own resolver rather than re-deriving how tokens decrypt:
  // two places that know that is one place to get it wrong.
  const { resolveAccountToken } = await import('@/lib/integrations/meta/insights')
  const token = await resolveAccountToken(admin, account)
  if (!token) return { ok: false, error: 'That Instagram connection has no usable token — reconnect it in Accounts.' }

  const { fetchOnlineFollowers } = await import('@/lib/integrations/meta/online-followers')
  const result = await fetchOnlineFollowers(String(account.external_id), token)
  if (!result.rows.length) {
    return { ok: false, error: result.error ?? 'Instagram returned no hourly data for this account.' }
  }

  const written = await replaceBestTimes({
    clientId,
    accountId: String(account.id),
    source: 'meta',
    rows: result.rows.map(r => ({ weekday: r.weekday, hour: r.hour, score: r.score })),
    note: `Instagram online_followers · ${result.days} days`,
  })
  if (!written.ok) return { ok: false, error: written.error }

  return {
    ok: true,
    data: { written: written.data?.written ?? 0, days: result.days, account: String(account.name ?? 'Instagram') },
  }
}

/**
 * Read a pasted analytics dashboard into evidence.
 *
 * Stored as source 'screenshot' whether it came from an image or a paste, so
 * a figure somebody eyeballed off a chart can never be mistaken in the
 * database for one measured through the API.
 */
export async function importBestTimesFromText(
  clientId: string,
  text: string,
): Promise<ActionResult<{ written: number; ignored: string[]; spread: boolean }>> {
  const guard = await requirePermission(PERMS.SOCIAL_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!text.trim()) return { ok: false, error: 'Paste the hours and numbers from the dashboard first.' }

  const { parseBestTimes, spreadAcrossWeek } = await import('./best-times-import')
  const parsed = parseBestTimes(text)
  if (!parsed.rows.length) {
    return { ok: false, error: 'Could not find any hour-and-number rows in that. A line like "19:00  1,240" is what it is looking for.' }
  }

  const rows = spreadAcrossWeek(parsed.rows)
  const written = await replaceBestTimes({
    clientId,
    accountId: null,
    source: 'screenshot',
    rows,
    note: parsed.hasWeekdays ? 'Pasted dashboard, per weekday' : 'Pasted dashboard, one day applied across the week',
  })
  if (!written.ok) return { ok: false, error: written.error }

  return {
    ok: true,
    data: { written: written.data?.written ?? 0, ignored: parsed.ignored, spread: !parsed.hasWeekdays },
  }
}

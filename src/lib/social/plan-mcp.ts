/* eslint-disable @typescript-eslint/no-explicit-any -- rows from the untyped Supabase admin client; each is narrowed before it leaves this file. */
/**
 * Social Calendar: the two operations the MCP server exposes.
 *
 *   list   read one client's plan for a month
 *   add    put PLANNED items (and undated ideas) into that plan
 *
 * An AI planner (Claude with the Marketing Hub, or any MCP client) drafts a
 * month of posts or a morning's trend ideas; a person approves them in the
 * chat; this writes them where the team already works. It only ever creates
 * `planned` items. Nothing is pushed to Requests, scheduled or published from
 * here: staff do that on the Social Calendar, exactly as for an item they
 * typed in themselves.
 *
 * Runs on the service-role client behind the MCP bearer token, so there is no
 * employee to attribute a row to (the same as the Shortcuts handlers).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  CONTENT_TYPES, PLATFORMS, sanitizeCaptionHtml, captionHtmlToText, suggestServiceId,
  type ContentType, type Platform,
} from '@/lib/social/plan'

export const MAX_ITEMS_PER_CALL = 80
const TITLE_MAX = 200
const TEXT_MAX = 6000

export interface PlanItemInput {
  title?: string
  /** YYYY-MM-DD inside the plan's month; leave out for an undated idea. */
  date?: string | null
  content_type?: string
  platforms?: string[]
  /** Draft caption, plain text (line breaks kept). */
  caption?: string | null
  /** The brief for the designer: idea, hook, visual direction, source link. */
  notes?: string | null
  /** A trend post: publish as soon as it is approved, without waiting for a slot. */
  asap?: boolean
}

export interface CleanPlanItem {
  scheduled_date: string | null
  title: string
  content_type: ContentType
  platforms: Platform[]
  caption: string | null
  notes: string | null
  post_asap: boolean
}

/** 'YYYY-MM' or any date in the month → 'YYYY-MM-01'; null when it is not a month. */
export function planMonth(month: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec((month ?? '').trim())
  if (!m) return null
  const mm = Number(m[2])
  return mm >= 1 && mm <= 12 ? `${m[1]}-${m[2]}-01` : null
}

const isRealDate = (iso: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false
  const d = new Date(`${iso}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso
}

/** Plain text → the caption editor's safe HTML (escaped, line breaks kept). */
export function captionFromText(text: string | null | undefined): string | null {
  const t = (text ?? '').trim().slice(0, TEXT_MAX)
  if (!t) return null
  const html = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>')
  const safe = sanitizeCaptionHtml(html)
  return captionHtmlToText(safe).trim() ? safe : null
}

/**
 * Validate one item against the plan's month. Returns the row to insert, or
 * the reason it cannot be saved (the same rules the calendar's own form uses).
 */
export function cleanPlanItem(raw: PlanItemInput, month: string): { ok: true; item: CleanPlanItem } | { ok: false; error: string } {
  const title = (raw.title ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)
  if (!title) return { ok: false, error: 'An item needs a title.' }
  const date = (raw.date ?? '').trim() || null
  if (date) {
    if (!isRealDate(date)) return { ok: false, error: `"${title}": ${date} is not a real date (use YYYY-MM-DD).` }
    if (date.slice(0, 7) !== month.slice(0, 7)) return { ok: false, error: `"${title}": ${date} is outside this plan's month (${month.slice(0, 7)}).` }
  }
  const type = (raw.content_type ?? 'post').trim().toLowerCase()
  if (!CONTENT_TYPES.includes(type as ContentType)) {
    return { ok: false, error: `"${title}": unknown content type "${type}". Use one of: ${CONTENT_TYPES.join(', ')}.` }
  }
  const platforms = [...new Set((raw.platforms ?? []).map(p => String(p).trim().toLowerCase()).filter(Boolean))]
  const bad = platforms.find(p => !PLATFORMS.includes(p as Platform))
  if (bad) return { ok: false, error: `"${title}": unknown platform "${bad}". Use: ${PLATFORMS.join(', ')}.` }
  return {
    ok: true,
    item: {
      scheduled_date: date,
      title,
      content_type: type as ContentType,
      platforms: platforms as Platform[],
      caption: captionFromText(raw.caption),
      notes: (raw.notes ?? '').trim().slice(0, TEXT_MAX) || null,
      post_asap: !!raw.asap,
    },
  }
}

/** Same day (or both undated) + same title = the same item; a re-run must not double it. */
export const itemKey = (date: string | null | undefined, title: string | null | undefined) =>
  `${date ? String(date).slice(0, 10) : ''}|${(title ?? '').replace(/\s+/g, ' ').trim().toLowerCase()}`

const isMissingRelation = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|schema cache/i.test(e.message ?? ''))

const ITEM_COLS = 'id, scheduled_date, title, content_type, platforms, caption, notes, status'

export async function listSocialPlan(admin: SupabaseClient<any, any, any>, clientId: string, month: string) {
  const { data: cal, error } = await admin.from('social_calendars')
    .select('id, month, title, status').eq('client_id', clientId).eq('month', month).maybeSingle()
  if (error) return { ok: false as const, error: isMissingRelation(error) ? 'The Social Calendar tables are not set up in this environment.' : error.message }
  if (!cal) return { ok: true as const, plan: null, items: [] as any[] }
  const { data: items, error: itemsErr } = await admin.from('social_calendar_items')
    .select(ITEM_COLS).eq('calendar_id', (cal as any).id)
    .order('scheduled_date', { ascending: true, nullsFirst: true }).limit(500)
  if (itemsErr) return { ok: false as const, error: itemsErr.message }
  return {
    ok: true as const,
    plan: cal as { id: string; month: string; title: string | null; status: string },
    items: ((items ?? []) as any[]).map(i => ({
      ...i,
      scheduled_date: i.scheduled_date ? String(i.scheduled_date).slice(0, 10) : null,
      caption: i.caption ? captionHtmlToText(i.caption) : null,
    })),
  }
}

/** Content type → the service its design request will carry (the calendar's own rule). */
async function serviceResolver(admin: SupabaseClient<any, any, any>) {
  try {
    const [{ data: mapRow }, { data: services }] = await Promise.all([
      admin.from('company_settings').select('value').eq('key', 'social_content_type_services').maybeSingle(),
      admin.from('services').select('id, name').eq('is_active', true),
    ])
    let serviceMap: Record<string, string> = {}
    try { if ((mapRow as any)?.value) serviceMap = JSON.parse((mapRow as any).value) } catch { /* malformed map: keyword fallback */ }
    return (type: string) => suggestServiceId(type, ((services ?? []) as { id: string; name: string }[]), serviceMap)
  } catch {
    return () => null // never block a save on service resolution
  }
}

/** Columns added by later migrations; an environment without one still saves the rest. */
const OPTIONAL_COLS = ['service_id', 'post_asap', 'created_by'] as const

export async function addSocialPlanItems(
  admin: SupabaseClient<any, any, any>,
  p: {
    clientId: string; month: string; items: PlanItemInput[]; planTitle?: string | null
    /** The employee adding them, when a signed-in person is (the MCP route has none). */
    createdBy?: string | null
  },
) {
  if (!p.items?.length) return { ok: false as const, error: 'Give at least one item.' }
  if (p.items.length > MAX_ITEMS_PER_CALL) return { ok: false as const, error: `At most ${MAX_ITEMS_PER_CALL} items in one call.` }

  // Validate everything before writing anything: a half-saved month is worse than none.
  const clean: CleanPlanItem[] = []
  const errors: string[] = []
  for (const raw of p.items) {
    const r = cleanPlanItem(raw, p.month)
    if (r.ok) clean.push(r.item); else errors.push(r.error)
  }
  if (errors.length) return { ok: false as const, error: `Nothing was saved. ${errors.join(' ')}` }

  const found = await admin.from('social_calendars')
    .select('id, status').eq('client_id', p.clientId).eq('month', p.month).maybeSingle()
  const calErr = found.error
  let cal = found.data
  if (calErr) return { ok: false as const, error: isMissingRelation(calErr) ? 'The Social Calendar tables are not set up in this environment.' : calErr.message }
  if ((cal as any)?.status === 'archived') return { ok: false as const, error: 'This plan is archived. Reopen it on the Social Calendar first.' }
  let createdPlan = false
  if (!cal) {
    const ins = await admin.from('social_calendars').insert({
      client_id: p.clientId, month: p.month, title: p.planTitle?.trim() || null, status: 'active',
      ...(p.createdBy ? { created_by: p.createdBy } : {}),
    }).select('id, status').single()
    if (ins.error && ins.error.code === '23505') {
      // Someone created it in the same moment: use theirs.
      ins.data = (await admin.from('social_calendars').select('id, status').eq('client_id', p.clientId).eq('month', p.month).maybeSingle()).data as any
    } else if (ins.error) {
      return { ok: false as const, error: ins.error.message }
    } else {
      createdPlan = true
    }
    cal = ins.data
  }
  const calendarId = (cal as any)?.id as string | undefined
  if (!calendarId) return { ok: false as const, error: 'Could not open the plan for that month.' }

  const { data: existing } = await admin.from('social_calendar_items')
    .select('scheduled_date, title').eq('calendar_id', calendarId).neq('status', 'cancelled').limit(1000)
  const seen = new Set(((existing ?? []) as any[]).map(e => itemKey(e.scheduled_date, e.title)))
  const fresh: CleanPlanItem[] = []
  const skipped: string[] = []
  for (const it of clean) {
    const k = itemKey(it.scheduled_date, it.title)
    if (seen.has(k)) { skipped.push(it.title); continue }
    seen.add(k)
    fresh.push(it)
  }
  if (!fresh.length) return { ok: true as const, calendarId, createdPlan, added: 0, skipped, items: [] as any[] }

  const serviceFor = await serviceResolver(admin)
  let rows: Record<string, unknown>[] = fresh.map(it => ({
    calendar_id: calendarId, ...it, status: 'planned', service_id: serviceFor(it.content_type),
    ...(p.createdBy ? { created_by: p.createdBy } : {}),
  }))
  let res = await admin.from('social_calendar_items').insert(rows).select(ITEM_COLS)
  // Drop whichever optional column the database names, one at a time, in any order.
  for (let tries = 0; tries < OPTIONAL_COLS.length && res.error; tries++) {
    const msg = res.error.message ?? ''
    const col = OPTIONAL_COLS.find(c => c in rows[0] && new RegExp(`'${c}'|\\b${c}\\b`).test(msg))
    if (!col) break
    rows = rows.map(r => { const c = { ...r }; delete c[col]; return c })
    res = await admin.from('social_calendar_items').insert(rows).select(ITEM_COLS)
  }
  if (res.error) return { ok: false as const, error: res.error.message }
  return { ok: true as const, calendarId, createdPlan, added: (res.data ?? []).length, skipped, items: (res.data ?? []) as any[] }
}

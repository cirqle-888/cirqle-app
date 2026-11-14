/**
 * WhatsApp listener — puts a client's offer price list on its social calendar.
 * Rules: offer-plan.ts. Reads from WhatsApp only; never sends anything.
 *
 * Returns true when the message was dealt with here (so it is not ALSO filed
 * as a request: the calendar item is pushed to Requests from the planner, and
 * filing both would make the same flyer twice). Returns false to let the
 * normal request flow have the message.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createNotification, notifyAdmins } from '@/lib/notifications/create'
import { suggestServiceId } from '@/lib/social/plan'
import { indiaDay } from './chat-log'
import { isVoiceOrPhoto, type ListenerMessage } from './rules'
import {
  DATE_ASSUMED_LINE, DATE_FOLLOW_UP_MINUTES, OFFER_ITEM_TITLE, STALE_HOURS,
  additionMarker, chatMarker, dateLabel, dateOnlyMessage, isSmallAddition, messageMarker, notesWithAddition, notesWithDate,
  offerDates, offerNotes, priceListSize,
  type OfferDates,
} from './offer-plan'

const CALENDARS = 'social_calendars'
const ITEMS = 'social_calendar_items'
const LINK = '/dashboard/social-calendar'
/** Columns added by later migrations: dropped one at a time if the database does not have them. */
const OPTIONAL = ['service_id', 'scheduled_end_date'] as const

export interface OfferPlanInput {
  enabled: boolean
  /** The client this chat belongs to, as named on the allow-list ('' = none). */
  clientName: string
  isStaffPhone: (phone: string) => Promise<boolean>
  /** The person responsible for this chat, or its department's people: told as well as the admins. */
  tellIds?: readonly string[]
  /** What a photo says, as already worked out for the chat view (null when photo reading is off). */
  mediaText?: (() => Promise<string | null>) | null
}

const likeSafe = (s: string) => s.replace(/[%\\]/g, '')

async function clientId(admin: SupabaseClient, name: string): Promise<string | null> {
  const { data } = await admin.from('clients').select('id').ilike('name', likeSafe(name)).limit(2)
  return data && data.length === 1 ? (data[0].id as string) : null
}

/** The client's plan for that month, made if there is none yet. */
async function calendarFor(admin: SupabaseClient, client: string, day: string): Promise<string | null> {
  const month = `${day.slice(0, 7)}-01`
  const find = () => admin.from(CALENDARS).select('id').eq('client_id', client).eq('month', month).maybeSingle()
  const existing = await find()
  if (existing.data?.id) return existing.data.id as string
  const made = await admin.from(CALENDARS).insert({ client_id: client, month, status: 'active' }).select('id').single()
  if (made.data?.id) return made.data.id as string
  // 23505: another message made it a moment ago.
  return made.error?.code === '23505' ? ((await find()).data?.id as string | undefined) ?? null : null
}

async function flyerService(admin: SupabaseClient): Promise<string | null> {
  try {
    const [{ data: mapRow }, { data: services }] = await Promise.all([
      admin.from('company_settings').select('value').eq('key', 'social_content_type_services').maybeSingle(),
      admin.from('services').select('id, name').eq('is_active', true),
    ])
    let map: Record<string, string> = {}
    try { if (mapRow?.value) map = JSON.parse(mapRow.value) } catch { /* keyword guess instead */ }
    return suggestServiceId('flyer', (services as { id: string; name: string }[]) || [], map)
  } catch { return null }
}

/** Writes a row, leaving out any optional column this database does not have yet. */
async function writeTolerant(
  row: Record<string, unknown>,
  run: (row: Record<string, unknown>) => PromiseLike<{ error: { message?: string } | null }>,
): Promise<{ error: { message?: string } | null }> {
  let current = row
  let res = await run(current)
  for (const col of OPTIONAL) {
    if (!res.error || !(col in current) || !(res.error.message || '').includes(col)) continue
    current = { ...current }
    delete current[col]
    res = await run(current)
  }
  return res
}

async function tell(input: OfferPlanInput, content: { title: string; message: string; sourceKey: string }): Promise<void> {
  const note = { type: 'whatsapp_request' as const, link: LINK, ...content }
  await notifyAdmins(note).catch(() => {})
  for (const employeeId of input.tellIds ?? []) await createNotification({ ...note, employeeId }).catch(() => {})
}

async function addList(
  admin: SupabaseClient, m: ListenerMessage, input: OfferPlanInput, products: number, today: string, fromPhoto = false,
): Promise<boolean> {
  const client = await clientId(admin, input.clientName)
  if (!client) return false

  const seen = await admin.from(ITEMS).select('id').like('notes', `%${likeSafe(messageMarker(m.id))}%`).limit(1)
  if (seen.error) return false // calendar tables missing: let it be filed as a request
  if (seen.data?.length) return true

  const dates = offerDates(m.body, today)
  const calendar = await calendarFor(admin, client, dates.start)
  if (!calendar) return false

  const row = {
    calendar_id: calendar,
    scheduled_date: dates.start,
    scheduled_end_date: dates.end,
    title: OFFER_ITEM_TITLE,
    content_type: 'flyer',
    platforms: [],
    status: 'planned',
    notes: offerNotes({
      list: m.body, client: input.clientName, sender: m.senderName, products, dates, messageId: m.id, chatId: m.chatId, fromPhoto,
    }),
    service_id: await flyerService(admin),
  }
  const { error } = await writeTolerant(row, r => admin.from(ITEMS).insert(r))
  if (error) { console.warn('[whatsapp-listener] offer list not added to the calendar:', error.message); return false }

  await tell(input, {
    title: `Offer list — ${input.clientName}`,
    message: `${products} products${fromPhoto ? ' read from a photo' : ''} for ${dateLabel(dates)}${dates.given ? '' : ' (date not given, set to the next day)'}. Added to the social calendar as "${OFFER_ITEM_TITLE}".`,
    sourceKey: `whatsapp_offer:${m.id}`,
  })
  return true
}

/** The client sent the date on its own: move the list it belongs to. */
async function applyDate(admin: SupabaseClient, m: ListenerMessage, input: OfferPlanInput, dates: OfferDates): Promise<boolean> {
  const since = new Date(Date.now() - DATE_FOLLOW_UP_MINUTES * 60_000).toISOString()
  const { data } = await admin.from(ITEMS).select('id, calendar_id, notes, scheduled_date')
    .like('notes', `%${likeSafe(chatMarker(m.chatId))}%`).like('notes', `%${DATE_ASSUMED_LINE}%`)
    .eq('status', 'planned').gte('created_at', since).order('created_at', { ascending: false }).limit(1)
  const item = data?.[0] as { id: string; calendar_id: string; notes: string; scheduled_date: string } | undefined
  if (!item) return false

  let calendar = item.calendar_id
  if (dates.start.slice(0, 7) !== item.scheduled_date.slice(0, 7)) {
    const { data: cal } = await admin.from(CALENDARS).select('client_id').eq('id', item.calendar_id).maybeSingle()
    const moved = cal?.client_id ? await calendarFor(admin, cal.client_id as string, dates.start) : null
    if (!moved) return false
    calendar = moved
  }
  const { error } = await writeTolerant({
    calendar_id: calendar, scheduled_date: dates.start, scheduled_end_date: dates.end,
    notes: notesWithDate(item.notes, dates), updated_at: new Date().toISOString(),
  }, r => admin.from(ITEMS).update(r).eq('id', item.id))
  if (error) return false

  await tell(input, {
    title: `Offer date — ${input.clientName}`,
    message: `The client gave the date: ${dateLabel(dates)}. The flyer on the social calendar has been moved.`,
    sourceKey: `whatsapp_offer_date:${m.id}`,
  })
  return true
}

/** A product or two sent after the list: added to that list's notes, so one flyer stays one item. */
async function addToRecentList(admin: SupabaseClient, m: ListenerMessage): Promise<boolean> {
  const since = new Date(Date.now() - DATE_FOLLOW_UP_MINUTES * 60_000).toISOString()
  const { data } = await admin.from(ITEMS).select('id, notes')
    .like('notes', `%${likeSafe(chatMarker(m.chatId))}%`)
    .eq('status', 'planned').gte('created_at', since).order('created_at', { ascending: false }).limit(1)
  const item = data?.[0] as { id: string; notes: string } | undefined
  if (!item) return false
  if (item.notes.includes(additionMarker(m.id))) return true
  const { error } = await admin.from(ITEMS)
    .update({ notes: notesWithAddition(item.notes, m.body, m.id), updated_at: new Date().toISOString() }).eq('id', item.id)
  return !error
}

export async function planOfferFromMessage(admin: SupabaseClient, m: ListenerMessage, input: OfferPlanInput): Promise<boolean> {
  if (!input.enabled || !input.clientName || m.fromMe || m.event !== 'message.received') return false
  // Caught up after the listener was off: an old list is for an offer that has likely passed.
  if (m.sentAtMs && Date.now() - m.sentAtMs > STALE_HOURS * 3_600_000) return false
  const today = indiaDay(new Date(m.sentAtMs ?? Date.now()).toISOString())

  if (m.type === 'image') {
    // Cirqle posts its finished flyers as photos in the same group, and those are full of prices too.
    // So a photo counts only when the sender is known and is not Cirqle.
    if (!input.mediaText || !m.senderPhone) return false
    if (await input.isStaffPhone(m.senderPhone).catch(() => true)) return false
    const read = await input.mediaText().catch(() => null)
    // The caption may carry the date ("DATE 14/15").
    const text = [m.body.trim(), (read || '').trim()].filter(Boolean).join('\n')
    const found = priceListSize(text)
    return found ? addList(admin, { ...m, body: text }, input, found, today, true) : false
  }
  if (isVoiceOrPhoto(m.type) || !m.body.trim()) return false

  const products = priceListSize(m.body)
  const dates = products ? null : dateOnlyMessage(m.body, today)
  const addition = !products && !dates && isSmallAddition(m.body)
  if (!products && !dates && !addition) return false
  // Cirqle's own staff paste lists and dates into the group too: those are not the client's.
  if (m.senderPhone && await input.isStaffPhone(m.senderPhone).catch(() => false)) return false

  if (products) return addList(admin, m, input, products, today)
  if (dates) return applyDate(admin, m, input, dates)
  return addToRecentList(admin, m)
}

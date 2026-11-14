/**
 * WhatsApp listener — loads the flyer desk and sends its evening nudge.
 * Rules: flyer-desk.ts. Reads the social calendar and the chat log; the only
 * thing it writes is a Cirqle notification. Nothing goes to WhatsApp.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { callGroqJSON } from '@/lib/ai/groq'
import { createNotification, notifyAdmins } from '@/lib/notifications/create'
import { syncRequestStatusFromTask } from '@/lib/requests/task-sync'
import { isFinishedTaskStatus } from '@/lib/social/plan'
import { CHAT_LOG_TABLE, indiaDay } from './chat-log'
import { chatAlertTargets } from './insights'
import { chatTitle, departmentMembers, type ListenerContext } from './insights-run'
import { addDays, dateLabel, offerTagDates } from './offer-plan'
import {
  APPROVED_MARK, STAGE_LABEL, TITLE_PROMPT, campaignTitle, cleanOfferTitle, flyerProgress, isBehind, notesWithApproval, offerList, offerSource,
  priceWarnings, pricedProducts, type CampaignRow,
  type DeskMessage, type FlyerProgress,
} from './flyer-desk'

export const FLYERS_LINK = '/dashboard/requests/whatsapp/flyers'
/** How far back the desk looks: last week's flyers are history. */
export const DESK_DAYS = 7

export interface DeskFlyer {
  itemId: string
  chatId: string
  title: string
  notes: string
  clientId: string | null
  taskId: string | null
  requestId: string | null
  client: string
  offerStart: string
  offerEnd: string | null
  receivedAt: string
  products: number
  list: string
  fromPhoto: boolean
  dateAssumed: boolean
  /** Pushed to Requests / cancelled on the social calendar. */
  calendarStatus: string
  progress: FlyerProgress
  warnings: string[]
}

interface ItemRow {
  id: string; calendar_id: string; scheduled_date: string; scheduled_end_date?: string | null
  notes: string | null; status: string; created_at: string
  title?: string | null; task_id?: string | null; request_id?: string | null
}

/** The offer flyers that came in over WhatsApp for these chats, newest offer first. */
export async function loadFlyerDesk(admin: SupabaseClient, chatIds: ReadonlySet<string>, today: string): Promise<{ flyers: DeskFlyer[]; missing: boolean }> {
  if (!chatIds.size) return { flyers: [], missing: false }
  const since = addDays(today, -DESK_DAYS)
  // Earlier lists too (not shown): the price check compares against them.
  let res = await admin.from('social_calendar_items')
    .select('id, calendar_id, scheduled_date, scheduled_end_date, notes, status, created_at, title, task_id, request_id')
    .like('notes', '%[whatsapp:%').gte('scheduled_date', addDays(today, -45)).order('created_at', { ascending: false }).limit(600)
  if (res.error && /scheduled_end_date|task_id/.test(res.error.message || '')) {
    res = await admin.from('social_calendar_items').select('id, calendar_id, scheduled_date, notes, status, created_at, title, request_id')
      .like('notes', '%[whatsapp:%').gte('scheduled_date', addDays(today, -45)).order('created_at', { ascending: false }).limit(600) as typeof res
  }
  if (res.error) return { flyers: [], missing: true }

  const rows = ((res.data || []) as ItemRow[])
    .map(r => ({ row: r, source: offerSource(r.notes) }))
    .filter((x): x is { row: ItemRow; source: NonNullable<ReturnType<typeof offerSource>> } => !!x.source && chatIds.has(x.source.chatId))
  const shown = rows.filter(x => x.row.scheduled_date >= since && x.row.status !== 'cancelled')
  if (!shown.length) return { flyers: [], missing: false }

  const calendarIds = [...new Set(shown.map(x => x.row.calendar_id))]
  const { data: cals } = await admin.from('social_calendars').select('id, client_id, client:clients(name)').in('id', calendarIds)
  const clientOf = new Map<string, string>()
  const clientIdOf = new Map<string, string>()
  for (const c of (cals || []) as unknown as { id: string; client_id: string | null; client: { name: string | null } | { name: string | null }[] | null }[]) {
    const rel = Array.isArray(c.client) ? c.client[0] : c.client
    clientOf.set(c.id, rel?.name || '')
    if (c.client_id) clientIdOf.set(c.id, c.client_id)
  }

  const oldest = shown.reduce((min, x) => (x.row.created_at < min ? x.row.created_at : min), shown[0].row.created_at)
  const chats = [...new Set(shown.map(x => x.source.chatId))]
  const read = (cols: string) => admin.from(CHAT_LOG_TABLE).select(cols).in('chat_id', chats).gte('sent_at', oldest).order('sent_at', { ascending: true }).limit(6000)
  let { data: msgs } = await read('chat_id, from_cirqle, type, body, sent_at, media_text')
  // Before the reports migration there is no media_text column.
  if (!msgs) msgs = (await read('chat_id, from_cirqle, type, body, sent_at')).data
  const byChat = new Map<string, DeskMessage[]>()
  for (const m of (msgs || []) as unknown as DeskMessage[]) (byChat.get(m.chat_id) ?? byChat.set(m.chat_id, []).get(m.chat_id)!).push(m)

  const flyers = shown.map(({ row, source }) => {
    const sameChat = rows.filter(x => x.source.chatId === source.chatId)
    // This flyer's part of the conversation ends where the client's next list begins.
    const next = sameChat.filter(x => x.row.created_at > row.created_at).map(x => x.row.created_at).sort()[0] ?? null
    const list = offerList(row.notes)
    // The plan is dated the work day; the offer's own dates are in the notes (older items: the plan date).
    const offer = offerTagDates(row.notes) ?? { start: row.scheduled_date, end: row.scheduled_end_date ?? null }
    const earlier = sameChat.filter(x => x.row.created_at < row.created_at).map(x => offerList(x.row.notes))
    return {
      itemId: row.id,
      chatId: source.chatId,
      title: row.title || '',
      notes: row.notes || '',
      clientId: clientIdOf.get(row.calendar_id) ?? null,
      taskId: row.task_id ?? null,
      requestId: row.request_id ?? null,
      client: clientOf.get(row.calendar_id) || '',
      offerStart: offer.start,
      offerEnd: offer.end,
      receivedAt: row.created_at,
      products: pricedProducts(list).length,
      list,
      fromPhoto: (row.notes || '').startsWith('Read by AI from a photo'),
      dateAssumed: (row.notes || '').includes('not given, so it is set to the next day'),
      calendarStatus: row.status,
      progress: flyerProgress(byChat.get(source.chatId) || [], row.created_at, next),
      warnings: priceWarnings(list, earlier),
    } satisfies DeskFlyer
  })
  flyers.sort((a, b) => (a.offerStart === b.offerStart ? b.receivedAt.localeCompare(a.receivedAt) : b.offerStart.localeCompare(a.offerStart)))
  return { flyers, missing: false }
}

/**
 * The evening nudge: an offer starts today or tomorrow and the client still has
 * no finished design in the group. Goes to the chat's person or department, else the admins.
 */
export async function alertFlyerDeadlines(admin: SupabaseClient, ctx: ListenerContext): Promise<number> {
  const today = indiaDay(new Date().toISOString())
  const tomorrow = addDays(today, 1)
  const { flyers } = await loadFlyerDesk(admin, new Set(ctx.groups.keys()), today)
  const behind = flyers.filter(f => isBehind(f.progress.stage, f.offerStart, today, tomorrow))
  if (!behind.length) return 0
  const members = await departmentMembers(admin)
  for (const f of behind) {
    const content = {
      type: 'whatsapp_pending' as const,
      title: `Flyer due ${f.offerStart === today ? 'today' : 'tomorrow'} — ${f.client || chatTitle(ctx, f.chatId)}`,
      message: `${f.products} products for ${dateLabel({ start: f.offerStart, end: f.offerEnd })}. ${STAGE_LABEL[f.progress.stage]}.`,
      link: FLYERS_LINK,
      // Once per flyer per evening.
      sourceKey: `whatsapp_flyer_due:${f.itemId}:${today}`,
    }
    const targets = chatAlertTargets(ctx.access[f.chatId], members)
    if (targets.length) for (const employeeId of targets) await createNotification({ ...content, employeeId })
    else await notifyAdmins(content)
  }
  return behind.length
}

/** The offer title for an approved flyer: the Offer Studio offer for those dates, else the headline on the design. */
async function offerTitleFor(admin: SupabaseClient, f: DeskFlyer): Promise<string | null> {
  if (f.clientId) {
    const { data } = await admin.from('offer_campaigns').select('title, offer_date, offer_date_from, offer_date_to, created_at')
      .eq('client_id', f.clientId).order('created_at', { ascending: false }).limit(30)
    const fromStudio = campaignTitle((data || []) as CampaignRow[], f.offerStart)
    if (fromStudio) return fromStudio
  }
  if (!f.progress.designText) return null
  const out = await callGroqJSON(TITLE_PROMPT, f.progress.designText.slice(0, 3000)).catch(() => null)
  return cleanOfferTitle(out?.title)
}

/**
 * The client said "ok" to a design: the flyer takes its offer title in place of
 * "Untitled" (on the calendar and on its task), and the task is marked done.
 * Done once per flyer. A flyer with no task yet is renamed and noted as approved.
 */
export async function finishApprovedFlyers(admin: SupabaseClient, ctx: ListenerContext, onlyChats?: ReadonlySet<string>): Promise<number> {
  const today = indiaDay(new Date().toISOString())
  const { flyers } = await loadFlyerDesk(admin, onlyChats ?? new Set(ctx.groups.keys()), today)
  const ready = flyers.filter(f => f.progress.stage === 'approved' && !f.notes.includes(APPROVED_MARK))
  if (!ready.length) return 0
  const members = await departmentMembers(admin)
  let done = 0
  for (const f of ready) {
    const found = await offerTitleFor(admin, f)
    const title = found && /^untitled$/i.test(f.title.trim() || 'untitled') ? found : null

    // Claimed with the marker first, so two deliveries arriving together cannot both close it.
    const claim = await admin.from('social_calendar_items')
      .update({ ...(title ? { title } : {}), notes: notesWithApproval(f.notes, today), updated_at: new Date().toISOString() })
      .eq('id', f.itemId).not('notes', 'like', `%${APPROVED_MARK}%`).select('id')
    if (claim.error || !claim.data?.length) continue

    let taskId = f.taskId
    if (!taskId && f.requestId) {
      const { data: req } = await admin.from('task_requests').select('promoted_task_id').eq('id', f.requestId).maybeSingle()
      taskId = (req?.promoted_task_id as string | null) ?? null
      if (title) await admin.from('task_requests').update({ title }).eq('id', f.requestId).then(() => {}, () => {})
    }
    let closed = false
    if (taskId) {
      const { data: task } = await admin.from('tasks').select('status, deleted_at').eq('id', taskId).maybeSingle()
      if (task && !task.deleted_at && task.status !== 'cancelled') {
        // An invoiced or paid task keeps its status: only its name is corrected.
        const finish = !isFinishedTaskStatus(task.status as string) || task.status === 'delivered'
        const patch = { ...(title ? { title } : {}), ...(finish ? { status: 'done' } : {}) }
        if (Object.keys(patch).length) {
          const { error } = await admin.from('tasks').update(patch).eq('id', taskId)
          closed = !error && finish
          if (closed) await syncRequestStatusFromTask(taskId, 'done').catch(() => {})
        }
      }
    }

    const name = f.client || chatTitle(ctx, f.chatId)
    const content = {
      type: 'whatsapp_pending' as const,
      title: `Flyer approved — ${name}`,
      message: [
        title ? `Named "${title}".` : 'No offer title could be found, so it is still "Untitled": name it by hand.',
        closed ? 'Its task is marked done.' : taskId ? 'Its task was already closed.' : 'It has no task yet, so nothing was marked done.',
      ].join(' '),
      link: FLYERS_LINK,
      sourceKey: `whatsapp_flyer_approved:${f.itemId}`,
    }
    const targets = chatAlertTargets(ctx.access[f.chatId], members)
    if (targets.length) for (const employeeId of targets) await createNotification({ ...content, employeeId })
    else await notifyAdmins(content)
    done++
  }
  return done
}

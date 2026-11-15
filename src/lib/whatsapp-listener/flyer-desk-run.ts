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
  APPROVED_MARK, STAGE_LABEL, TITLE_PROMPT, approvedPages, campaignTitle, cleanOfferTitle, flyerProgress, isBehind, notesWithApproval, notesWithPages,
  offerFollowUps, offerList, offerSource, pagesLabel, priceWarnings, pricedProducts, type CampaignRow,
  type DeskMessage, type FlyerProgress,
} from './flyer-desk'
import { MAX_AUTO_PAGES, setFlyerTaskPages, type FlyerBilling } from './flyer-task'

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
  /** Products on the list that still have no price. */
  unpriced: number
  /** What the client said about the flyer after the list. */
  followUps: string[]
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
    // A cancelled item is no flyer: it must not cut short the one it was a duplicate of.
    .filter((x): x is { row: ItemRow; source: NonNullable<ReturnType<typeof offerSource>> } => !!x.source && chatIds.has(x.source.chatId) && x.row.status !== 'cancelled')
  const shown = rows.filter(x => x.row.scheduled_date >= since)
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
      products: list.split('\n').filter(Boolean).length,
      unpriced: list.split('\n').filter(Boolean).length - pricedProducts(list).length,
      followUps: offerFollowUps(row.notes),
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
  // A page posted after the "ok" was not there to count when the flyer was closed.
  const grown = flyers.filter(f => f.progress.stage === 'approved' && f.notes.includes(APPROVED_MARK)
    && approvedPages(f.notes) !== null && (f.progress.pages ?? 0) > approvedPages(f.notes)!)
  if (!ready.length && !grown.length) return 0
  const members = await departmentMembers(admin)
  const tell = async (f: DeskFlyer, content: Omit<Parameters<typeof notifyAdmins>[0], 'type' | 'link'>) => {
    const full = { type: 'whatsapp_pending' as const, link: FLYERS_LINK, ...content }
    const targets = chatAlertTargets(ctx.access[f.chatId], members)
    if (targets.length) for (const employeeId of targets) await createNotification({ ...full, employeeId })
    else await notifyAdmins(full)
  }

  for (const f of grown) {
    const before = approvedPages(f.notes)!
    const pages = f.progress.pages!
    const claim = await admin.from('social_calendar_items')
      .update({ notes: notesWithPages(f.notes, pages), updated_at: new Date().toISOString() })
      .eq('id', f.itemId).like('notes', `%[pages:${before}]%`).select('id')
    if (claim.error || !claim.data?.length) continue
    const taskId = await flyerTaskId(admin, f)
    const billed = taskId ? await setFlyerTaskPages(admin, taskId, pages, before) : null
    await tell(f, {
      title: `Flyer has ${pages} pages — ${f.client || chatTitle(ctx, f.chatId)}`,
      message: `${f.title || 'The flyer'} was counted as ${before} when the client approved it; another page was posted afterwards. ${billingLine(pages, billed, !!taskId)}`,
      sourceKey: `whatsapp_flyer_pages:${f.itemId}:${pages}`,
    })
  }

  let done = 0
  for (const f of ready) {
    const found = await offerTitleFor(admin, f)
    const title = found && /^untitled$/i.test(f.title.trim() || 'untitled') ? found : null

    // Claimed with the marker first, so two deliveries arriving together cannot both close it.
    const claim = await admin.from('social_calendar_items')
      .update({ ...(title ? { title } : {}), notes: notesWithApproval(f.notes, today, f.progress.pages), updated_at: new Date().toISOString() })
      .eq('id', f.itemId).not('notes', 'like', `%${APPROVED_MARK}%`).select('id')
    if (claim.error || !claim.data?.length) continue

    const taskId = await flyerTaskId(admin, f)
    if (title && !f.taskId && f.requestId) await admin.from('task_requests').update({ title }).eq('id', f.requestId).then(() => {}, () => {})
    let closed = false
    // Billed by the page: the quantity follows the pages the designs show.
    const billed = taskId && f.progress.pages ? await setFlyerTaskPages(admin, taskId, f.progress.pages) : null
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

    await tell(f, {
      title: `Flyer approved — ${f.client || chatTitle(ctx, f.chatId)}`,
      message: [
        title ? `Named "${title}".` : 'No offer title could be found, so it is still "Untitled": name it by hand.',
        closed ? 'Its task is marked done.' : taskId ? 'Its task was already closed.' : 'It has no task yet, so nothing was marked done.',
        f.progress.pages
          ? billingLine(f.progress.pages, billed, !!taskId) + (f.progress.unreadDesigns ? ` ${f.progress.unreadDesigns} of the pictures could not be read, so check the page count.` : '')
          : `The pages could not be counted (${pagesLabel(f.progress)}): check the quantity on its task.`,
      ].join(' '),
      sourceKey: `whatsapp_flyer_approved:${f.itemId}`,
    })
    done++
  }
  return done + grown.length
}

/** The flyer's task: linked straight to the calendar item, or made from its request. */
async function flyerTaskId(admin: SupabaseClient, f: DeskFlyer): Promise<string | null> {
  if (f.taskId || !f.requestId) return f.taskId
  const { data: req } = await admin.from('task_requests').select('promoted_task_id').eq('id', f.requestId).maybeSingle()
  return (req?.promoted_task_id as string | null) ?? null
}

/** What happened to the task's quantity, in one sentence for the alert. */
function billingLine(pages: number, billed: FlyerBilling | null, hasTask: boolean): string {
  const count = `${pages} page${pages === 1 ? '' : 's'}`
  if (!hasTask) return `${count}.`
  if (billed?.changed) {
    const amount = billed.amount ? ` (${billed.currency === 'INR' || !billed.currency ? '₹' : `${billed.currency} `}${billed.amount})` : ''
    return `${count}: its task is set to quantity ${pages}${amount}.`
  }
  if (billed?.quantity === pages) return `${count}, and its task already has quantity ${pages}.`
  if (pages > MAX_AUTO_PAGES) return `${count} were counted, which is unusually many: set the quantity on its task by hand.`
  return `${count} were counted, but its task has quantity ${billed?.quantity ?? 1}: it was left as it is, so check it.`
}

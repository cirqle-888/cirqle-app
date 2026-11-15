/**
 * WhatsApp listener — the task for an offer flyer.
 *
 * An offer price list is a job for the flyer desk the moment it arrives, so its
 * calendar item gets a task straight away (the planner's "skip the inbox" exit:
 * the item is linked through `task_id` and reads "tasked"). The client's "ok"
 * later renames that task to the offer title and marks it done (flyer-desk-run).
 *
 * The task is made the same way Offer Studio makes one (api/figma/campaign):
 * the Offer Flyer service, quantity 1, no price typed in, and the client's
 * package linked when there is one — so it bills exactly like a flyer saved from
 * Figma. Offer Studio looks for this task before making its own (see the marker
 * below), so a flyer worked in both places is still one task.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveFlyerService } from '@/app/api/figma/_lib/flyer-department'
import { autoLinkTaskPackage } from '@/lib/packages/auto-link'
import { OFFER_ITEM_TITLE, dateLabel, offerTag, type OfferDates } from './offer-plan'

const ITEMS = 'social_calendar_items'

/** In the task's description: finds the task of a calendar item, and tells Offer Studio the task exists. */
export const FLYER_TASK_MARK = '[whatsapp-flyer:'
export const flyerTaskMarker = (itemId: string) => `${FLYER_TASK_MARK}${itemId}]`

export function flyerTaskDescription(o: { itemId: string; products: number; offer: OfferDates }): string {
  return `Offer flyer from a WhatsApp price list — ${o.products} products, offer ${dateLabel(o.offer)}. ` +
    `The list is on the Social Calendar item and under Requests → WhatsApp chats → Flyers. ${flyerTaskMarker(o.itemId)} ${offerTag(o.offer)}`
}

export interface FlyerTaskInput {
  itemId: string
  clientId: string
  title: string
  /** The day the flyer is worked on: the task's date. */
  workDate: string
  products: number
  offer: OfferDates
  /** The person responsible for the chat, put on the task when there is one. */
  assigneeId?: string | null
}

/**
 * Makes the flyer's task and links the calendar item to it. Safe to call again:
 * an item that already has a task, or was sent to Requests by hand, is left alone.
 * Returns the task id, or null when no task was made.
 */
export async function ensureFlyerTask(admin: SupabaseClient, input: FlyerTaskInput): Promise<string | null> {
  const { data: item, error: itemError } = await admin.from(ITEMS).select('id, status, task_id, request_id').eq('id', input.itemId).maybeSingle()
  // No task_id column: the direct-task migration is not applied, so the item stays a plan item.
  if (itemError || !item) return null
  const row = item as { status: string; task_id: string | null; request_id: string | null }
  if (row.task_id) return row.task_id
  if (row.request_id || row.status !== 'planned') return null

  // A task made a moment ago by another delivery of the same message.
  const { data: made } = await admin.from('tasks').select('id')
    .ilike('description', `%${flyerTaskMarker(input.itemId)}%`).is('deleted_at', null).limit(1)
  let taskId = (made?.[0] as { id: string } | undefined)?.id ?? null

  if (!taskId) {
    const { serviceId } = await resolveFlyerService(admin, null)
    // task_number is max + 1 under a unique index: retry when another task took the number.
    for (let attempt = 0; attempt < 5 && !taskId; attempt++) {
      const { data: maxRow } = await admin.from('tasks').select('task_number')
        .order('task_number', { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
      const candidate = (((maxRow as { task_number?: number } | null)?.task_number) ?? 0) + 1 + attempt
      const { data: taskRow, error } = await admin.from('tasks').insert({
        task_number: candidate,
        title: input.title.trim() || OFFER_ITEM_TITLE,
        description: flyerTaskDescription({ itemId: input.itemId, products: input.products, offer: input.offer }),
        client_id: input.clientId,
        service_id: serviceId,
        status: 'pending',
        task_date: input.workDate,
        quantity: 1,
      }).select('id').single()
      if (!error) { taskId = (taskRow as { id: string }).id; break }
      if ((error as { code?: string }).code !== '23505') { console.warn('[whatsapp-listener] flyer task not created:', error.message); return null }
    }
    if (!taskId) return null
    await autoLinkTaskPackage(admin, taskId)
    // Priced the way the Add Task form prices it: the client's price for the service
    // (Pricing Matrix), else the service default, for one flyer. Pages are not known
    // yet, so the quantity stays 1 until someone sets it.
    await priceFlyerTask(taskId, input.clientId, serviceId)
    if (input.assigneeId) {
      await admin.from('task_assignments').insert({ task_id: taskId, employee_id: input.assigneeId }).then(() => {}, () => {})
    }
  }

  // Claimed only while the item is still unrouted, exactly as the planner does it.
  const { data: claimed } = await admin.from(ITEMS)
    .update({ task_id: taskId, status: 'tasked', updated_at: new Date().toISOString() })
    .eq('id', input.itemId).is('task_id', null).eq('status', 'planned').select('id')
  if (!claimed?.length) {
    // Someone routed the item meanwhile: this task would be a duplicate of theirs.
    await admin.from('tasks').update({ deleted_at: new Date().toISOString() }).eq('id', taskId)
    return null
  }
  return taskId
}

async function priceFlyerTask(taskId: string, clientId: string, serviceId: string | null): Promise<void> {
  try {
    // Loaded on demand: the Tasks actions pull in most of the app, which a webhook should not pay for on every message.
    const { serverFillTaskBilling } = await import('@/app/(dashboard)/dashboard/tasks/actions')
    await serverFillTaskBilling(taskId, clientId, serviceId, 1)
  } catch (err) {
    console.warn('[whatsapp-listener] flyer task left unpriced:', err)
  }
}

/** More pages than this is more likely a misreading than a flyer: left for a person to set. */
export const MAX_AUTO_PAGES = 8

export interface FlyerBilling { changed: boolean; quantity: number | null; amount: number | null; currency: string | null }

/**
 * Bills the flyer by its pages: the task's quantity becomes the page count and the
 * app's own pricing fill works out the amount (client price per page, else the
 * service default). Only while the quantity is still what the listener last set
 * (`from`: 1 when the task was made), so a number someone typed is never
 * overwritten, and never on a task that is already invoiced or paid.
 */
export async function setFlyerTaskPages(admin: SupabaseClient, taskId: string, pages: number, from = 1): Promise<FlyerBilling> {
  const read = async () => {
    const { data } = await admin.from('tasks').select('quantity, status, client_id, service_id, billing_amount, currency, deleted_at').eq('id', taskId).maybeSingle()
    return data as { quantity: number | null; status: string; client_id: string | null; service_id: string | null; billing_amount: number | null; currency: string | null; deleted_at: string | null } | null
  }
  const task = await read()
  const same = (changed: boolean, t = task): FlyerBilling => ({ changed, quantity: t?.quantity ?? null, amount: t?.billing_amount ?? null, currency: t?.currency ?? null })
  if (!task || task.deleted_at || ['cancelled', 'invoiced', 'paid'].includes(task.status)) return same(false)
  if (!Number.isInteger(pages) || pages < 1 || pages > MAX_AUTO_PAGES || pages === from || (task.quantity ?? 1) !== from) return same(false)

  const { error } = await admin.from('tasks').update({ quantity: pages }).eq('id', taskId)
  if (error) return same(false)
  try {
    const { serverFillTaskBilling } = await import('@/app/(dashboard)/dashboard/tasks/actions')
    await serverFillTaskBilling(taskId, task.client_id, task.service_id, pages)
  } catch (err) {
    console.warn('[whatsapp-listener] flyer task quantity set, amount not refreshed:', err)
  }
  return same(true, await read())
}

/** Keeps an open task's date on the flyer's work day when the client gives the offer date later. */
export async function moveFlyerTask(admin: SupabaseClient, taskId: string, workDate: string): Promise<void> {
  await admin.from('tasks').update({ task_date: workDate }).eq('id', taskId).in('status', ['pending', 'in_progress']).is('deleted_at', null)
}

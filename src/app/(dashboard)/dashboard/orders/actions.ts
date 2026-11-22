'use server'

/**
 * Shop order server actions — the write path for /dashboard/orders.
 *
 * House pattern: requirePermission → guard.ok → createAdminClient → mutation →
 * revalidatePath → { ok, error?, data? }. `shop_orders` is server-only, so the
 * browser can change an order through these and nothing else.
 *
 * Totals are always recomputed here from the lines; a total sent by the
 * browser is never trusted.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { revalidatePath } from 'next/cache'
import {
  ORDER_SOURCES, ORDER_STATUSES, cleanExtras, cleanItems, orderTotals,
  type OrderSource, type OrderStatus,
} from '@/lib/orders/orders'

const REVALIDATE = '/dashboard/orders'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

const text = (v: unknown, max: number): string | null => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s ? s.slice(0, max) : null
}
const amount = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0
}
const day = (v: unknown): string | null =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null

export interface OrderInput {
  brandId?: string | null
  customerName: string
  customerPhone?: string | null
  deliverTo?: string | null
  pincode?: string | null
  items: unknown
  extras?: unknown
  deliveryCharge?: number | string | null
  amountPaid?: number | string | null
  neededBy?: string | null
  occasionNote?: string | null
  source?: OrderSource
  notes?: string | null
}

function orderColumns(input: OrderInput) {
  const items = cleanItems(input.items)
  const extras = cleanExtras(input.extras)
  const t = orderTotals(items, extras, input.deliveryCharge)
  return {
    items,
    row: {
      customer_name: text(input.customerName, 120),
      customer_phone: text(input.customerPhone, 30),
      deliver_to: text(input.deliverTo, 400),
      pincode: text(input.pincode, 12),
      items,
      extras,
      items_total: t.itemsTotal,
      extras_total: t.extrasTotal,
      delivery_charge: t.delivery,
      total: t.total,
      needed_by: day(input.neededBy),
      occasion_note: text(input.occasionNote, 500),
      notes: text(input.notes, 2000),
    },
  }
}

export async function createOrder(input: OrderInput): Promise<ActionResult<{ id: string; order_no: string }>> {
  const guard = await requirePermission(PERMS.ORDERS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const { items, row } = orderColumns(input)
  if (!row.customer_name) return { ok: false, error: 'Add the customer’s name.' }
  if (!items.length) return { ok: false, error: 'Add at least one gift.' }
  const paid = amount(input.amountPaid)
  const source: OrderSource =
    input.source && (ORDER_SOURCES as readonly string[]).includes(input.source) ? input.source : 'manual'

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('shop_orders')
    .insert({
      ...row,
      brand_id: input.brandId || null,
      source,
      amount_paid: paid,
      status: paid > 0 ? 'advance_paid' : 'new',
      created_by: guard.employeeId ?? null,
    })
    .select('id, order_no')
    .single()
  if (error || !data) return { ok: false, error: error?.message || 'Could not save the order.' }
  revalidatePath(REVALIDATE)
  return { ok: true, data: { id: data.id as string, order_no: data.order_no as string } }
}

export async function updateOrder(id: string, input: OrderInput): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ORDERS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!id) return { ok: false, error: 'Order not found.' }

  const { items, row } = orderColumns(input)
  if (!row.customer_name) return { ok: false, error: 'Add the customer’s name.' }
  if (!items.length) return { ok: false, error: 'Add at least one gift.' }

  const admin = createAdminClient()
  const { error } = await admin.from('shop_orders').update(row).eq('id', id).is('deleted_at', null)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

export async function setOrderStatus(
  id: string,
  status: OrderStatus,
): Promise<ActionResult<{ shipped_at: string | null; delivered_at: string | null }>> {
  const guard = await requirePermission(PERMS.ORDERS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!(ORDER_STATUSES as readonly string[]).includes(status)) return { ok: false, error: 'Unknown status.' }

  const admin = createAdminClient()
  const { data: cur, error: readErr } = await admin
    .from('shop_orders').select('shipped_at, delivered_at').eq('id', id).is('deleted_at', null).maybeSingle()
  if (readErr || !cur) return { ok: false, error: readErr?.message || 'Order not found.' }

  // The first time it ships / arrives is the date we keep.
  const now = new Date().toISOString()
  const shipped_at = (cur.shipped_at as string | null) ?? (status === 'shipped' || status === 'delivered' ? now : null)
  const delivered_at = (cur.delivered_at as string | null) ?? (status === 'delivered' ? now : null)

  const { error } = await admin.from('shop_orders').update({ status, shipped_at, delivered_at }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true, data: { shipped_at, delivered_at } }
}

/** Add a payment the buyer has made. Moves a brand-new order to "Advance paid". */
export async function addOrderPayment(
  id: string,
  received: number | string,
): Promise<ActionResult<{ amount_paid: number; status: OrderStatus }>> {
  const guard = await requirePermission(PERMS.ORDERS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const add = amount(received)
  if (!add) return { ok: false, error: 'Enter the amount received.' }

  const admin = createAdminClient()
  const { data: cur, error: readErr } = await admin
    .from('shop_orders').select('amount_paid, total, status').eq('id', id).is('deleted_at', null).maybeSingle()
  if (readErr || !cur) return { ok: false, error: readErr?.message || 'Order not found.' }

  const paid = Math.round((Number(cur.amount_paid) + add) * 100) / 100
  if (paid > Number(cur.total)) return { ok: false, error: 'That is more than the order total. Check the amount.' }
  const status = (cur.status === 'new' ? 'advance_paid' : cur.status) as OrderStatus

  const { error } = await admin.from('shop_orders').update({ amount_paid: paid, status }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true, data: { amount_paid: paid, status } }
}

export async function setOrderDispatch(
  id: string,
  input: { courier?: string | null; tracking?: string | null; notes?: string | null },
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ORDERS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin
    .from('shop_orders')
    .update({ courier: text(input.courier, 80), tracking: text(input.tracking, 120), notes: text(input.notes, 2000) })
    .eq('id', id).is('deleted_at', null)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/** Soft delete: the row stays for the books, the screen stops showing it. */
export async function deleteOrder(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ORDERS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('shop_orders').update({ deleted_at: new Date().toISOString() }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/**
 * Shop orders — the pure rules (no I/O), shared by the page, the actions and
 * the tests.
 *
 * A shop order is one retail sale by one of Cirqle's own product brands
 * (Memoura today). The buyer is a member of the public, never a client.
 */

export const ORDER_STATUSES = [
  'new', 'advance_paid', 'preview_sent', 'approved', 'printing', 'shipped', 'delivered', 'cancelled',
] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  new: 'New',
  advance_paid: 'Advance paid',
  preview_sent: 'Preview sent',
  approved: 'Approved',
  printing: 'Printing',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
}

export const ORDER_SOURCES = ['manual', 'website', 'whatsapp', 'instagram', 'other'] as const
export type OrderSource = (typeof ORDER_SOURCES)[number]

/** Still needs something from us. */
export const isOpen = (s: OrderStatus) => s !== 'delivered' && s !== 'cancelled'
/** Design is approved and the gift has not left yet. */
export const isToShip = (s: OrderStatus) => s === 'approved' || s === 'printing'

export interface OrderItem { id?: string | null; name: string; meta?: string | null; qty: number; price: number }
export interface OrderExtra { key: string; name: string; price: number }

export interface ShopOrder {
  id: string
  brand_id: string | null
  order_no: string
  status: OrderStatus
  source: OrderSource
  customer_name: string
  customer_phone: string | null
  deliver_to: string | null
  pincode: string | null
  items: OrderItem[]
  extras: OrderExtra[]
  occasion_note: string | null
  needed_by: string | null
  items_total: number
  extras_total: number
  delivery_charge: number
  total: number
  amount_paid: number
  courier: string | null
  tracking: string | null
  shipped_at: string | null
  delivered_at: string | null
  notes: string | null
  created_at: string
}

/**
 * Memoura's gifts and add-ons, as sold on memoura.cirqle.work (js/data.js in
 * the website project). Keep the two lists in step when a price changes.
 * An order stores the name and price it was sold at, so editing this list
 * never rewrites an old order.
 */
export const MEMOURA_GIFTS: readonly Required<Pick<OrderItem, 'id' | 'name' | 'meta' | 'price'>>[] = [
  { id: 'polaroid', name: 'Mini polaroid pack', meta: '20 pieces', price: 199 },
  { id: 'song', name: 'Song frame', meta: 'A5', price: 249 },
  { id: 'strip', name: 'Photo strip frame', meta: '4 photos', price: 299 },
  { id: 'magazine', name: 'Memory magazine', meta: '12 pages', price: 449 },
  { id: 'collage', name: 'Collage frame', meta: 'A4', price: 549 },
  { id: 'standee', name: 'Standee cut-out', meta: '8 inch', price: 699 },
  { id: 'lamp', name: 'Photo lamp frame', meta: 'warm light', price: 799 },
  { id: 'hamper', name: 'Mini surprise hamper', meta: 'box set', price: 1499 },
  { id: 'grand', name: 'Grand memory box', meta: 'box set', price: 2999 },
  { id: 'abroad', name: 'Gift from abroad box', meta: 'doorstep surprise', price: 3499 },
]
export const MEMOURA_EXTRAS: readonly OrderExtra[] = [
  { key: 'wrap', name: 'Gift wrap', price: 49 },
  { key: 'note', name: 'Handwritten note', price: 29 },
  { key: 'express', name: 'Express delivery', price: 99 },
]

const money = (n: unknown): number => {
  const v = typeof n === 'number' ? n : Number(n)
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : 0
}

/** Whatever arrived (form, JSON column) → clean lines. Drops empty and zero-quantity lines. */
export function cleanItems(raw: unknown): OrderItem[] {
  if (!Array.isArray(raw)) return []
  const out: OrderItem[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, 120) : ''
    const qty = Math.floor(Number(o.qty))
    if (!name || !Number.isFinite(qty) || qty < 1) continue
    out.push({
      id: typeof o.id === 'string' ? o.id.slice(0, 40) : null,
      name,
      meta: typeof o.meta === 'string' && o.meta.trim() ? o.meta.trim().slice(0, 80) : null,
      qty: Math.min(qty, 999),
      price: money(o.price),
    })
  }
  return out.slice(0, 40)
}

export function cleanExtras(raw: unknown): OrderExtra[] {
  if (!Array.isArray(raw)) return []
  const out: OrderExtra[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, 80) : ''
    if (!name) continue
    out.push({ key: typeof o.key === 'string' && o.key ? o.key.slice(0, 40) : name.toLowerCase(), name, price: money(o.price) })
  }
  return out.slice(0, 20)
}

export function orderTotals(items: OrderItem[], extras: OrderExtra[], deliveryCharge: unknown) {
  const itemsTotal = money(items.reduce((s, i) => s + i.price * i.qty, 0))
  const extrasTotal = money(extras.reduce((s, e) => s + e.price, 0))
  const delivery = money(deliveryCharge)
  return { itemsTotal, extrasTotal, delivery, total: money(itemsTotal + extrasTotal + delivery) }
}

/** What the buyer still owes. Never negative; a cancelled order owes nothing. */
export function balanceDue(o: Pick<ShopOrder, 'total' | 'amount_paid' | 'status'>): number {
  if (o.status === 'cancelled') return 0
  return Math.max(0, money(Number(o.total) - Number(o.amount_paid)))
}

/** Whole days from `today` to the needed-by date (negative = already late). null when there is no date. */
export function daysLeft(neededBy: string | null | undefined, today: Date = new Date()): number | null {
  if (!neededBy || !/^\d{4}-\d{2}-\d{2}/.test(neededBy)) return null
  const [y, m, d] = neededBy.slice(0, 10).split('-').map(Number)
  const a = Date.UTC(y, m - 1, d)
  const b = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((a - b) / 86_400_000)
}

export const rupees = (n: number | string | null | undefined) =>
  '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })

export function itemsSummary(items: OrderItem[]): string {
  return items.map(i => (i.qty > 1 ? `${i.name} × ${i.qty}` : i.name)).join(', ')
}

/** Digits for wa.me. A bare 10-digit Indian mobile gets 91; anything else is kept as typed. */
export function whatsappDigits(phone: string | null | undefined): string | null {
  const d = (phone ?? '').replace(/\D/g, '')
  if (d.length === 10) return '91' + d
  if (d.length >= 11 && d.length <= 15) return d.replace(/^0+/, '')
  return null
}

export function whatsappLink(phone: string | null | undefined, text: string): string | null {
  const d = whatsappDigits(phone)
  return d ? `https://wa.me/${d}?text=${encodeURIComponent(text)}` : null
}

export type MessageKind = 'confirm' | 'preview' | 'shipped' | 'review'
export const MESSAGE_LABEL: Record<MessageKind, string> = {
  confirm: 'Order confirmed',
  preview: 'Preview ready',
  shipped: 'Shipped',
  review: 'Ask for a review',
}

/** The message we send the buyer at each step, in the Memoura voice. Staff send it themselves. */
export function customerMessage(o: ShopOrder, kind: MessageKind): string {
  const name = o.customer_name.trim().split(/\s+/)[0] || 'there'
  const due = balanceDue(o)
  switch (kind) {
    case 'confirm':
      return [
        `Hi ${name}! Your Memoura order ${o.order_no} is confirmed.`,
        itemsSummary(o.items),
        `Total ${rupees(o.total)}. Paid ${rupees(o.amount_paid)}.${due ? ` Balance ${rupees(due)}.` : ''}`,
        'Please send your photos here. We will share the design preview within 2 hours.',
      ].filter(Boolean).join('\n')
    case 'preview':
      return `Hi ${name}! Here is the design preview for your order ${o.order_no}. One change is free. Reply OK to approve and we will start printing.`
    case 'shipped':
      return [
        `Hi ${name}! Your Memoura order ${o.order_no} is on its way.`,
        o.courier || o.tracking ? `Courier: ${[o.courier, o.tracking].filter(Boolean).join(', ')}` : null,
        'Please send us a photo when it arrives. We would love to see it.',
      ].filter(Boolean).join('\n')
    case 'review':
      return `Hi ${name}! Hope they loved the gift. Could you share a photo or a short review? It helps our small brand a lot. You can tag @memoura.gifts on Instagram.`
  }
}

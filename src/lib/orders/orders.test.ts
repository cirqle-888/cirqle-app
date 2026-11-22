import { describe, it, expect } from 'vitest'
import {
  cleanItems, cleanExtras, orderTotals, balanceDue, daysLeft, whatsappDigits, whatsappLink,
  customerMessage, itemsSummary, isOpen, isToShip, type ShopOrder,
} from './orders'

const order = (over: Partial<ShopOrder> = {}): ShopOrder => ({
  id: 'o1', brand_id: 'b1', order_no: 'MEM-0007', status: 'new', source: 'manual',
  customer_name: 'Anu Thomas', customer_phone: '98470 12345', deliver_to: 'Kochi', pincode: '682001',
  items: [{ id: 'magazine', name: 'Memory magazine', meta: '12 pages', qty: 2, price: 449 }],
  extras: [{ key: 'wrap', name: 'Gift wrap', price: 49 }],
  occasion_note: null, needed_by: null,
  items_total: 898, extras_total: 49, delivery_charge: 0, total: 947, amount_paid: 400,
  courier: null, tracking: null, shipped_at: null, delivered_at: null, notes: null,
  created_at: '2026-11-22T00:00:00Z', ...over,
})

describe('shop orders: lines and money', () => {
  it('drops empty, zero-quantity and junk lines', () => {
    expect(cleanItems([{ name: ' Song frame ', qty: 1, price: 249 }, { name: '', qty: 2, price: 5 }, { name: 'X', qty: 0, price: 5 }, null, 'x']))
      .toEqual([{ id: null, name: 'Song frame', meta: null, qty: 1, price: 249 }])
    expect(cleanItems('nope')).toEqual([])
  })
  it('never lets a negative price reduce a total', () => {
    expect(cleanItems([{ name: 'A', qty: 1, price: -50 }])[0].price).toBe(0)
    expect(cleanExtras([{ name: 'Gift wrap', price: -1 }])[0].price).toBe(0)
  })
  it('adds items, extras and delivery', () => {
    const t = orderTotals(cleanItems([{ name: 'A', qty: 2, price: 449 }]), cleanExtras([{ key: 'wrap', name: 'Gift wrap', price: 49 }]), 60)
    expect(t).toEqual({ itemsTotal: 898, extrasTotal: 49, delivery: 60, total: 1007 })
  })
  it('balance is never negative and a cancelled order owes nothing', () => {
    expect(balanceDue(order())).toBe(547)
    expect(balanceDue(order({ amount_paid: 5000 }))).toBe(0)
    expect(balanceDue(order({ status: 'cancelled' }))).toBe(0)
  })
})

describe('shop orders: dates and status', () => {
  it('counts whole days to the needed-by date', () => {
    const today = new Date(2026, 10, 22)
    expect(daysLeft('2026-11-25', today)).toBe(3)
    expect(daysLeft('2026-11-20', today)).toBe(-2)
    expect(daysLeft(null, today)).toBeNull()
    expect(daysLeft('soon', today)).toBeNull()
  })
  it('knows what is open and what is waiting to ship', () => {
    expect(isOpen('printing')).toBe(true)
    expect(isOpen('delivered')).toBe(false)
    expect(isOpen('cancelled')).toBe(false)
    expect(isToShip('approved')).toBe(true)
    expect(isToShip('shipped')).toBe(false)
  })
})

describe('shop orders: WhatsApp', () => {
  it('adds 91 to a bare Indian mobile and keeps a full number', () => {
    expect(whatsappDigits('98470 12345')).toBe('919847012345')
    expect(whatsappDigits('+971 50 123 4567')).toBe('971501234567')
    expect(whatsappDigits('12345')).toBeNull()
    expect(whatsappLink(null, 'hi')).toBeNull()
    expect(whatsappLink('9847012345', 'a b')).toBe('https://wa.me/919847012345?text=a%20b')
  })
  it('writes the confirmation with the order number, total and balance', () => {
    const m = customerMessage(order(), 'confirm')
    expect(m).toContain('Hi Anu!')
    expect(m).toContain('MEM-0007')
    expect(m).toContain('Memory magazine × 2')
    expect(m).toContain('Balance ₹547')
  })
  it('leaves the balance out once it is fully paid, and names the courier when shipped', () => {
    expect(customerMessage(order({ amount_paid: 947 }), 'confirm')).not.toContain('Balance')
    expect(customerMessage(order({ courier: 'DTDC', tracking: 'D123' }), 'shipped')).toContain('Courier: DTDC, D123')
    expect(itemsSummary(order().items)).toBe('Memory magazine × 2')
  })
})

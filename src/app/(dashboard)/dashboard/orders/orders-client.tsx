'use client'

/**
 * Orders — the interactive client. Reads arrive as plain props from the server
 * page; every write goes through actions.ts. Nothing here talks to Supabase:
 * shop_orders holds buyers' personal data and is server-only.
 */

import { useMemo, useState, useTransition } from 'react'
import Header from '@/components/layout/header'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import AppSelect from '@/components/ui/app-select'
import { EmptyState } from '@/components/ui/empty-state'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ToastContainer, useToast } from '@/components/ui/toast'
import { ShoppingBag, Search, Plus, Minus, X, Phone, MessageCircle, Copy, Trash2, Loader2, Truck } from 'lucide-react'
import {
  ORDER_STATUSES, ORDER_STATUS_LABEL, ORDER_SOURCES, MEMOURA_GIFTS, MEMOURA_EXTRAS, MESSAGE_LABEL,
  balanceDue, customerMessage, daysLeft, isOpen, isToShip, itemsSummary, orderTotals, rupees, whatsappLink,
  type MessageKind, type OrderExtra, type OrderItem, type OrderSource, type OrderStatus, type ShopOrder,
} from '@/lib/orders/orders'
import { addOrderPayment, createOrder, deleteOrder, setOrderDispatch, setOrderStatus, type OrderInput } from './actions'

const STATUS_STYLE: Record<OrderStatus, string> = {
  new: 'bg-violet-500/15 text-violet-400',
  advance_paid: 'bg-yellow-500/15 text-yellow-500',
  preview_sent: 'bg-fuchsia-500/15 text-fuchsia-400',
  approved: 'bg-blue-500/15 text-blue-400',
  printing: 'bg-orange-500/15 text-orange-400',
  shipped: 'bg-teal-500/15 text-teal-400',
  delivered: 'bg-green-500/15 text-green-500',
  cancelled: 'bg-red-500/15 text-red-400',
}
const SOURCE_LABEL: Record<OrderSource, string> = {
  manual: 'Typed in', website: 'Website', whatsapp: 'WhatsApp', instagram: 'Instagram', other: 'Other',
}
const INPUT = 'w-full h-9 px-3 rounded-lg bg-secondary text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary'

function dueLabel(neededBy: string | null): { text: string; tone: string } | null {
  const d = daysLeft(neededBy)
  if (d === null) return null
  if (d < 0) return { text: `${-d} day${d === -1 ? '' : 's'} late`, tone: 'text-red-400' }
  if (d === 0) return { text: 'Needed today', tone: 'text-red-400' }
  if (d <= 3) return { text: `In ${d} day${d === 1 ? '' : 's'}`, tone: 'text-orange-400' }
  return { text: new Date(neededBy + 'T00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), tone: 'text-muted-foreground' }
}

export default function OrdersClient({
  orders: initialOrders, canManage, notSetUp, brand,
}: {
  orders: ShopOrder[]
  canManage: boolean
  notSetUp: boolean
  brand: { id: string; name: string } | null
}) {
  const toast = useToast()
  const [, startTransition] = useTransition()
  const [orders, setOrders] = useState<ShopOrder[]>(initialOrders)
  const [view, setView] = useState<'open' | 'all' | OrderStatus>('open')
  const [q, setQ] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ShopOrder | null>(null)

  const selected = orders.find(o => o.id === selectedId) ?? null

  const kpi = useMemo(() => {
    const open = orders.filter(o => isOpen(o.status))
    return {
      open: open.length,
      toShip: open.filter(o => isToShip(o.status)).length,
      dueSoon: open.filter(o => { const d = daysLeft(o.needed_by); return d !== null && d <= 3 && o.status !== 'shipped' }).length,
      balance: orders.reduce((s, o) => s + balanceDue(o), 0),
    }
  }, [orders])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return orders.filter(o => {
      if (view === 'open' ? !isOpen(o.status) : view !== 'all' && o.status !== view) return false
      if (!needle) return true
      return `${o.order_no} ${o.customer_name} ${o.customer_phone ?? ''} ${o.deliver_to ?? ''} ${itemsSummary(o.items)}`.toLowerCase().includes(needle)
    })
  }, [orders, view, q])

  const patch = (id: string, p: Partial<ShopOrder>) => setOrders(prev => prev.map(o => (o.id === id ? { ...o, ...p } : o)))

  function onStatus(o: ShopOrder, next: OrderStatus) {
    patch(o.id, { status: next })
    startTransition(async () => {
      const res = await setOrderStatus(o.id, next)
      if (!res.ok) { toast.error('Could not change the status', res.error); patch(o.id, { status: o.status }) }
      else if (res.data) patch(o.id, res.data)
    })
  }

  async function onCreate(input: OrderInput): Promise<boolean> {
    const res = await createOrder({ ...input, brandId: brand?.id ?? null })
    if (!res.ok) { toast.error('Could not save the order', res.error); return false }
    toast.success(`Order ${res.data?.order_no ?? ''} saved`)
    setShowAdd(false)
    // The server page re-reads on revalidate; reload so the new row carries its real columns.
    window.location.reload()
    return true
  }

  return (
    <>
      <Header
        title="Orders"
        subtitle={brand ? `${brand.name} shop orders` : 'Shop orders'}
        actions={canManage && !notSetUp ? (
          <Button size="sm" onClick={() => setShowAdd(true)}><Plus className="w-4 h-4 mr-1.5" /> Add order</Button>
        ) : undefined}
      />

      <div className="px-4 sm:px-6 pb-16 max-w-[1400px] mx-auto w-full">
        {notSetUp ? (
          <Card><CardContent className="p-0">
            <EmptyState icon={ShoppingBag} title="Orders are not switched on yet" body="The orders table has not been created in the database. Ask the admin to run the shop orders migration." />
          </CardContent></Card>
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mb-4">
              <Kpi label="Open orders" value={kpi.open} />
              <Kpi label="Ready to make or ship" value={kpi.toShip} />
              <Kpi label="Needed within 3 days" value={kpi.dueSoon} warn={kpi.dueSoon > 0} />
              <Kpi label="Balance to collect" value={rupees(kpi.balance)} />
            </div>

            <div className="flex flex-wrap items-center gap-2 mb-3">
              <div className="relative flex-1 min-w-[180px]">
                <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search order no, name, phone, gift…" className={`${INPUT} pl-8`} />
              </div>
              <AppSelect value={view} onChange={e => setView(e.target.value as typeof view)} wrapperClassName="w-auto">
                <option value="open">Open orders</option>
                <option value="all">All orders</option>
                {ORDER_STATUSES.map(s => <option key={s} value={s}>{ORDER_STATUS_LABEL[s]}</option>)}
              </AppSelect>
            </div>

            {filtered.length === 0 ? (
              <Card><CardContent className="p-0">
                <EmptyState
                  icon={ShoppingBag}
                  title={orders.length ? 'No orders match' : 'No orders yet'}
                  body={orders.length ? 'Try another status or clear the search.' : 'When a customer confirms on WhatsApp, add the order here to track payment, printing and delivery.'}
                  action={canManage && !orders.length ? { label: 'Add order', onClick: () => setShowAdd(true) } : undefined}
                />
              </CardContent></Card>
            ) : (
              <Card><CardContent className="p-0 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground border-b border-border">
                      <th className="font-medium px-3 py-2.5">Order</th>
                      <th className="font-medium px-3 py-2.5 hidden md:table-cell">Gifts</th>
                      <th className="font-medium px-3 py-2.5 text-right">Total</th>
                      <th className="font-medium px-3 py-2.5 text-right hidden sm:table-cell">Balance</th>
                      <th className="font-medium px-3 py-2.5 hidden sm:table-cell">Needed</th>
                      <th className="font-medium px-3 py-2.5">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(o => {
                      const due = dueLabel(o.needed_by)
                      const bal = balanceDue(o)
                      return (
                        <tr key={o.id} onClick={() => setSelectedId(o.id)} className="border-b border-border/60 last:border-0 hover:bg-secondary/50 cursor-pointer">
                          <td className="px-3 py-2.5">
                            <div className="font-medium text-foreground">{o.customer_name}</div>
                            <div className="text-xs text-muted-foreground mt-0.5 tabular-nums">{o.order_no}{o.customer_phone ? `  ${o.customer_phone}` : ''}</div>
                          </td>
                          <td className="px-3 py-2.5 hidden md:table-cell text-muted-foreground max-w-[280px] truncate">{itemsSummary(o.items)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{rupees(o.total)}</td>
                          <td className={`px-3 py-2.5 text-right tabular-nums hidden sm:table-cell ${bal ? 'text-orange-400' : 'text-muted-foreground'}`}>{bal ? rupees(bal) : 'Paid'}</td>
                          <td className={`px-3 py-2.5 hidden sm:table-cell text-xs ${isOpen(o.status) && due ? due.tone : 'text-muted-foreground'}`}>{due?.text ?? '—'}</td>
                          <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                            {canManage ? (
                              <select value={o.status} onChange={e => onStatus(o, e.target.value as OrderStatus)} aria-label={`Status of ${o.order_no}`}
                                className={`text-xs font-medium rounded-md px-2 py-1 border-0 cursor-pointer ${STATUS_STYLE[o.status]}`}>
                                {ORDER_STATUSES.map(s => <option key={s} value={s}>{ORDER_STATUS_LABEL[s]}</option>)}
                              </select>
                            ) : <span className={`inline-flex px-2 py-0.5 rounded-md text-xs font-medium ${STATUS_STYLE[o.status]}`}>{ORDER_STATUS_LABEL[o.status]}</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </CardContent></Card>
            )}
          </>
        )}
      </div>

      {selected && (
        <OrderModal
          order={selected}
          canManage={canManage}
          onClose={() => setSelectedId(null)}
          onStatus={s => onStatus(selected, s)}
          onPaid={async amt => {
            const res = await addOrderPayment(selected.id, amt)
            if (!res.ok) { toast.error('Could not record the payment', res.error); return false }
            if (res.data) patch(selected.id, res.data)
            toast.success('Payment recorded')
            return true
          }}
          onDispatch={async d => {
            const res = await setOrderDispatch(selected.id, d)
            if (!res.ok) { toast.error('Could not save', res.error); return }
            patch(selected.id, { courier: d.courier || null, tracking: d.tracking || null, notes: d.notes || null })
            toast.success('Saved')
          }}
          onCopied={() => toast.success('Message copied')}
          onDelete={() => setDeleteTarget(selected)}
        />
      )}

      {showAdd && <AddOrderModal onClose={() => setShowAdd(false)} onCreate={onCreate} />}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete this order?"
          body={`${deleteTarget.order_no} for ${deleteTarget.customer_name} will leave the list. Use "Cancelled" instead if the customer changed their mind.`}
          confirmLabel="Delete order"
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const t = deleteTarget
            setDeleteTarget(null); setSelectedId(null)
            setOrders(prev => prev.filter(o => o.id !== t.id))
            startTransition(async () => {
              const res = await deleteOrder(t.id)
              if (!res.ok) { toast.error('Could not delete', res.error); setOrders(prev => [t, ...prev]) }
            })
          }}
        />
      )}

      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
    </>
  )
}

function Kpi({ label, value, warn }: { label: string; value: number | string; warn?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-xl font-semibold mt-0.5 tabular-nums ${warn ? 'text-orange-400' : 'text-foreground'}`}>{value}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="text-xs text-muted-foreground">{label}</span><div className="mt-1">{children}</div></label>
}

function OrderModal({
  order, canManage, onClose, onStatus, onPaid, onDispatch, onCopied, onDelete,
}: {
  order: ShopOrder
  canManage: boolean
  onClose: () => void
  onStatus: (s: OrderStatus) => void
  onPaid: (amount: number) => Promise<boolean>
  onDispatch: (d: { courier: string; tracking: string; notes: string }) => Promise<void>
  onCopied: () => void
  onDelete: () => void
}) {
  const [pay, setPay] = useState('')
  const [saving, setSaving] = useState(false)
  const [courier, setCourier] = useState(order.courier ?? '')
  const [tracking, setTracking] = useState(order.tracking ?? '')
  const [notes, setNotes] = useState(order.notes ?? '')
  const bal = balanceDue(order)
  const due = dueLabel(order.needed_by)
  const dirty = courier !== (order.courier ?? '') || tracking !== (order.tracking ?? '') || notes !== (order.notes ?? '')
  // The message that fits where the order is now comes first.
  const kinds: MessageKind[] =
    order.status === 'shipped' ? ['shipped', 'review'] :
    order.status === 'delivered' ? ['review'] :
    order.status === 'preview_sent' ? ['preview', 'confirm'] : ['confirm', 'preview', 'shipped']
  const current = { ...order, courier: courier || null, tracking: tracking || null }

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="bg-card w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between p-4 border-b border-border sticky top-0 bg-card z-10">
          <div>
            <h2 className="text-base font-semibold">{order.customer_name}</h2>
            <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">{order.order_no}  {SOURCE_LABEL[order.source]}{due ? `  ${due.text}` : ''}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-4 space-y-4">
          <div className="flex flex-wrap gap-3 text-sm">
            {order.customer_phone && <a href={`tel:${order.customer_phone}`} className="inline-flex items-center gap-1.5 text-primary"><Phone className="w-4 h-4" />{order.customer_phone}</a>}
            {(order.deliver_to || order.pincode) && <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Truck className="w-4 h-4" />{[order.deliver_to, order.pincode].filter(Boolean).join(', ')}</span>}
          </div>

          <div className="rounded-lg border border-border divide-y divide-border text-sm">
            {order.items.map((i, k) => (
              <div key={k} className="flex justify-between gap-3 px-3 py-1.5">
                <span>{i.name}{i.meta ? <span className="text-muted-foreground"> ({i.meta})</span> : null}{i.qty > 1 ? ` × ${i.qty}` : ''}</span>
                <span className="tabular-nums">{rupees(i.price * i.qty)}</span>
              </div>
            ))}
            {order.extras.map(extra => (
              <div key={extra.key} className="flex justify-between gap-3 px-3 py-1.5 text-muted-foreground"><span>{extra.name}</span><span className="tabular-nums">{rupees(extra.price)}</span></div>
            ))}
            {order.delivery_charge > 0 && <div className="flex justify-between gap-3 px-3 py-1.5 text-muted-foreground"><span>Delivery</span><span className="tabular-nums">{rupees(order.delivery_charge)}</span></div>}
            <div className="flex justify-between gap-3 px-3 py-2 font-semibold"><span>Total</span><span className="tabular-nums">{rupees(order.total)}</span></div>
            <div className="flex justify-between gap-3 px-3 py-1.5"><span>Paid</span><span className="tabular-nums">{rupees(order.amount_paid)}</span></div>
            <div className={`flex justify-between gap-3 px-3 py-1.5 ${bal ? 'text-orange-400' : 'text-green-500'}`}><span>{bal ? 'Balance to collect' : 'Fully paid'}</span><span className="tabular-nums">{bal ? rupees(bal) : ''}</span></div>
          </div>

          {order.occasion_note && <p className="text-sm rounded-lg bg-secondary/50 p-3">{order.occasion_note}</p>}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Status">
              {canManage ? (
                <AppSelect value={order.status} onChange={e => onStatus(e.target.value as OrderStatus)}>
                  {ORDER_STATUSES.map(s => <option key={s} value={s}>{ORDER_STATUS_LABEL[s]}</option>)}
                </AppSelect>
              ) : <span className={`inline-flex px-2 py-0.5 rounded-md text-xs font-medium ${STATUS_STYLE[order.status]}`}>{ORDER_STATUS_LABEL[order.status]}</span>}
            </Field>
            {canManage && bal > 0 && (
              <Field label="Payment received">
                <div className="flex gap-2">
                  <input value={pay} onChange={e => setPay(e.target.value)} inputMode="decimal" placeholder={String(bal)} className={INPUT} />
                  <Button size="sm" disabled={!Number(pay) || saving} onClick={async () => { setSaving(true); if (await onPaid(Number(pay))) setPay(''); setSaving(false) }}>
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Add'}
                  </Button>
                </div>
              </Field>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Courier"><input value={courier} onChange={e => setCourier(e.target.value)} disabled={!canManage} placeholder="DTDC, India Post…" className={INPUT} /></Field>
            <Field label="Tracking number"><input value={tracking} onChange={e => setTracking(e.target.value)} disabled={!canManage} className={INPUT} /></Field>
          </div>
          <Field label="Notes (only the team sees these)">
            <textarea value={notes} onChange={e => setNotes(e.target.value)} disabled={!canManage} rows={2} className="w-full rounded-lg bg-secondary text-sm border border-border p-2.5 focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60" />
          </Field>
          {canManage && dirty && <Button size="sm" variant="secondary" onClick={() => onDispatch({ courier, tracking, notes })}>Save courier and notes</Button>}

          <div>
            <div className="text-xs font-medium text-muted-foreground mb-1.5">Message the customer</div>
            <div className="space-y-2">
              {kinds.map(k => {
                const msg = customerMessage(current, k)
                const link = whatsappLink(order.customer_phone, msg)
                return (
                  <div key={k} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                    <span className="text-sm">{MESSAGE_LABEL[k]}</span>
                    <span className="flex gap-1.5">
                      <Button size="sm" variant="ghost" onClick={async () => { try { await navigator.clipboard.writeText(msg); onCopied() } catch { /* clipboard blocked: the WhatsApp button still works */ } }}>
                        <Copy className="w-4 h-4 mr-1" /> Copy
                      </Button>
                      {link && <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center h-8 px-3 rounded-md text-sm font-medium bg-green-600 text-white hover:bg-green-500"><MessageCircle className="w-4 h-4 mr-1" /> WhatsApp</a>}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>

          {canManage && (
            <div className="pt-2 border-t border-border">
              <Button size="sm" variant="ghost" className="text-red-400 hover:text-red-300" onClick={onDelete}><Trash2 className="w-4 h-4 mr-1.5" /> Delete order</Button>
            </div>
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}

function AddOrderModal({ onClose, onCreate }: { onClose: () => void; onCreate: (input: OrderInput) => Promise<boolean> }) {
  const [qty, setQty] = useState<Record<string, number>>({})
  const [extraKeys, setExtraKeys] = useState<Set<string>>(new Set())
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [deliverTo, setDeliverTo] = useState('')
  const [pincode, setPincode] = useState('')
  const [neededBy, setNeededBy] = useState('')
  const [occasion, setOccasion] = useState('')
  const [delivery, setDelivery] = useState('')
  const [paid, setPaid] = useState('')
  const [source, setSource] = useState<OrderSource>('whatsapp')
  const [saving, setSaving] = useState(false)

  const items: OrderItem[] = MEMOURA_GIFTS.filter(g => (qty[g.id] ?? 0) > 0).map(g => ({ ...g, qty: qty[g.id] }))
  const extras: OrderExtra[] = MEMOURA_EXTRAS.filter(e => extraKeys.has(e.key))
  const t = orderTotals(items, extras, delivery)
  const bump = (id: string, d: number) => setQty(p => ({ ...p, [id]: Math.max(0, (p[id] ?? 0) + d) }))

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="bg-card w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-card z-10">
          <h2 className="text-base font-semibold">Add order</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4 space-y-4">
          <div>
            <div className="text-xs text-muted-foreground mb-1.5">Gifts</div>
            <div className="rounded-lg border border-border divide-y divide-border">
              {MEMOURA_GIFTS.map(g => (
                <div key={g.id} className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm">
                  <span>{g.name} <span className="text-muted-foreground tabular-nums">{rupees(g.price)}</span></span>
                  <span className="flex items-center gap-2">
                    <button type="button" aria-label={`One less ${g.name}`} onClick={() => bump(g.id, -1)} disabled={!qty[g.id]} className="w-7 h-7 grid place-items-center rounded-full bg-secondary disabled:opacity-40"><Minus className="w-3.5 h-3.5" /></button>
                    <span className="w-5 text-center tabular-nums">{qty[g.id] ?? 0}</span>
                    <button type="button" aria-label={`One more ${g.name}`} onClick={() => bump(g.id, 1)} className="w-7 h-7 grid place-items-center rounded-full bg-secondary"><Plus className="w-3.5 h-3.5" /></button>
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
            {MEMOURA_EXTRAS.map(extra => (
              <label key={extra.key} className="inline-flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={extraKeys.has(extra.key)} onChange={ev => setExtraKeys(p => { const n = new Set(p); if (ev.target.checked) n.add(extra.key); else n.delete(extra.key); return n })} />
                {extra.name} <span className="text-muted-foreground tabular-nums">{rupees(extra.price)}</span>
              </label>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Customer name *"><input value={name} onChange={e => setName(e.target.value)} className={INPUT} /></Field>
            <Field label="Phone / WhatsApp"><input value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" placeholder="+91…" className={INPUT} /></Field>
          </div>
          <Field label="Deliver to"><input value={deliverTo} onChange={e => setDeliverTo(e.target.value)} placeholder="House, street, city" className={INPUT} /></Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Pincode"><input value={pincode} onChange={e => setPincode(e.target.value)} inputMode="numeric" className={INPUT} /></Field>
            <Field label="Needed by"><input type="date" value={neededBy} onChange={e => setNeededBy(e.target.value)} className={INPUT} /></Field>
            <Field label="Came from">
              <AppSelect value={source} onChange={e => setSource(e.target.value as OrderSource)}>
                {ORDER_SOURCES.map(s => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
              </AppSelect>
            </Field>
          </div>
          <Field label="Occasion or message on the gift"><input value={occasion} onChange={e => setOccasion(e.target.value)} className={INPUT} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Delivery charge"><input value={delivery} onChange={e => setDelivery(e.target.value)} inputMode="decimal" placeholder="0" className={INPUT} /></Field>
            <Field label="Advance received"><input value={paid} onChange={e => setPaid(e.target.value)} inputMode="decimal" placeholder="0" className={INPUT} /></Field>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 p-4 border-t border-border sticky bottom-0 bg-card">
          <span className="text-sm">Total <b className="tabular-nums">{rupees(t.total)}</b></span>
          <span className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" disabled={!name.trim() || !items.length || saving || Number(paid) > t.total}
              onClick={async () => {
                setSaving(true)
                await onCreate({ customerName: name, customerPhone: phone, deliverTo, pincode, items, extras, deliveryCharge: delivery, amountPaid: paid, neededBy: neededBy || null, occasionNote: occasion, source })
                setSaving(false)
              }}>
              {saving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />} Save order
            </Button>
          </span>
        </div>
      </div>
    </ModalOverlay>
  )
}

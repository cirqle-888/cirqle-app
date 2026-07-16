'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/layout/header'
import Combobox from '@/components/ui/combobox'
import AppSelect from '@/components/ui/app-select'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { refLabel } from '@/lib/requests/core'
import {
  CONTENT_TYPES, CONTENT_TYPE_LABEL, CONTENT_TYPE_CHIP,
  PLATFORMS, PLATFORM_LABEL, platformLabels,
  PROGRESS_LABEL, PROGRESS_CHIP, resolveItemProgress, isClosedRequestStatus,
  type ItemProgress,
} from '@/lib/social/plan'
import {
  createSocialCalendar, updateSocialCalendar, deleteSocialCalendar,
  addCalendarItem, updateCalendarItem, deleteCalendarItem, pushItemsToRequests,
  revertItemToPlanned,
  type ItemInput,
} from './actions'
import {
  CalendarDays, Loader2, Plus, Send, Trash2, Archive, ExternalLink, RotateCcw, X,
} from 'lucide-react'

// ─── Types (mirror the page's selects) ────────────────────────────────────────

interface CalendarRow {
  id: string
  client_id: string
  month: string                 // YYYY-MM-01
  title: string | null
  status: 'draft' | 'active' | 'archived'
  notes: string | null
  client?: { id: string; name: string; code: string } | null
  items?: { id: string; status: string; request_id: string | null }[]
}

interface ItemRow {
  id: string
  calendar_id: string
  scheduled_date: string
  title: string
  content_type: string
  platforms: string[] | null
  caption: string | null
  notes: string | null
  status: string
  request_id: string | null
  request?: {
    id: string
    ref_no: number | null
    status: string
    promoted_task_id: string | null
    promoted_task?: { id: string; task_number: number | null; status: string } | null
  } | null
}

interface Props {
  migrated: boolean
  calendars: CalendarRow[]
  selectedId: string | null
  initialItems: ItemRow[]
  clients: { id: string; name: string; code: string }[]
  canManage: boolean
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const monthLabel = (month: string) => {
  const [y, m] = month.split('-').map(Number)
  return `${MONTH_NAMES[m - 1]} ${y}`
}

const EMPTY_ITEM: ItemInput = {
  scheduledDate: '', title: '', contentType: 'post', platforms: [], caption: '', notes: '',
}

export default function SocialCalendarClient({
  migrated, calendars, selectedId, initialItems, clients, canManage,
}: Props) {
  const router = useRouter()
  const toast = useToast()

  const selected = calendars.find(c => c.id === selectedId) ?? null
  const items = initialItems

  // ── New-plan modal ──────────────────────────────────────────────────────────
  const [showNewPlan, setShowNewPlan] = useState(false)
  const [planForm, setPlanForm] = useState({
    clientId: '', month: new Date().toISOString().slice(0, 7), title: '', notes: '',
  })
  const [savingPlan, setSavingPlan] = useState(false)

  // ── Item modal (add or edit) ────────────────────────────────────────────────
  const [itemModal, setItemModal] = useState<{ mode: 'add' | 'edit'; itemId?: string } | null>(null)
  const [itemForm, setItemForm] = useState<ItemInput>(EMPTY_ITEM)
  const [savingItem, setSavingItem] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)   // 'push-all' | 'push:<id>' | 'delete:<id>' | 'archive'

  const editingItem = itemModal?.mode === 'edit'
    ? items.find(i => i.id === itemModal.itemId) ?? null
    : null
  const editingProgress: ItemProgress | null = editingItem
    ? resolveItemProgress(editingItem.status, editingItem.request)
    : null
  const editingFrozen = !!editingItem?.request?.promoted_task_id
  const requestIsClosed = isClosedRequestStatus(editingItem?.request?.status)

  // ── Derived: month grid + per-day items + progress counts ──────────────────
  const grid = useMemo(() => {
    if (!selected) return []
    const [y, m] = selected.month.split('-').map(Number)
    const first = new Date(y, m - 1, 1)
    const start = new Date(y, m - 1, 1 - first.getDay())
    const cells: { date: Date; key: string; inMonth: boolean }[] = []
    for (let i = 0; i < 42; i++) {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      cells.push({ date: d, key: ymd(d), inMonth: d.getMonth() === m - 1 })
    }
    return cells
  }, [selected])

  const itemsByDate = useMemo(() => {
    const map = new Map<string, ItemRow[]>()
    for (const it of items) {
      const day = map.get(it.scheduled_date)
      if (day) day.push(it)
      else map.set(it.scheduled_date, [it])
    }
    return map
  }, [items])

  const progressCounts = useMemo(() => {
    const counts: Record<ItemProgress, number> = {
      planned: 0, requested: 0, in_progress: 0, delivered: 0, done: 0, cancelled: 0,
    }
    for (const it of items) counts[resolveItemProgress(it.status, it.request)]++
    return counts
  }, [items])

  const unpushed = items.filter(i => i.status === 'planned' && !i.request_id)

  // ── Actions ────────────────────────────────────────────────────────────────

  async function submitNewPlan() {
    setSavingPlan(true)
    const res = await createSocialCalendar({
      clientId: planForm.clientId, month: planForm.month,
      title: planForm.title || null, notes: planForm.notes || null,
    })
    setSavingPlan(false)
    if (!res.ok || !res.data) { toast.toastError('Could not create the plan', res.error); return }
    setShowNewPlan(false)
    setPlanForm({ clientId: '', month: new Date().toISOString().slice(0, 7), title: '', notes: '' })
    toast.success('Plan created')
    router.push(`/dashboard/social-calendar?calendar=${res.data.id}`)
    router.refresh()
  }

  async function submitItem() {
    if (!selected || !itemModal) return
    setSavingItem(true)
    const res = itemModal.mode === 'add'
      ? await addCalendarItem(selected.id, itemForm)
      : await updateCalendarItem(itemModal.itemId!, itemForm)
    setSavingItem(false)
    if (!res.ok) { toast.toastError('Could not save the item', res.error); return }
    setItemModal(null)
    toast.success(itemModal.mode === 'add' ? 'Item planned' : 'Item updated')
    router.refresh()
  }

  async function removeItem(itemId: string) {
    setBusy(`delete:${itemId}`)
    const res = await deleteCalendarItem(itemId)
    setBusy(null)
    if (!res.ok) { toast.toastError('Could not remove the item', res.error); return }
    setItemModal(null)
    toast.success('Item removed')
    router.refresh()
  }

  async function push(itemIds: string[]) {
    if (!selected || itemIds.length === 0) return
    setBusy(itemIds.length === 1 ? `push:${itemIds[0]}` : 'push-all')
    const res = await pushItemsToRequests(selected.id, itemIds)
    setBusy(null)
    if (!res.ok || !res.data) { toast.toastError('Could not send to Requests', res.error); return }
    const { pushed, failed } = res.data
    if (failed > 0) toast.toastError(`${pushed} sent, ${failed} failed`, 'Check the Requests inbox and retry the rest.')
    else toast.success(`${pushed} item${pushed === 1 ? '' : 's'} sent to Requests`, 'They now appear in the Requests inbox as planned work.')
    setItemModal(null)
    router.refresh()
  }

  async function replanItem(itemId: string) {
    setBusy(`replan:${itemId}`)
    const res = await revertItemToPlanned(itemId)
    setBusy(null)
    if (!res.ok) { toast.toastError('Could not re-plan the item', res.error); return }
    setItemModal(null)
    toast.success('Item back to planned', 'You can edit it and send it to Requests again.')
    router.refresh()
  }

  async function archivePlan() {
    if (!selected) return
    setBusy('archive')
    const res = await updateSocialCalendar(selected.id, { status: selected.status === 'archived' ? 'active' : 'archived' })
    setBusy(null)
    if (!res.ok) { toast.toastError('Could not update the plan', res.error); return }
    toast.success(selected.status === 'archived' ? 'Plan restored' : 'Plan archived')
    router.refresh()
  }

  async function removePlan() {
    if (!selected) return
    setBusy('delete-plan')
    const res = await deleteSocialCalendar(selected.id)
    setBusy(null)
    if (!res.ok) { toast.toastError('Could not delete the plan', res.error); return }
    toast.success('Plan deleted')
    router.push('/dashboard/social-calendar')
    router.refresh()
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (!migrated) {
    return (
      <div className="space-y-6">
        <Header title="Social Calendar" subtitle="Plan client content and feed it into the Requests pipeline" />
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          The social calendar needs a database migration. Apply <code>supabase/migrations/20260716120000_social_calendar.sql</code> to enable this module.
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <Header
        title="Social Calendar"
        subtitle="Plan a month of client content, then send planned items to the Requests inbox — they ride the normal request → task pipeline from there"
      />

      {/* ── Toolbar: plan picker + new plan ── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[260px]">
          <Combobox
            options={calendars.map(c => {
              const total = c.items?.length ?? 0
              const sent = c.items?.filter(i => i.request_id).length ?? 0
              return {
                id: c.id,
                label: `${c.client?.name ?? 'Client'} — ${monthLabel(c.month)}`,
                sub: `${c.title ? c.title + ' · ' : ''}${total} items · ${sent} in requests${c.status === 'archived' ? ' · archived' : ''}`,
              }
            })}
            value={selected?.id ?? ''}
            onChange={id => { if (id) { router.push(`/dashboard/social-calendar?calendar=${id}`); router.refresh() } }}
            placeholder={calendars.length ? 'Pick a plan…' : 'No plans yet'}
            sortKey="social_calendars"
          />
        </div>
        {canManage && (
          <button
            onClick={() => setShowNewPlan(true)}
            className="inline-flex items-center gap-1.5 rounded-lg gradient-bg px-3 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            <Plus className="w-4 h-4" /> New Plan
          </button>
        )}
        {selected && canManage && (
          <div className="flex items-center gap-1.5 ml-auto">
            {unpushed.length > 0 && (
              <button
                onClick={() => push(unpushed.map(i => i.id))}
                disabled={busy === 'push-all'}
                className="inline-flex items-center gap-1.5 rounded-lg border border-blue-500/40 bg-blue-500/10 text-blue-500 px-3 py-2 text-sm font-medium hover:bg-blue-500/20 disabled:opacity-50"
              >
                {busy === 'push-all' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                Send {unpushed.length} to Requests
              </button>
            )}
            <button
              onClick={archivePlan}
              disabled={busy === 'archive'}
              title={selected.status === 'archived' ? 'Restore plan' : 'Archive plan'}
              className="rounded-lg border border-border px-2.5 py-2 text-muted-foreground hover:text-foreground hover:bg-secondary"
            >
              <Archive className="w-4 h-4" />
            </button>
            {items.every(i => !i.request_id) && (
              <button
                onClick={removePlan}
                disabled={busy === 'delete-plan'}
                title="Delete plan (only while nothing was sent to Requests)"
                className="rounded-lg border border-border px-2.5 py-2 text-muted-foreground hover:text-red-500 hover:bg-secondary"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        )}
      </div>

      {!selected ? (
        <div className="rounded-xl border border-border bg-card px-6 py-16 text-center">
          <CalendarDays className="w-8 h-8 mx-auto text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            No content plans yet. {canManage ? 'Create one to start planning a client’s month.' : ''}
          </p>
        </div>
      ) : (
        <>
          {/* ── Plan header: client + month + progress chips ── */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{selected.client?.name}</span>
            <span className="text-xs text-muted-foreground">· {monthLabel(selected.month)}</span>
            {selected.title && <span className="text-xs text-muted-foreground">· {selected.title}</span>}
            {selected.status === 'archived' && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border">Archived</span>
            )}
            <div className="flex flex-wrap items-center gap-1.5 ml-auto">
              {(Object.keys(progressCounts) as ItemProgress[])
                .filter(k => progressCounts[k] > 0)
                .map(k => (
                  <span key={k} className={`text-[10px] px-2 py-0.5 rounded-full border ${PROGRESS_CHIP[k]}`}>
                    {progressCounts[k]} {PROGRESS_LABEL[k]}
                  </span>
                ))}
            </div>
          </div>

          {/* ── Month grid ── */}
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="grid grid-cols-7 border-b border-border">
              {WEEKDAYS.map(d => (
                <div key={d} className="px-2 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground text-center">{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {grid.map(cell => {
                const dayItems = itemsByDate.get(cell.key) ?? []
                return (
                  <div
                    key={cell.key}
                    className={`min-h-[92px] border-b border-r border-border/50 p-1.5 align-top ${cell.inMonth ? '' : 'bg-secondary/20 opacity-50'} ${canManage && cell.inMonth ? 'cursor-pointer hover:bg-secondary/30 transition-colors' : ''}`}
                    onClick={() => {
                      if (!canManage || !cell.inMonth) return
                      setItemForm({ ...EMPTY_ITEM, scheduledDate: cell.key })
                      setItemModal({ mode: 'add' })
                    }}
                  >
                    <div className="text-[10px] text-muted-foreground">{cell.date.getDate()}</div>
                    <div className="mt-1 space-y-1">
                      {dayItems.map(it => {
                        const progress = resolveItemProgress(it.status, it.request)
                        return (
                          <button
                            key={it.id}
                            onClick={e => {
                              e.stopPropagation()
                              setItemForm({
                                scheduledDate: it.scheduled_date, title: it.title,
                                contentType: it.content_type, platforms: it.platforms ?? [],
                                caption: it.caption ?? '', notes: it.notes ?? '',
                              })
                              setItemModal({ mode: 'edit', itemId: it.id })
                            }}
                            className={`w-full text-left rounded-md border px-1.5 py-1 text-[10px] leading-tight hover:opacity-80 ${CONTENT_TYPE_CHIP[it.content_type as keyof typeof CONTENT_TYPE_CHIP] ?? CONTENT_TYPE_CHIP.other}`}
                            title={`${it.title} — ${PROGRESS_LABEL[progress]}`}
                          >
                            <span className="font-medium block truncate">{it.title}</span>
                            <span className="flex items-center gap-1 opacity-80">
                              {CONTENT_TYPE_LABEL[it.content_type as keyof typeof CONTENT_TYPE_LABEL] ?? it.content_type}
                              {(it.platforms?.length ?? 0) > 0 && <> · {platformLabels(it.platforms, true)}</>}
                              <span className={`ml-auto inline-block w-1.5 h-1.5 rounded-full ${progress === 'planned' ? 'bg-gray-400' : progress === 'requested' ? 'bg-blue-400' : progress === 'in_progress' ? 'bg-amber-400' : progress === 'delivered' ? 'bg-purple-400' : progress === 'done' ? 'bg-green-500' : 'bg-red-400'}`} />
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground -mt-2">
            {canManage ? 'Click a day to plan an item · click an item to edit or send it to Requests. ' : ''}
            Sent items appear in the <Link href="/dashboard/requests" className="text-primary hover:underline">Requests inbox</Link> with
            a “planned” chip; once started there, progress flows back here automatically.
          </p>
        </>
      )}

      {/* ── New Plan modal ── */}
      {showNewPlan && (
        <ModalOverlay onClose={() => setShowNewPlan(false)}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h2 className="font-semibold">New Content Plan</h2>
              <button onClick={() => setShowNewPlan(false)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Client *</label>
                <Combobox
                  options={clients.map(c => ({ id: c.id, label: c.name, sub: c.code }))}
                  value={planForm.clientId}
                  onChange={id => setPlanForm(p => ({ ...p, clientId: id }))}
                  placeholder="Search client…"
                  sortKey="clients"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Month *</label>
                  <input
                    type="month" value={planForm.month}
                    onChange={e => setPlanForm(p => ({ ...p, month: e.target.value }))}
                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Label</label>
                  <input
                    type="text" value={planForm.title}
                    onChange={e => setPlanForm(p => ({ ...p, title: e.target.value }))}
                    placeholder="e.g. Diwali push"
                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Notes</label>
                <textarea
                  value={planForm.notes} rows={2}
                  onChange={e => setPlanForm(p => ({ ...p, notes: e.target.value }))}
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none resize-none"
                />
              </div>
            </div>
            <div className="flex gap-2 px-5 py-4 border-t border-border">
              <button onClick={() => setShowNewPlan(false)} className="flex-1 bg-secondary text-sm font-medium py-2 rounded-lg hover:bg-secondary/80">Cancel</button>
              <button
                onClick={submitNewPlan}
                disabled={savingPlan || !planForm.clientId || !planForm.month}
                className="flex-1 gradient-bg text-white text-sm font-medium py-2 rounded-lg hover:opacity-90 disabled:opacity-50"
              >
                {savingPlan ? 'Creating…' : 'Create Plan'}
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* ── Item modal (add / edit) ── */}
      {itemModal && selected && (
        <ModalOverlay onClose={() => setItemModal(null)}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div>
                <h2 className="font-semibold">{itemModal.mode === 'add' ? 'Plan an item' : 'Edit item'}</h2>
                {editingItem?.request && (
                  <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
                    <span className="font-mono">{refLabel(editingItem.request.ref_no ?? 0)}</span>
                    {editingProgress && (
                      <span className={`px-1.5 py-0.5 rounded-full border text-[10px] ${PROGRESS_CHIP[editingProgress]}`}>
                        {PROGRESS_LABEL[editingProgress]}
                      </span>
                    )}
                    {editingItem.request.promoted_task?.task_number != null && (
                      <span className="font-mono text-green-500">Task #{editingItem.request.promoted_task.task_number}</span>
                    )}
                    <Link href={`/dashboard/requests?focus=${editingItem.request.id}`} className="text-primary hover:underline inline-flex items-center gap-0.5">
                      open in Requests <ExternalLink className="w-3 h-3" />
                    </Link>
                  </p>
                )}
              </div>
              <button onClick={() => setItemModal(null)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>

            <div className="px-5 py-4 space-y-3 max-h-[65dvh] overflow-y-auto">
              {editingFrozen && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  This item is already a task — the plan entry is frozen. Manage it from the Tasks page.
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Title *</label>
                <input
                  type="text" value={itemForm.title} disabled={editingFrozen}
                  onChange={e => setItemForm(p => ({ ...p, title: e.target.value }))}
                  placeholder="e.g. Diwali teaser reel"
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none disabled:opacity-60"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Date *</label>
                  <input
                    type="date" value={itemForm.scheduledDate} disabled={editingFrozen}
                    onChange={e => setItemForm(p => ({ ...p, scheduledDate: e.target.value }))}
                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Content type *</label>
                  <AppSelect
                    value={itemForm.contentType} disabled={editingFrozen}
                    onChange={e => setItemForm(p => ({ ...p, contentType: e.target.value }))}
                  >
                    {CONTENT_TYPES.map(t => <option key={t} value={t}>{CONTENT_TYPE_LABEL[t]}</option>)}
                  </AppSelect>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Platforms</label>
                <div className="flex flex-wrap gap-1.5">
                  {PLATFORMS.map(p => {
                    const on = itemForm.platforms.includes(p)
                    return (
                      <button
                        key={p} type="button" disabled={editingFrozen}
                        onClick={() => setItemForm(f => ({
                          ...f,
                          platforms: on ? f.platforms.filter(x => x !== p) : [...f.platforms, p],
                        }))}
                        className={`px-2.5 py-1 rounded-full text-xs border transition-colors disabled:opacity-60 ${on
                          ? 'bg-primary/15 text-primary border-primary/30 font-medium'
                          : 'bg-secondary text-muted-foreground border-transparent hover:text-foreground'}`}
                      >
                        {PLATFORM_LABEL[p]}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Caption / copy</label>
                <textarea
                  value={itemForm.caption ?? ''} rows={3} disabled={editingFrozen}
                  onChange={e => setItemForm(p => ({ ...p, caption: e.target.value }))}
                  placeholder="Draft caption for the designer…"
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none resize-none disabled:opacity-60"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Internal notes</label>
                <textarea
                  value={itemForm.notes ?? ''} rows={2} disabled={editingFrozen}
                  onChange={e => setItemForm(p => ({ ...p, notes: e.target.value }))}
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none resize-none disabled:opacity-60"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-2 px-5 py-4 border-t border-border">
              {itemModal.mode === 'edit' && !editingFrozen && (
                <button
                  onClick={() => removeItem(itemModal.itemId!)}
                  disabled={busy === `delete:${itemModal.itemId}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-red-500 disabled:opacity-50"
                >
                  {busy === `delete:${itemModal.itemId}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  Remove
                </button>
              )}
              {itemModal.mode === 'edit' && editingItem && !editingItem.request_id && editingItem.status === 'planned' && (
                <button
                  onClick={() => push([itemModal.itemId!])}
                  disabled={busy === `push:${itemModal.itemId}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-blue-500/40 bg-blue-500/10 text-blue-500 px-3 py-2 text-sm font-medium hover:bg-blue-500/20 disabled:opacity-50"
                >
                  {busy === `push:${itemModal.itemId}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  Send to Requests
                </button>
              )}
              {/* Escape hatch: the inbox closed this item's request, so without
                  a way back to 'planned' the item is a dead end (push skips
                  anything already linked). */}
              {itemModal.mode === 'edit' && editingItem && !editingFrozen && requestIsClosed && (
                <button
                  onClick={() => replanItem(itemModal.itemId!)}
                  disabled={busy === `replan:${itemModal.itemId}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-50"
                  title="Its request was closed in the inbox — unlink and plan it again"
                >
                  {busy === `replan:${itemModal.itemId}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                  Re-plan
                </button>
              )}
              <div className="flex-1" />
              <button onClick={() => setItemModal(null)} className="bg-secondary text-sm font-medium px-4 py-2 rounded-lg hover:bg-secondary/80">Close</button>
              {!editingFrozen && (
                <button
                  onClick={submitItem}
                  disabled={savingItem || !itemForm.title.trim() || !itemForm.scheduledDate}
                  className="gradient-bg text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90 disabled:opacity-50"
                >
                  {savingItem ? 'Saving…' : itemModal.mode === 'add' ? 'Plan Item' : 'Save Changes'}
                </button>
              )}
            </div>
          </div>
        </ModalOverlay>
      )}

      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
    </div>
  )
}

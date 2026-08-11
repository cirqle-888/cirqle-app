'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Combobox from '@/components/ui/combobox'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useToast, ToastContainer } from '@/components/ui/toast'
import {
  ArrowLeft, Plus, Pencil, Trash2, Loader2, Check, X, ChevronRight, MoreHorizontal,
  Play, Pause, CheckCircle2, Ban, RotateCcw, MessageSquarePlus, ExternalLink,
} from 'lucide-react'
import { formatTaskDate } from '@/lib/utils/format-date'
import { getDeliveryPaceText } from '@/lib/utils'
import {
  AGREEMENT_STATUS_CHIP, STATUS_LABEL, COMMITMENT_TYPES, CYCLES, CARRY_RULES,
  RENEWAL_TYPES, VISIBILITY_TYPES,
  type AgreementStatus, type CommitmentType, type Cycle, type CarryForwardRule,
  type RenewalType, type Visibility,
} from '@/lib/agreements/types'
import {
  saveAgreementItem, changeAgreementItemTerms, deleteAgreementItem, restampItemWorkValues,
  linkTaskToAgreementItem, unlinkTaskFromAgreementItem, searchClientTasks,
  type AgreementItemInput, type AgreementDeliverableInput, type AgreementMilestoneInput,
} from './actions'
import { usePrivacy } from '@/contexts/privacy-context'

// ─── Constants ───────────────────────────────────────────────────────────────

const CONTENT_TYPES = [
  'post', 'reel', 'story', 'carousel', 'video', 'flyer', 'poster', 'blog', 'seo', 'ad', 'email', 'other',
]

// Width lives outside the base so a row can size its own fields. Appending
// `w-24` to a class string that already carries `w-full` is a coin toss in the
// cascade — that is what shrank the deliverable name box to an empty pill.
const inputBase = 'bg-secondary border border-foreground/15 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20'
const inputCls = `w-full ${inputBase}`
const labelCls = 'block text-xs font-medium text-muted-foreground mb-1.5'

// Contextual status transitions.
const TRANSITIONS: Record<string, { to: AgreementStatus; label: string; icon: any; tone: string }[]> = {
  draft: [
    { to: 'active', label: 'Activate', icon: Play, tone: 'text-green-600' },
    { to: 'cancelled', label: 'Cancel', icon: Ban, tone: 'text-red-500' },
  ],
  pending_approval: [
    { to: 'active', label: 'Activate', icon: Play, tone: 'text-green-600' },
    { to: 'cancelled', label: 'Cancel', icon: Ban, tone: 'text-red-500' },
  ],
  active: [
    { to: 'paused', label: 'Pause', icon: Pause, tone: 'text-orange-500' },
    { to: 'completed', label: 'Complete', icon: CheckCircle2, tone: 'text-emerald-600' },
    { to: 'cancelled', label: 'Cancel', icon: Ban, tone: 'text-red-500' },
  ],
  paused: [
    { to: 'active', label: 'Resume', icon: Play, tone: 'text-green-600' },
    { to: 'completed', label: 'Complete', icon: CheckCircle2, tone: 'text-emerald-600' },
    { to: 'cancelled', label: 'Cancel', icon: Ban, tone: 'text-red-500' },
  ],
  completed: [{ to: 'active', label: 'Reopen', icon: RotateCcw, tone: 'text-blue-600' }],
  expired: [{ to: 'active', label: 'Reactivate', icon: RotateCcw, tone: 'text-blue-600' }],
  cancelled: [{ to: 'draft', label: 'Restore to draft', icon: RotateCcw, tone: 'text-blue-600' }],
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface Deliverable {
  id?: string; label: string; content_types: string[]; committed_quantity: number
  display_order: number; notes?: string | null
}
interface Milestone {
  id?: string; label: string; display_order: number; due_date?: string | null
  visibility: Visibility; completed_at?: string | null; task_id?: string | null
}
interface Item {
  id: string; service_id: string | null; commitment_type: CommitmentType
  committed_quantity: number | null; cycle: Cycle | null
  effective_from: string; effective_to: string | null
  unit_price?: number | null; currency?: string; carry_forward_rule: CarryForwardRule
  extra_unit_price?: number | null; display_order: number; notes: string | null
  creative_allocation_amount?: number | null; management_allocation_amount?: number | null
  included_quantity?: number | null; allocated_unit_value?: number | null
  work_unit_value?: number | null; work_commission_pct?: number | null
  invoice_label?: string | null
  coveredServices?: { id: string; name: string }[]
  deliverables: Deliverable[]; milestones: Milestone[]
}
interface Agreement {
  id: string; agreement_number: string; title: string; status: AgreementStatus
  start_date: string; end_date: string | null; renewal_type: RenewalType
  notes: string | null; signed_document_url: string | null; client_id: string
  client?: { id: string; name: string; default_currency: string | null } | null
}
interface EventRow {
  id: string; action: string; actor_label: string | null; visibility: string
  detail: any; created_at: string
}

type ItemForm = AgreementItemInput & { _mode: 'create' | 'edit' | 'change_terms' | 'fix_details' }

// ─── Helpers ─────────────────────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10)

function itemHeadline(it: { deliverables: Deliverable[]; committed_quantity: number | null }) {
  if (it.deliverables.length > 0) return it.deliverables.reduce((s, d) => s + Number(d.committed_quantity || 0), 0)
  return Number(it.committed_quantity || 0)
}

/**
 * "Change terms" closes the current row and inserts a successor, so the loader
 * returns BOTH and the page listed them as two near-identical items — the same
 * commitment twice, one of which no longer owes anything. The lineage is
 * recorded nowhere but the term_changed events, so rebuild it from those: the
 * newest term of a chain is the item, the earlier ones become its history.
 *
 * A chain whose event is missing (pre-dating the log, or past its 200-row
 * window) simply stays split — the old behaviour, never a wrong merge.
 */
function foldTermChains(items: Item[], events: EventRow[]) {
  const successorOf = new Map<string, string>()
  for (const ev of events) {
    if (ev.action !== 'term_changed') continue
    const from = ev.detail?.from_item_id
    const to = ev.detail?.to_item_id
    if (typeof from === 'string' && typeof to === 'string') successorOf.set(from, to)
  }

  const byId = new Map(items.map(i => [i.id, i]))
  const history = new Map<string, Item[]>()
  const superseded = new Set<string>()

  for (const it of items) {
    let tipId = it.id
    const walked = new Set([tipId])
    while (successorOf.has(tipId)) {
      const next = successorOf.get(tipId)!
      if (!byId.has(next) || walked.has(next)) break // successor deleted, or a cycle
      tipId = next
      walked.add(tipId)
    }
    if (tipId === it.id) continue
    superseded.add(it.id)
    history.set(tipId, [...(history.get(tipId) ?? []), it])
  }

  for (const list of history.values()) {
    list.sort((a, b) => a.effective_from.localeCompare(b.effective_from))
  }
  return { current: items.filter(i => !superseded.has(i.id)), history }
}

/**
 * Consecutive events that say the same thing at the same minute (two items added
 * in one save, say) collapse into one row with a count. Without this the whole
 * timeline is "Item added / Item added / Item added" and the useful entries —
 * the notes — get lost between them. Rows carrying text are never merged.
 */
function groupEvents(events: EventRow[]): (EventRow & { count: number })[] {
  const out: (EventRow & { count: number })[] = []
  for (const ev of events) {
    const prev = out[out.length - 1]
    if (
      prev && prev.action === ev.action && prev.actor_label === ev.actor_label
      && prev.visibility === ev.visibility
      && !prev.detail?.text && !ev.detail?.text
      && prev.created_at.slice(0, 16) === ev.created_at.slice(0, 16)
    ) {
      prev.count += 1
      continue
    }
    out.push({ ...ev, count: 1 })
  }
  return out
}

const EVENT_LABEL: Record<string, string> = {
  created: 'Agreement created', updated: 'Details updated', activated: 'Activated',
  paused: 'Paused', resumed: 'Resumed', completed: 'Completed', cancelled: 'Cancelled',
  expired: 'Expired', item_added: 'Item added', item_updated: 'Item updated',
  item_removed: 'Item removed', term_changed: 'Terms changed', note: 'Note',
  quotation_linked: 'Quotation linked', renewed: 'Renewed', adjustment: 'Adjustment',
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function AgreementDetailClient({
  agreement, items: initialItems, events: initialEvents, progress, currentMonth,
  services, tasks, canManage, canViewPricing,
}: {
  agreement: Agreement
  items: Item[]
  events: EventRow[]
  progress: any | null
  currentMonth: string
  services: { id: string; name: string }[]
  tasks: any[] // CoveredTask
  canManage: boolean
  canViewPricing: boolean
}) {
  const router = useRouter()
  const { toasts, dismiss, success, error: toastError } = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [itemForm, setItemForm] = useState<ItemForm | null>(null)
  const [editHeader, setEditHeader] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)

  const currency = agreement.client?.default_currency || 'INR'
  const serviceName = useMemo(() => new Map(services.map(s => [s.id, s.name])), [services])
  const { current: items, history: termHistory } = useMemo(
    () => foldTermChains(initialItems, initialEvents),
    [initialItems, initialEvents],
  )
  const transitions = TRANSITIONS[agreement.status] || []
  const isDraft = agreement.status === 'draft' || agreement.status === 'pending_approval'

  async function refresh() { router.refresh() }

  // In-app confirmation, NOT window.confirm: the desktop shell returns false
  // from native confirm without drawing anything, so Cancel / Delete / Remove
  // silently did nothing there (same bug the Months screen fixed).
  const [confirmPrompt, setConfirmPrompt] = useState<{
    title: string; body: string; confirmLabel: string; danger?: boolean; onConfirm: () => void
  } | null>(null)

  async function handleStatus(to: AgreementStatus, label: string) {
    if (to === 'cancelled') {
      setConfirmPrompt({
        title: `${label} this agreement?`,
        body: 'Covered tasks stop drawing from its work values and bill normally again. The agreement and its history are kept.',
        confirmLabel: label,
        danger: true,
        onConfirm: () => { setConfirmPrompt(null); void applyStatus(to, label) },
      })
      return
    }
    void applyStatus(to, label)
  }

  async function applyStatus(to: AgreementStatus, label: string) {
    setBusy('status')
    const res = await setAgreementStatus(agreement.id, to)
    setBusy(null)
    if (res.ok) { success(`Agreement ${label.toLowerCase()}d`); refresh() }
    else toastError('Could not update status', res.error)
  }

  function handleDeleteAgreement() {
    setConfirmPrompt({
      title: 'Delete this agreement?',
      body: 'It is archived, not destroyed — an admin can restore it. Covered tasks revert to normal billing.',
      confirmLabel: 'Delete agreement',
      danger: true,
      onConfirm: () => { setConfirmPrompt(null); void applyDeleteAgreement() },
    })
  }

  async function applyDeleteAgreement() {
    setBusy('delete')
    const res = await deleteAgreement(agreement.id)
    setBusy(null)
    if (res.ok) { success('Agreement deleted'); router.push('/dashboard/agreements') }
    else toastError('Delete failed', res.error)
  }

  function handleDeleteItem(it: Item) {
    setConfirmPrompt({
      title: 'Remove this item?',
      body: 'The item and its deliverables are removed from the agreement. Tasks already linked to it revert to normal billing.',
      confirmLabel: 'Remove item',
      danger: true,
      onConfirm: () => { setConfirmPrompt(null); void applyDeleteItem(it) },
    })
  }

  async function applyDeleteItem(it: Item) {
    setBusy('item:' + it.id)
    const res = await deleteAgreementItem(agreement.id, it.id)
    setBusy(null)
    if (res.ok) { success('Item removed'); refresh() }
    else toastError('Could not remove item', res.error)
  }

  async function handleToggleMilestone(m: Milestone) {
    if (!m.id) return
    setBusy('ms:' + m.id)
    const res = await toggleMilestone(agreement.id, m.id, !m.completed_at)
    setBusy(null)
    if (res.ok) refresh()
    else toastError('Could not update milestone', res.error)
  }

  const committed = progress?.totalCommitted ?? 0
  const delivered = progress?.totalDelivered ?? 0
  const remaining = progress?.totalRemaining ?? 0
  const extraBilled = progress?.totalExtraBilled ?? 0
  const pct = committed > 0 ? Math.min(100, Math.round((delivered / committed) * 100)) : 0

  return (
    <div className="flex flex-col gap-5 p-5 md:p-8 max-w-6xl mx-auto w-full">
      {/* Header — identity and status first; everything else is one quiet line */}
      <div>
        <Link href="/dashboard/agreements"
          className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground transition-colors mb-3">
          <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Agreements
        </Link>

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-xl md:text-2xl font-bold tracking-tight text-foreground">{agreement.title}</h1>
              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${AGREEMENT_STATUS_CHIP[agreement.status]}`}>
                {STATUS_LABEL[agreement.status] || agreement.status}
              </span>
            </div>
            {/* Inline, not flex — so it wraps like a sentence on a phone instead
                of stacking one fact per line with orphaned separators. */}
            <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
              <span className="tabular-nums">{agreement.agreement_number}</span>
              {agreement.client && (
                <>
                  {' · '}
                  <Link href={`/dashboard/clients/${agreement.client.id}`} className="hover:text-foreground hover:underline">
                    {agreement.client.name}
                  </Link>
                </>
              )}
              {' · '}
              <span className="tabular-nums whitespace-nowrap">
                {formatTaskDate(agreement.start_date)} → {agreement.end_date ? formatTaskDate(agreement.end_date) : 'Ongoing'}
              </span>
              {' · '}
              <span className="capitalize whitespace-nowrap">{agreement.renewal_type} renewal</span>
              {agreement.signed_document_url && (
                <>
                  {' · '}
                  <a href={agreement.signed_document_url} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline align-middle">
                    Signed doc <ExternalLink className="w-3 h-3" />
                  </a>
                </>
              )}
            </p>
          </div>

          {canManage && (
            <div className="flex items-center gap-1.5 shrink-0">
              <button onClick={() => setEditHeader(true)}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-secondary border border-border hover:bg-secondary/70 transition-colors">
                <Pencil className="w-3.5 h-3.5" /> Edit
              </button>
              <ActionMenu disabled={busy === 'status' || busy === 'delete'}>
                {close => (
                  <>
                    {transitions.map(t => (
                      <button key={t.to} onClick={() => { close(); handleStatus(t.to, t.label) }}
                        className="w-full flex items-center gap-2.5 text-left text-sm px-2.5 py-2 rounded-lg hover:bg-secondary transition-colors">
                        <t.icon className={`w-3.5 h-3.5 ${t.tone}`} /> {t.label}
                      </button>
                    ))}
                    <div className="my-1 h-px bg-border" />
                    <button onClick={() => { close(); handleDeleteAgreement() }}
                      className="w-full flex items-center gap-2.5 text-left text-sm px-2.5 py-2 rounded-lg text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors">
                      <Trash2 className="w-3.5 h-3.5" /> Delete
                    </button>
                  </>
                )}
              </ActionMenu>
            </div>
          )}
        </div>

        {agreement.notes && <ClampText text={agreement.notes} className="mt-3 max-w-3xl text-sm" />}
      </div>

      {/* Delivery — one strip instead of a wall of number cards */}
      <section className="rounded-xl border bg-card shadow-sm px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Delivery</h2>
          <MonthSwitcher
            month={currentMonth}
            agreementStart={agreement.start_date}
            onChange={m => router.push(`?month=${m}`)}
          />
        </div>
        <div className="mt-3 flex items-baseline gap-2 flex-wrap">
          <span className="text-2xl font-bold tabular-nums leading-none">{delivered}</span>
          <span className="text-sm text-muted-foreground">of {committed} delivered</span>
          <span className="ml-auto flex items-baseline gap-3 text-xs">
            {extraBilled > 0 && (
              <span className="text-blue-600 dark:text-blue-400 tabular-nums">+{extraBilled} billed as extra</span>
            )}
            {remaining > 0 && (
              <span className="font-medium text-amber-600 dark:text-amber-400 tabular-nums">{remaining} remaining</span>
            )}
            {remaining > 0 && getDeliveryPaceText(currentMonth, remaining) && (
              <span className="text-muted-foreground bg-secondary/50 px-2 py-0.5 rounded border border-border/50">
                {getDeliveryPaceText(currentMonth, remaining)}
              </span>
            )}
          </span>
        </div>
        <div className="mt-2 h-1.5 rounded-full bg-secondary overflow-hidden">
          <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Items */}
        <div className="lg:col-span-2 rounded-xl border bg-card text-card-foreground shadow-sm self-start">
          <div className="px-5 py-3.5 border-b flex justify-between items-center gap-3">
            <h3 className="text-sm font-semibold">
              Items {items.length > 0 && <span className="text-muted-foreground font-normal">({items.length})</span>}
            </h3>
            {canManage && (
              <button onClick={() => setItemForm(newItemForm(currency))}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg bg-secondary border border-border hover:bg-secondary/70 transition-colors">
                <Plus className="w-3.5 h-3.5" /> Add item
              </button>
            )}
          </div>

          {items.filter(it => !progress?.items.find((pi: any) => pi.itemId === it.id)?.period?.inactive).length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-muted-foreground">
              <p>No items yet.</p>
              {canManage && <p className="text-xs mt-1">Add a retainer or one-time package to define what is committed.</p>}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {items
                .filter(it => !progress?.items.find((pi: any) => pi.itemId === it.id)?.period?.inactive)
                .map(it => (
                <ItemCard
                  key={it.id} it={it} currency={currency} canManage={canManage}
                  canViewPricing={canViewPricing} isDraft={isDraft} serviceName={serviceName}
                  busy={busy} defaultOpen={items.length === 1} history={termHistory.get(it.id) ?? []}
                  tasks={tasks.filter(t => (t.item_ids || []).includes(it.id) || t.item_id === it.id)}
                  agreementId={agreement.id}
                  clientId={agreement.client_id}
                  onEdit={() => setItemForm(itemToForm(it, agreement.status))}
                  onChangeTerms={() => setItemForm(itemToForm(it, agreement.status, true))}
                  onFixDetails={() => setItemForm(itemToForm(it, agreement.status, false, true))}
                  onDelete={() => handleDeleteItem(it)}
                  onToggleMilestone={handleToggleMilestone}
                />
              ))}
            </div>
          )}
        </div>

        <Timeline events={initialEvents} canManage={canManage} onAddNote={() => setNoteOpen(true)} />
      </div>

      {/* Modals */}
      {itemForm && (
        <ItemEditor
          form={itemForm} setForm={setItemForm} agreementId={agreement.id}
          services={services} currency={currency} canViewPricing={canViewPricing}
          onSaved={() => { setItemForm(null); success('Item saved'); refresh() }}
          onError={m => toastError('Could not save item', m)}
        />
      )}
      {editHeader && (
        <HeaderEditor
          agreement={agreement} onClose={() => setEditHeader(false)}
          onSaved={() => { setEditHeader(false); success('Details updated'); refresh() }}
          onError={m => toastError('Could not save', m)}
        />
      )}
      {noteOpen && (
        <NoteEditor
          agreementId={agreement.id} onClose={() => setNoteOpen(false)}
          onSaved={() => { setNoteOpen(false); success('Note added'); refresh() }}
          onError={m => toastError('Could not add note', m)}
        />
      )}

      {confirmPrompt && (
        <ConfirmDialog
          title={confirmPrompt.title}
          body={confirmPrompt.body}
          confirmLabel={confirmPrompt.confirmLabel}
          danger={confirmPrompt.danger}
          onConfirm={confirmPrompt.onConfirm}
          onCancel={() => setConfirmPrompt(null)}
        />
      )}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}

// ─── Header bits ─────────────────────────────────────────────────────────────

/** Status changes and delete — rare enough to live behind one button. */
function ActionMenu({
  disabled, children,
}: {
  disabled?: boolean
  children: (close: () => void) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(o => !o)} disabled={disabled} aria-label="More actions"
        className="p-1.5 rounded-lg bg-secondary border border-border hover:bg-secondary/70 transition-colors disabled:opacity-50">
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1.5 z-50 w-48 rounded-xl border border-border bg-card shadow-xl p-1">
            {children(() => setOpen(false))}
          </div>
        </>
      )}
    </div>
  )
}

/** Signed-proposal summaries run long; two lines is enough to recognise them. */
function ClampText({ text, className = '' }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > 150
  return (
    <div className={className}>
      <p className={`text-muted-foreground leading-relaxed ${!open && long ? 'line-clamp-2' : ''}`}>{text}</p>
      {long && (
        <button type="button" onClick={() => setOpen(o => !o)}
          className="mt-0.5 text-xs font-medium text-primary hover:underline">
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

// ─── Timeline ────────────────────────────────────────────────────────────────

const TIMELINE_PREVIEW = 5

function Timeline({
  events, canManage, onAddNote,
}: {
  events: EventRow[]; canManage: boolean; onAddNote: () => void
}) {
  const [showAll, setShowAll] = useState(false)
  const rows = useMemo(() => groupEvents(events), [events])
  const visible = showAll ? rows : rows.slice(0, TIMELINE_PREVIEW)

  return (
    <div className="rounded-xl border bg-card text-card-foreground shadow-sm self-start">
      <div className="px-5 py-3.5 border-b flex justify-between items-center gap-3">
        <h3 className="text-sm font-semibold">Activity</h3>
        {canManage && (
          <button onClick={onAddNote}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg bg-secondary border border-border hover:bg-secondary/70 transition-colors">
            <MessageSquarePlus className="w-3.5 h-3.5" /> Note
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">No activity yet.</p>
      ) : (
        <>
          <ul className={`p-4 space-y-3 ${showAll ? 'max-h-[420px] overflow-y-auto' : ''}`}>
            {visible.map(ev => (
              <li key={ev.id} className="flex gap-2.5">
                <span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-primary/50 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[13px] text-foreground">
                    {EVENT_LABEL[ev.action] || ev.action}
                    {ev.count > 1 && <span className="text-muted-foreground"> ×{ev.count}</span>}
                    {ev.visibility === 'client' && (
                      <span className="ml-1.5 text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 border border-blue-500/20">Client</span>
                    )}
                  </p>
                  {ev.detail?.text && (
                    <p className="text-xs text-muted-foreground mt-0.5 break-words leading-relaxed">{ev.detail.text}</p>
                  )}
                  <p className="text-[11px] text-muted-foreground/60 mt-0.5 tabular-nums"
                    title={new Date(ev.created_at).toLocaleString()}>
                    {ev.actor_label ? `${ev.actor_label} · ` : ''}{formatTaskDate(ev.created_at.slice(0, 10))}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          {rows.length > TIMELINE_PREVIEW && (
            <button type="button" onClick={() => setShowAll(s => !s)}
              className="w-full px-5 py-2.5 border-t text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors">
              {showAll ? 'Show less' : `Show all ${rows.length}`}
            </button>
          )}
        </>
      )}
    </div>
  )
}

// ─── Item card ───────────────────────────────────────────────────────────────

function ItemCard({
  it, currency, canManage, canViewPricing, isDraft, serviceName, busy, defaultOpen, history,
  tasks, agreementId, clientId,
  onEdit, onChangeTerms, onFixDetails, onDelete, onToggleMilestone,
}: {
  it: Item; currency: string; canManage: boolean; canViewPricing: boolean; isDraft: boolean
  serviceName: Map<string, string>; busy: string | null; defaultOpen: boolean
  /** Closed terms this row replaced, oldest first. */
  history: Item[]
  tasks: any[] // CoveredTask
  agreementId: string
  clientId: string
  onEdit: () => void; onChangeTerms: () => void; onFixDetails: () => void; onDelete: () => void
  onToggleMilestone: (m: Milestone) => void
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [showDoneMs, setShowDoneMs] = useState(false)
  const { dn } = usePrivacy()
  const [showHistory, setShowHistory] = useState(false)
  const [showLinkModal, setShowLinkModal] = useState(false)
  const headline = itemHeadline(it)
  const typeLabel = COMMITMENT_TYPES.find(t => t.value === it.commitment_type)?.label
  const service = it.service_id ? serviceName.get(it.service_id) || 'Service' : null
  // The invoice wording is what people recognise; the catalogue name is detail.
  const name = it.invoice_label || service || 'General'
  const msTotal = it.milestones.length
  const msDone = it.milestones.filter(m => m.completed_at).length
  const visibleMilestones = msDone > 2 && !showDoneMs
    ? it.milestones.filter(m => !m.completed_at)
    : it.milestones

  return (
    <div>
      {/* Collapsed row: what it is, how much, how far along. Nothing else. */}
      <button type="button" onClick={() => setOpen(o => !o)}
        className="w-full flex items-start gap-2.5 px-4 sm:px-5 py-3.5 text-left hover:bg-secondary/40 transition-colors">
        <ChevronRight className={`w-4 h-4 mt-0.5 shrink-0 text-muted-foreground/60 transition-transform ${open ? 'rotate-90' : ''}`} />
        {/* Name + facts share a line on desktop and stack on a phone, so the
            name is never truncated away by the numbers on its right. */}
        <span className="min-w-0 flex-1 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2.5">
          <span className="min-w-0 flex items-center gap-2">
            <span className="font-medium text-foreground truncate">{name}</span>
            <span className="shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border">
              {typeLabel}{it.commitment_type === 'retainer' && it.cycle ? ` · ${it.cycle}` : ''}
            </span>
          </span>
          <span className="sm:ml-auto shrink-0 flex items-center gap-3 text-xs text-muted-foreground tabular-nums">
            {headline > 0 && (
              <span>{headline} {it.commitment_type === 'retainer' ? 'per cycle' : 'committed'}</span>
            )}
            {msTotal > 0 && (
              <span title={`${msDone} of ${msTotal} milestones complete`}
                className={msDone === msTotal ? 'text-emerald-600 dark:text-emerald-400' : ''}>
                {msDone}/{msTotal} done
              </span>
            )}
            {canViewPricing && it.unit_price != null && (
              <span className="font-medium text-foreground">{currency} {it.unit_price}</span>
            )}
          </span>
        </span>
      </button>

      {open && (
      <div className="px-5 pb-5">
      <p className="text-xs text-muted-foreground tabular-nums">
        {it.invoice_label && service ? `${service} · ` : ''}
        {formatTaskDate(it.effective_from)} → {it.effective_to ? formatTaskDate(it.effective_to) : 'current'}
      </p>
      {it.notes && <ClampText text={it.notes} className="mt-1 max-w-2xl text-xs" />}

      {/* Pricing summary — client pays / team is paid / extras */}
      {canViewPricing &&
        (it.unit_price != null || it.work_unit_value != null || it.extra_unit_price != null) && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {it.unit_price != null && (
            <span className="text-muted-foreground">Client pays <b className="text-foreground">{currency} {it.unit_price}</b>{it.commitment_type === 'retainer' ? `/${it.cycle || 'cycle'}` : ''}</span>
          )}
          <span className="text-muted-foreground">
            Work value {it.work_unit_value != null
              ? <b className="text-foreground">{currency} {it.work_unit_value}</b>
              : <b className="text-amber-600 dark:text-amber-400">not set</b>}
            {it.work_unit_value != null && '/task'}
          </span>
          {it.extra_unit_price != null && (
            <span className="text-muted-foreground">Extra work <b className="text-foreground">{currency} {it.extra_unit_price}</b>/task</span>
          )}
          {it.work_commission_pct != null && (
            <span className="text-muted-foreground">Pool <b className="text-foreground">{it.work_commission_pct}%</b></span>
          )}
        </div>
      )}

      {/* Internal allocation summary (operational only) */}
      {canViewPricing &&
        (it.creative_allocation_amount != null || it.management_allocation_amount != null) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="font-medium text-muted-foreground">Internal allocation</span>
          {it.creative_allocation_amount != null && (
            <span className="text-muted-foreground">Creative <b>{currency} {it.creative_allocation_amount}</b></span>
          )}
          {it.management_allocation_amount != null && (
            <span className="text-muted-foreground">Management <b>{currency} {it.management_allocation_amount}</b></span>
          )}
          {it.allocated_unit_value != null && (
            <span className="text-muted-foreground">
              Allocated unit value <b className="text-foreground">{currency} {it.allocated_unit_value}</b>/unit
            </span>
          )}
        </div>
      )}

      {/* Covered services (retainer) */}
      {it.commitment_type === 'retainer' && (it.coveredServices?.length ?? 0) > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground mr-1">Covers</span>
          {it.coveredServices!.map(s => (
            <span key={s.id} className="text-[11px] px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border">{s.name}</span>
          ))}
        </div>
      )}

      {/* Deliverables */}
      {it.deliverables.length > 0 && (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
          {it.deliverables.map((d, i) => (
            <div key={d.id || i} className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate text-muted-foreground">• {d.label}</span>
              <span className="font-medium">{d.committed_quantity}</span>
            </div>
          ))}
        </div>
      )}

      {/* Milestones — finished steps fold away; what's left to do stays in view */}
      {it.milestones.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {msDone > 2 && !showDoneMs && (
            <button type="button" onClick={() => setShowDoneMs(true)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 text-emerald-500" />
              {msDone} completed — show
            </button>
          )}
          {visibleMilestones.map((m, i) => {
            const done = !!m.completed_at
            const linked = !!m.task_id
            return (
              <div key={m.id || i} className="flex items-center gap-2 text-sm">
                <button
                  onClick={() => !linked && canManage && onToggleMilestone(m)}
                  disabled={linked || !canManage || busy === 'ms:' + m.id}
                  title={linked ? 'Status derives from the linked task' : done ? 'Mark incomplete' : 'Mark complete'}
                  className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${done ? 'bg-emerald-500/80 border-emerald-500 text-white' : 'border-border hover:border-foreground/40'} ${linked || !canManage ? 'cursor-default opacity-70' : ''}`}
                >
                  {done && <Check className="w-3 h-3" />}
                </button>
                <span className={done ? 'line-through text-muted-foreground' : ''}>{m.label}</span>
                {m.due_date && <span className="text-[11px] text-muted-foreground/70">due {m.due_date}</span>}
                {m.visibility === 'client' && (
                  <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 border border-blue-500/20">Client</span>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Tasks Covered */}
      <div className="mt-4 border-t border-border/60 pt-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-foreground">Tasks Covered · {tasks.length}</span>
            {it.committed_quantity != null && (
              <>
                <span className="text-muted-foreground/40">|</span>
                <span className="text-[11px] text-muted-foreground">
                  <span className="text-foreground font-medium">{tasks.length}</span> delivered
                  {' · '}
                  <span className="text-foreground font-medium">{Math.max(0, it.committed_quantity - tasks.length)}</span> remaining
                </span>
              </>
            )}
          </div>
          {canManage && (
            <button
              onClick={() => setShowLinkModal(true)}
              className="text-xs text-muted-foreground hover:text-foreground underline decoration-border hover:decoration-foreground underline-offset-2 transition-colors">
              + Link existing task
            </button>
          )}
        </div>
        {tasks.length > 0 ? (
          <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
            {tasks.map(t => (
              <div key={t.id} className="flex items-center justify-between text-xs p-2 rounded-lg bg-secondary/30 border border-border/50">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="font-medium truncate text-foreground">{t.title}</span>
                    {t.task_number && <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">#{t.task_number}</span>}
                    {t.is_manual ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 border border-amber-500/20">Manual</span>
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 border border-green-500/20">Auto</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground/80">
                    <span>{t.task_date}</span>
                    <span>·</span>
                    <span className="capitalize">{t.status.replace(/_/g, ' ')}</span>
                    {t.contributors && t.contributors.length > 0 && (
                      <>
                        <span>·</span>
                        <span className="truncate">{t.contributors.map(c => dn(c)).join(', ')}</span>
                      </>
                    )}
                  </div>
                </div>
                {canManage && t.is_manual && (
                  <button
                    onClick={async () => {
                      if (confirm('Unlink this task?')) {
                        const res = await unlinkTaskFromAgreementItem(agreementId, it.id, t.id)
                        if (res.ok) alert('Task unlinked')
                        else alert(res.error)
                      }
                    }}
                    title="Unlink task"
                    className="p-1.5 ml-2 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded-md transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="py-4 text-center text-xs text-muted-foreground border border-dashed border-border/50 rounded-lg">
            No tasks linked yet
          </div>
        )}
      </div>

      {showLinkModal && (
        <TaskLinkModal
          clientId={clientId}
          agreementId={agreementId}
          itemId={it.id}
          onClose={() => setShowLinkModal(false)}
        />
      )}

      {/* Terms this row replaced — kept because past months were billed on them */}
      {history.length > 0 && (
        <div className="mt-4 border-t border-border/60 pt-3">
          <button type="button" onClick={() => setShowHistory(h => !h)}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
            <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showHistory ? 'rotate-90' : ''}`} />
            {history.length} earlier {history.length === 1 ? 'term' : 'terms'}
          </button>
          {showHistory && (
            <ul className="mt-2 space-y-1 pl-4.5">
              {history.map(h => (
                <li key={h.id} className="text-xs text-muted-foreground/80 tabular-nums">
                  {formatTaskDate(h.effective_from)} → {h.effective_to ? formatTaskDate(h.effective_to) : 'current'}
                  {h.service_id && serviceName.get(h.service_id) ? ` · ${serviceName.get(h.service_id)}` : ''}
                  {itemHeadline(h) > 0 ? ` · ${itemHeadline(h)} committed` : ''}
                  {canViewPricing && h.unit_price != null ? ` · ${currency} ${h.unit_price}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {canManage && (
        <div className="mt-4 flex items-center gap-1.5">
          {isDraft ? (
            <button onClick={onEdit}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg bg-secondary border border-border hover:bg-secondary/70 transition-colors">
              <Pencil className="w-3.5 h-3.5" /> Edit item
            </button>
          ) : (
            <>
              <button onClick={onChangeTerms}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg bg-secondary border border-border hover:bg-secondary/70 transition-colors">
                <Pencil className="w-3.5 h-3.5" /> Change terms
              </button>
              <button onClick={onFixDetails}
                title="Edit typos without creating a new terms history record"
                className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg text-muted-foreground hover:bg-secondary/50 transition-colors border border-transparent hover:border-border/50">
                Fix details
              </button>
            </>
          )}
          {isDraft && (
            <button onClick={onDelete} disabled={busy === 'item:' + it.id}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50">
              <Trash2 className="w-3.5 h-3.5" /> Remove
            </button>
          )}
        </div>
      )}
      </div>
      )}
    </div>
  )
}

// ─── Form section ────────────────────────────────────────────────────────────

/**
 * One collapsible block of the item form. The editor used to present every
 * field at once — pricing, allocation, work value, covered services,
 * deliverables, milestones — which reads as a wall. Sections open themselves
 * when they already hold data, so editing an existing item still shows what it
 * has, and a new item starts with just the basics.
 */
function Section({
  title, hint, badge, defaultOpen = false, children,
}: {
  title: string
  hint?: string
  badge?: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="mt-3 rounded-xl border border-border">
      <button type="button" onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left rounded-xl hover:bg-secondary/40 transition-colors">
        <ChevronRight className={`w-4 h-4 shrink-0 text-muted-foreground/60 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="text-sm font-medium">{title}</span>
        {badge && <span className="ml-auto text-xs text-muted-foreground tabular-nums">{badge}</span>}
      </button>
      {open && (
        <div className="px-4 pb-4">
          {hint && <p className="text-xs text-muted-foreground leading-relaxed mb-3">{hint}</p>}
          {children}
        </div>
      )}
    </div>
  )
}

// ─── Item form factories ─────────────────────────────────────────────────────

function newItemForm(currency: string): ItemForm {
  return {
    _mode: 'create',
    service_id: null, commitment_type: 'retainer', committed_quantity: null,
    cycle: 'monthly', effective_from: today(), effective_to: null,
    unit_price: null, currency, carry_forward_rule: 'expire', extra_unit_price: null,
    display_order: 0, notes: '',
    creative_allocation_amount: null, management_allocation_amount: null, included_quantity: null,
    work_unit_value: null, work_commission_pct: null, invoice_label: null,
    coveredServiceIds: [],
    deliverables: [], milestones: [],
  }
}

function itemToForm(it: Item, status: AgreementStatus, changeTerms = false, forceEdit = false): ItemForm {
  const active = status !== 'draft' && status !== 'pending_approval'
  let nextDate = it.effective_from
  const isChangeTermsMode = (changeTerms || active) && !forceEdit

  if (isChangeTermsMode) {
    const todayStr = today()
    nextDate = todayStr > it.effective_from ? todayStr : (() => {
      const d = new Date(it.effective_from)
      d.setDate(d.getDate() + 1)
      return d.toISOString().slice(0, 10)
    })()
  }

  return {
    _mode: isChangeTermsMode ? 'change_terms' : 'edit',
    id: it.id,
    service_id: it.service_id, commitment_type: it.commitment_type,
    committed_quantity: it.committed_quantity, cycle: it.cycle,
    effective_from: nextDate,
    effective_to: it.effective_to,
    unit_price: it.unit_price ?? null, currency: it.currency || 'INR',
    carry_forward_rule: it.carry_forward_rule, extra_unit_price: it.extra_unit_price ?? null,
    display_order: it.display_order, notes: it.notes,
    creative_allocation_amount: it.creative_allocation_amount ?? null,
    management_allocation_amount: it.management_allocation_amount ?? null,
    included_quantity: it.included_quantity ?? null,
    work_unit_value: it.work_unit_value ?? null,
    work_commission_pct: it.work_commission_pct ?? null,
    invoice_label: it.invoice_label ?? null,
    coveredServiceIds: (it.coveredServices ?? []).map(s => s.id),
    deliverables: it.deliverables.map(d => ({ ...d })),
    milestones: it.milestones.map(m => ({ ...m })),
  }
}

// ─── Internal allocation editor (retainer only) ──────────────────────────────
// Splits the monthly retainer across cost centres for OPERATIONAL metrics only.
// The allocated unit value is derived, shown read-only, and never a client price.

function AllocationEditor({
  form, set, currency,
}: {
  form: ItemForm
  set: (patch: Partial<ItemForm>) => void
  currency: string
}) {
  const creative = form.creative_allocation_amount
  const management = form.management_allocation_amount
  // Denominator: explicit included_quantity, else the item's committed headline.
  const included = form.included_quantity ?? form.committed_quantity ?? null
  const allocUnit = creative != null && included && included > 0
    ? Math.round((creative / included) * 100) / 100
    : null
  const retainer = form.unit_price ?? null
  const allocSum = (creative ?? 0) + (management ?? 0)
  const mismatch = retainer != null && (creative != null || management != null) && Math.abs(allocSum - retainer) > 0.005

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className={labelCls}>Creative allocation ({currency})</label>
          <input type="number" min="0" step="any" value={creative ?? ''}
            onChange={e => set({ creative_allocation_amount: e.target.value === '' ? null : parseFloat(e.target.value) })}
            className={inputCls} placeholder="e.g. 300" />
        </div>
        <div>
          <label className={labelCls}>Management allocation ({currency})</label>
          <input type="number" min="0" step="any" value={management ?? ''}
            onChange={e => set({ management_allocation_amount: e.target.value === '' ? null : parseFloat(e.target.value) })}
            className={inputCls} placeholder="e.g. 100" />
        </div>
        <div>
          <label className={labelCls}>Included quantity</label>
          <input type="number" min="0" step="any" value={form.included_quantity ?? ''}
            onChange={e => set({ included_quantity: e.target.value === '' ? null : parseFloat(e.target.value) })}
            className={inputCls} placeholder={form.committed_quantity != null ? `${form.committed_quantity} (committed)` : 'e.g. 15'} />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        <span className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Allocated unit value</span>
          <span className="font-semibold tabular-nums">{allocUnit != null ? `${currency} ${allocUnit}` : '—'}</span>
          {allocUnit != null && <span className="text-[11px] text-muted-foreground/60">/ unit (internal)</span>}
        </span>
        <span className="text-[11px] text-muted-foreground/60">= creative ÷ included ({creative ?? '—'} ÷ {included ?? '—'})</span>
      </div>

      {mismatch && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
          Heads up: allocations total {currency} {Math.round(allocSum * 100) / 100}, which does not match the {currency} {retainer} retainer. That is allowed — just confirm it is intentional.
        </p>
      )}
    </>
  )
}

// ─── Work value editor (retainer only) ───────────────────────────────────────
// The THREE prices of an agreement service line:
//   unit_price       → what the client pays (invoice)         — edited above
//   work_unit_value  → what each covered task pays the TEAM   — edited here
//   extra_unit_price → client price per task beyond the quota — edited above
// The work value feeds the contribution pool only; it is never invoiced.

function WorkValueEditor({
  form, set, currency,
}: {
  form: ItemForm
  set: (patch: Partial<ItemForm>) => void
  currency: string
}) {
  const included = form.included_quantity ?? form.committed_quantity ?? null
  const autoValue = form.unit_price != null && included && included > 0
    ? Math.round((form.unit_price / included) * 100) / 100
    : null

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Work value per task ({currency})</label>
          <div className="flex gap-2">
            <input type="number" min="0" step="any" value={form.work_unit_value ?? ''}
              onChange={e => set({ work_unit_value: e.target.value === '' ? null : parseFloat(e.target.value) })}
              className={inputCls} placeholder={autoValue != null ? `e.g. ${autoValue}` : 'e.g. 26.67'} />
            {autoValue != null && (
              <button type="button" onClick={() => set({ work_unit_value: autoValue })}
                title={`${form.commitment_type === 'retainer' ? 'Retainer' : 'Package fee'} ÷ included quantity = ${currency} ${autoValue}`}
                className="shrink-0 text-xs px-2.5 rounded-lg border border-border bg-secondary hover:bg-secondary/70 transition-colors">
                Auto: {autoValue}
              </button>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground/70 mt-1">
            Auto = {form.unit_price ?? '—'} {form.commitment_type === 'retainer' ? 'retainer' : 'package fee'} ÷ {included ?? '—'} included
          </p>
        </div>
        <div>
          <label className={labelCls}>Commission pool % <span className="text-muted-foreground/60">(optional)</span></label>
          <input type="number" min="0" max="100" step="any" value={form.work_commission_pct ?? ''}
            onChange={e => set({ work_commission_pct: e.target.value === '' ? null : parseFloat(e.target.value) })}
            className={inputCls} placeholder="Blank = default 50%" />
          <p className="text-[11px] text-muted-foreground/70 mt-1">
            Share of the work value that becomes the employee pool. Overrides the pricing matrix for this item&apos;s tasks.
          </p>
        </div>
    </div>
  )
}

// ─── Covered services editor (retainer only) ─────────────────────────────────
// A retainer covers a SET of services (Poster, Carousel, Reel, …). Any task on
// a covered service is retainer-covered — no client billing.

function CoveredServicesEditor({
  form, set, services,
}: {
  form: ItemForm
  set: (patch: Partial<ItemForm>) => void
  services: { id: string; name: string }[]
}) {
  const selected = new Set(form.coveredServiceIds ?? [])
  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id); else next.add(id)
    set({ coveredServiceIds: Array.from(next) })
  }
  return (
    <>
      {services.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">No services available.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
          {services.map(s => {
            const on = selected.has(s.id)
            return (
              <button key={s.id} type="button" onClick={() => toggle(s.id)}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${on ? 'bg-primary text-primary-foreground border-primary' : 'bg-secondary text-muted-foreground border-border hover:border-foreground/30'}`}>
                {on && <Check className="w-3 h-3 inline mr-1 -mt-0.5" />}{s.name}
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}

// ─── Item editor modal ───────────────────────────────────────────────────────

function ItemEditor({
  form, setForm, agreementId, services, currency, canViewPricing, onSaved, onError,
}: {
  form: ItemForm; setForm: (f: ItemForm | null) => void; agreementId: string
  services: { id: string; name: string }[]; currency: string; canViewPricing: boolean
  onSaved: () => void; onError: (m: string) => void
}) {
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<ItemForm>) => setForm({ ...form, ...patch })
  const isRetainer = form.commitment_type === 'retainer'
  const changeTerms = form._mode === 'change_terms'
  // Deliverable lines, when present, ARE the commitment — the headline number is
  // only the fallback. Showing the running total keeps that relationship visible.
  const deliverableTotal = form.deliverables.reduce((s, d) => s + (Number(d.committed_quantity) || 0), 0)

  function setDeliverable(i: number, patch: Partial<AgreementDeliverableInput>) {
    const next = form.deliverables.slice()
    next[i] = { ...next[i], ...patch }
    set({ deliverables: next })
  }
  function setMilestone(i: number, patch: Partial<AgreementMilestoneInput>) {
    const next = form.milestones.slice()
    next[i] = { ...next[i], ...patch }
    set({ milestones: next })
  }

  async function save() {
    setSaving(true)
    const payload: AgreementItemInput = {
      id: form.id, service_id: form.service_id, commitment_type: form.commitment_type,
      committed_quantity: form.committed_quantity != null ? Number(form.committed_quantity) : null,
      cycle: form.cycle, effective_from: form.effective_from, effective_to: form.effective_to,
      unit_price: form.unit_price != null ? Number(form.unit_price) : null, currency: form.currency,
      carry_forward_rule: form.carry_forward_rule,
      extra_unit_price: form.extra_unit_price != null ? Number(form.extra_unit_price) : null,
      display_order: form.display_order,
      notes: form.notes,
      creative_allocation_amount: form.creative_allocation_amount != null ? Number(form.creative_allocation_amount) : null,
      management_allocation_amount: form.management_allocation_amount != null ? Number(form.management_allocation_amount) : null,
      included_quantity: form.included_quantity != null ? Number(form.included_quantity) : null,
      work_unit_value: form.work_unit_value != null ? Number(form.work_unit_value) : null,
      work_commission_pct: form.work_commission_pct != null ? Number(form.work_commission_pct) : null,
      invoice_label: form.invoice_label?.trim() || null,
      coveredServiceIds: form.commitment_type === 'retainer' ? (form.coveredServiceIds ?? []) : undefined,
      deliverables: form.deliverables.map((d, i) => ({ ...d, committed_quantity: Number(d.committed_quantity) || 0, display_order: i })),
      milestones: form.milestones.map((m, i) => ({ ...m, display_order: i })),
    }
    const res = changeTerms && form.id
      ? await changeAgreementItemTerms(agreementId, form.id, payload)
      : await saveAgreementItem(agreementId, payload, form._mode === 'fix_details')
    setSaving(false)
    if (res.ok) onSaved()
    else onError(res.ok ? '' : res.error)
  }

  const title = form._mode === 'create' ? 'Add item' : changeTerms ? 'Change terms' : form._mode === 'fix_details' ? 'Fix details' : 'Edit item'

  return (
    <ModalOverlay onClose={() => !saving && setForm(null)} sheetOnMobile>
      <div className="bg-card w-full sm:max-w-2xl rounded-t-2xl sm:rounded-2xl border border-border shadow-xl p-5 sm:p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold">{title}</h2>
          <button onClick={() => setForm(null)} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground"><X className="w-4 h-4" /></button>
        </div>

        {changeTerms && (
          <div className="mb-4 text-xs bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2 text-amber-700 dark:text-amber-300">
            Saving closes the current term and starts a new one — past months keep their original terms.
          </div>
        )}

        {/* Setup */}
        <Section title="Setup" defaultOpen={true}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>Commitment</label>
            <select value={form.commitment_type}
              onChange={e => set({ commitment_type: e.target.value as CommitmentType, cycle: e.target.value === 'retainer' ? (form.cycle || 'monthly') : null })}
              className={inputCls}>
              {COMMITMENT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Service</label>
            <Combobox options={services.map(s => ({ id: s.id, label: s.name }))}
              value={form.service_id || ''} onChange={id => set({ service_id: id || null })}
              placeholder="Search service…" sortKey="services" />
          </div>

          {isRetainer && (
            <div>
              <label className={labelCls}>Cycle</label>
              <select value={form.cycle || 'monthly'} onChange={e => set({ cycle: e.target.value as Cycle })} className={inputCls}>
                {CYCLES.map(c => <option key={c.value} value={c.value} disabled={c.value !== 'monthly'}>{c.label}{c.value !== 'monthly' ? ' (soon)' : ''}</option>)}
              </select>
            </div>
          )}

          <div>
            <label className={labelCls}>
              Committed quantity {isRetainer && <span className="text-muted-foreground/60">per cycle</span>}
            </label>
            <input type="number" min="0" step="any" value={form.committed_quantity ?? ''}
              onChange={e => set({ committed_quantity: e.target.value === '' ? null : parseFloat(e.target.value) })}
              placeholder="e.g. 15" className={inputCls} />
            {form.deliverables.length > 0 && (
              <p className="text-[11px] text-muted-foreground/70 mt-1">
                Set by the deliverable lines below — {deliverableTotal} in total.
              </p>
            )}
          </div>

          <div>
            <label className={labelCls}>Starts</label>
            <input type="date" value={form.effective_from} onChange={e => set({ effective_from: e.target.value })} className={inputCls} />
          </div>

          {canViewPricing && (
            <div>
              <label className={labelCls}>{isRetainer ? 'Monthly retainer' : 'Package fee'} ({currency})</label>
              <input type="number" min="0" step="any" value={form.unit_price ?? ''}
                onChange={e => set({ unit_price: e.target.value === '' ? null : parseFloat(e.target.value) })}
                placeholder="e.g. 400" className={inputCls} />
            </div>
          )}
        </div>
        </Section>

        {/* Covered services (retainer only) — a retainer can cover many services */}
        {isRetainer && (
          <Section
            title="Covered services"
            badge={`${(form.coveredServiceIds ?? []).length} selected`}
            defaultOpen={(form.coveredServiceIds ?? []).length > 0}>
            <CoveredServicesEditor form={form} set={set} services={services} />
          </Section>
        )}

        {/* Deliverables — the named breakdown of the committed quantity */}
        <Section
          title="Deliverables"
          badge={form.deliverables.length > 0 ? `${deliverableTotal} across ${form.deliverables.length}` : 'none'}
          defaultOpen={form.deliverables.length > 0}>
          <div className="space-y-3">
            {form.deliverables.map((d, i) => (
              <div key={i} className="rounded-lg border border-border p-3 bg-secondary/20">
                <div className="flex gap-2 items-center">
                  <input value={d.label} onChange={e => setDeliverable(i, { label: e.target.value })}
                    placeholder="What is it? e.g. Feed Posts" className={`${inputBase} flex-1 min-w-0`} />
                  <input type="number" min="0" step="any" value={d.committed_quantity}
                    onChange={e => setDeliverable(i, { committed_quantity: parseFloat(e.target.value) || 0 })}
                    aria-label="Quantity" title="How many per cycle"
                    className={`${inputBase} w-20 shrink-0 text-center`} />
                  <button onClick={() => set({ deliverables: form.deliverables.filter((_, x) => x !== i) })}
                    title="Remove this line"
                    className="p-2 rounded-md hover:bg-red-500/10 text-muted-foreground hover:text-red-500 transition-colors shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
                <p className="text-[11px] text-muted-foreground/60 mt-2 mb-1">Content types (optional)</p>
                <div className="flex flex-wrap gap-1.5">
                  {CONTENT_TYPES.map(ct => {
                    const on = d.content_types.includes(ct)
                    return (
                      <button key={ct} onClick={() => setDeliverable(i, { content_types: on ? d.content_types.filter(x => x !== ct) : [...d.content_types, ct] })}
                        className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${on ? 'bg-primary text-primary-foreground border-primary' : 'bg-secondary text-muted-foreground border-border hover:border-foreground/30'}`}>
                        {ct}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between gap-3 mt-3">
            <button onClick={() => set({ deliverables: [...form.deliverables, { label: '', content_types: [], committed_quantity: 0, display_order: form.deliverables.length }] })}
              className="text-xs inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-secondary border border-border hover:bg-secondary/70 transition-colors">
              <Plus className="w-3.5 h-3.5" /> Add a line
            </button>
            {form.deliverables.length > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                Commits <b className="text-foreground">{deliverableTotal}</b>
                {isRetainer ? ' per cycle' : ' in total'}
              </span>
            )}
          </div>
        </Section>

        {/* Milestones */}
        <Section
          title="Milestones"
          badge={form.milestones.length > 0 ? `${form.milestones.length}` : 'none'}
          defaultOpen={form.milestones.length > 0}>
          <div className="space-y-2">
            {form.milestones.map((m, i) => (
              <div key={i} className="flex flex-wrap sm:flex-nowrap gap-2 items-center">
                <input value={m.label} onChange={e => setMilestone(i, { label: e.target.value })}
                  placeholder="Step e.g. Concept approved" className={`${inputBase} flex-1 min-w-0 w-full sm:w-auto`} />
                <input type="date" value={m.due_date || ''} onChange={e => setMilestone(i, { due_date: e.target.value || null })}
                  aria-label="Due date" className={`${inputBase} w-36 shrink-0`} />
                <select value={m.visibility} onChange={e => setMilestone(i, { visibility: e.target.value as Visibility })}
                  aria-label="Visibility" className={`${inputBase} w-28 shrink-0`}>
                  {VISIBILITY_TYPES.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
                </select>
                <button onClick={() => set({ milestones: form.milestones.filter((_, x) => x !== i) })}
                  title="Remove this step"
                  className="p-2 rounded-md hover:bg-red-500/10 text-muted-foreground hover:text-red-500 transition-colors shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            ))}
          </div>
          <button onClick={() => set({ milestones: [...form.milestones, { label: '', display_order: form.milestones.length, due_date: null, visibility: 'internal' }] })}
            className="mt-3 text-xs inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-secondary border border-border hover:bg-secondary/70 transition-colors">
            <Plus className="w-3.5 h-3.5" /> Add a step
          </button>
        </Section>

        {/* Advanced */}
        <Section
          title="Advanced"
          defaultOpen={
            !!form.effective_to || !!form.invoice_label || !!form.notes || form.extra_unit_price != null
            || form.work_unit_value != null || form.work_commission_pct != null
            || form.creative_allocation_amount != null || form.management_allocation_amount != null
          }
        >
          <div className="space-y-6">
            {/* End date & unused units */}
            <div>
              <h3 className="text-sm font-medium mb-3">End date & unused units</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {!changeTerms && (
              <div>
                <label className={labelCls}>Ends <span className="text-muted-foreground/60">(optional)</span></label>
                <input type="date" value={form.effective_to || ''} onChange={e => set({ effective_to: e.target.value || null })} className={inputCls} />
              </div>
            )}
            {isRetainer && (
              <div>
                <label className={labelCls}>Carry-forward</label>
                <select value={form.carry_forward_rule} onChange={e => set({ carry_forward_rule: e.target.value as CarryForwardRule })} className={inputCls}>
                  {CARRY_RULES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
            )}
              </div>
            </div>

            {/* Wording & extra work */}
            <div className="pt-4 border-t border-border/50">
              <h3 className="text-sm font-medium mb-3">Wording & extra work</h3>
              <div className="grid grid-cols-1 gap-4">
            <div>
              <label className={labelCls}>Invoice name <span className="text-muted-foreground/60">(optional)</span></label>
              <input value={form.invoice_label || ''}
                onChange={e => set({ invoice_label: e.target.value })}
                className={inputCls}
                placeholder={
                  (form.service_id && services.find(s => s.id === form.service_id)?.name)
                    ? `Blank = "${services.find(s => s.id === form.service_id)!.name}" (service name)`
                    : 'e.g. Brand Identity Development'
                } />
            </div>
            {canViewPricing && (
              <div>
                <label className={labelCls}>Extra-unit price ({currency}) <span className="text-muted-foreground/60">(optional)</span></label>
                <input type="number" min="0" step="any" value={form.extra_unit_price ?? ''}
                  onChange={e => set({ extra_unit_price: e.target.value === '' ? null : parseFloat(e.target.value) })}
                  className={inputCls} />
              </div>
            )}
            <div>
              <label className={labelCls}>Notes <span className="text-muted-foreground/60">(optional)</span></label>
              <input value={form.notes || ''} onChange={e => set({ notes: e.target.value })} className={inputCls} placeholder="Item context…" />
            </div>
              </div>
            </div>

            {/* Team pay & internal split */}
            {canViewPricing && (
              <div className="pt-4 border-t border-border/50">
                <h3 className="text-sm font-medium mb-1">Team pay & internal split</h3>
                <WorkValueEditor form={form} set={set} currency={currency} />
                <div className="my-4 h-px bg-border/50" />
                <AllocationEditor form={form} set={set} currency={currency} />
              </div>
            )}
          </div>
        </Section>

        <div className="flex gap-3 mt-6">
          <button onClick={() => setForm(null)} disabled={saving}
            className="flex-1 bg-secondary text-sm font-medium py-2.5 rounded-lg hover:bg-secondary/80 transition-colors disabled:opacity-50">Cancel</button>
          <button onClick={save} disabled={saving || !form.effective_from}
            className="flex-1 bg-primary text-primary-foreground text-sm font-medium py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50 transition-all flex items-center justify-center gap-2">
            {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : <><Check className="w-4 h-4" /> Save item</>}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

// ─── Header editor modal ─────────────────────────────────────────────────────

function HeaderEditor({
  agreement, onClose, onSaved, onError,
}: {
  agreement: Agreement; onClose: () => void; onSaved: () => void; onError: (m: string) => void
}) {
  const [saving, setSaving] = useState(false)
  const [title, setTitle] = useState(agreement.title)
  const [startDate, setStartDate] = useState(agreement.start_date)
  const [endDate, setEndDate] = useState(agreement.end_date || '')
  const [renewalType, setRenewalType] = useState<RenewalType>(agreement.renewal_type)
  const [notes, setNotes] = useState(agreement.notes || '')
  const [signedUrl, setSignedUrl] = useState(agreement.signed_document_url || '')

  async function save() {
    setSaving(true)
    const res = await updateAgreementDetails(agreement.id, {
      title, startDate, endDate: endDate || null, renewalType,
      notes: notes || null, signedDocumentUrl: signedUrl || null,
    })
    setSaving(false)
    if (res.ok) onSaved()
    else onError(res.ok ? '' : res.error)
  }

  return (
    <ModalOverlay onClose={() => !saving && onClose()} sheetOnMobile>
      <div className="bg-card w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl border border-border shadow-xl p-5 sm:p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold">Edit agreement</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground"><X className="w-4 h-4" /></button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <label className={labelCls}>Title</label>
            <input value={title} onChange={e => setTitle(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Start date</label>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>End date</label>
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Renewal</label>
            <select value={renewalType} onChange={e => setRenewalType(e.target.value as RenewalType)} className={inputCls}>
              {RENEWAL_TYPES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>Signed document URL <span className="text-muted-foreground/60">(optional)</span></label>
            <input value={signedUrl} onChange={e => setSignedUrl(e.target.value)} placeholder="https://…" className={inputCls} />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>Notes</label>
            <input value={notes} onChange={e => setNotes(e.target.value)} className={inputCls} />
          </div>
        </div>
        <div className="flex gap-3 mt-6">
          <button onClick={onClose} disabled={saving} className="flex-1 bg-secondary text-sm font-medium py-2.5 rounded-lg hover:bg-secondary/80 transition-colors disabled:opacity-50">Cancel</button>
          <button onClick={save} disabled={saving || !title.trim() || !startDate}
            className="flex-1 bg-primary text-primary-foreground text-sm font-medium py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50 transition-all flex items-center justify-center gap-2">
            {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : <><Check className="w-4 h-4" /> Save</>}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

// ─── Note editor modal ───────────────────────────────────────────────────────

function NoteEditor({
  agreementId, onClose, onSaved, onError,
}: {
  agreementId: string; onClose: () => void; onSaved: () => void; onError: (m: string) => void
}) {
  const [saving, setSaving] = useState(false)
  const [text, setText] = useState('')
  const [visibility, setVisibility] = useState<Visibility>('internal')

  async function save() {
    setSaving(true)
    const res = await addAgreementNote(agreementId, text, visibility)
    setSaving(false)
    if (res.ok) onSaved()
    else onError(res.ok ? '' : res.error)
  }

  return (
    <ModalOverlay onClose={() => !saving && onClose()} sheetOnMobile>
      <div className="bg-card w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-border shadow-xl p-5 sm:p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold">Add note</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground"><X className="w-4 h-4" /></button>
        </div>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={4} placeholder="What happened…"
          className={inputCls + ' resize-none'} />
        <div className="mt-3">
          <label className={labelCls}>Visibility</label>
          <select value={visibility} onChange={e => setVisibility(e.target.value as Visibility)} className={inputCls}>
            {VISIBILITY_TYPES.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
          </select>
        </div>
        <div className="flex gap-3 mt-5">
          <button onClick={onClose} disabled={saving} className="flex-1 bg-secondary text-sm font-medium py-2.5 rounded-lg hover:bg-secondary/80 transition-colors disabled:opacity-50">Cancel</button>
          <button onClick={save} disabled={saving || !text.trim()}
            className="flex-1 bg-primary text-primary-foreground text-sm font-medium py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50 transition-all flex items-center justify-center gap-2">
            {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : <><Check className="w-4 h-4" /> Add note</>}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

// ─── Month navigation ────────────────────────────────────────────────────────

/** True when the agreement covers only part of `month`, so committed is prorated. */
function isPartialMonth(month: string, start: string, end: string | null): boolean {
  const [y, m] = month.split('-').map(Number)
  const first = `${month}-01`
  const last = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`
  return start > first || (!!end && end < last)
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * Steps the progress view month by month. Without this the page always showed
 * the current month, so on the 1st it read "Delivered 0" for an agreement that
 * had delivered all month — indistinguishable from a broken engine.
 */
function MonthSwitcher({
  month, agreementStart, onChange,
}: {
  month: string
  agreementStart: string
  onChange: (m: string) => void
}) {
  const thisMonth = new Date().toISOString().slice(0, 7)
  const atStart = shiftMonth(month, -1) < agreementStart.slice(0, 7)
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onChange(shiftMonth(month, -1))}
        disabled={atStart}
        aria-label="Previous month"
        className="px-2 py-1 rounded-md border text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent"
      >‹</button>
      <span className="text-sm font-medium tabular-nums min-w-[72px] text-center">{month}</span>
      <button
        type="button"
        onClick={() => onChange(shiftMonth(month, 1))}
        aria-label="Next month"
        className="px-2 py-1 rounded-md border text-sm hover:bg-accent"
      >›</button>
      {month !== thisMonth && (
        <button
          type="button"
          onClick={() => onChange(thisMonth)}
          className="ml-1 px-2 py-1 rounded-md border text-xs hover:bg-accent"
        >This month</button>
      )}
    </div>
  )
}

function TaskLinkModal({
  clientId, agreementId, itemId, onClose,
}: {
  clientId: string; agreementId: string; itemId: string; onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [tasks, setTasks] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [linking, setLinking] = useState<string | null>(null)
  const toaster = useToast()

  // debounce search
  useMemo(() => {
    setLoading(true)
    const t = setTimeout(async () => {
      const res = await searchClientTasks(clientId, query)
      if (res.ok) {
        setTasks(res.data || [])
      } else {
        alert('Search failed: ' + res.error)
      }
      setLoading(false)
    }, 300)
    return () => clearTimeout(t)
  }, [query, clientId])

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="bg-card w-full sm:max-w-xl rounded-t-2xl sm:rounded-2xl border border-border shadow-xl p-5 sm:p-6 max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold">Link existing task</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground"><X className="w-4 h-4" /></button>
        </div>
        
        <div className="mb-4">
          <input
            autoFocus
            type="text"
            placeholder="Search by title or #number…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="w-full h-10 px-3 rounded-lg border border-border bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>

        <div className="flex-1 overflow-y-auto min-h-[300px] border border-border/50 rounded-lg bg-secondary/20">
          {loading ? (
            <div className="p-6 text-center text-sm text-muted-foreground flex flex-col items-center justify-center h-full">
              <Loader2 className="w-5 h-5 animate-spin mb-2" />
              Searching tasks…
            </div>
          ) : tasks.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground h-full flex items-center justify-center">
              No tasks found.
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {tasks.map(t => (
                <div key={t.id} className="p-3 flex items-center justify-between hover:bg-secondary/40 transition-colors">
                  <div className="min-w-0 pr-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="font-medium text-sm truncate text-foreground">{t.title}</span>
                      {t.task_number && <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground shrink-0">#{t.task_number}</span>}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground/80">
                      <span>{formatTaskDate(t.task_date)}</span>
                      <span>·</span>
                      <span className="capitalize">{t.status.replace(/_/g, ' ')}</span>
                    </div>
                  </div>
                  <button
                    disabled={!!linking}
                    onClick={async () => {
                      setLinking(t.id)
                      const res = await linkTaskToAgreementItem(agreementId, itemId, t.id)
                      setLinking(null)
                      if (res.ok) {
                        toaster.success('Task linked')
                        onClose()
                      } else {
                        toaster.error(res.error || 'Failed to link')
                      }
                    }}
                    className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                  >
                    {linking === t.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Link'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}

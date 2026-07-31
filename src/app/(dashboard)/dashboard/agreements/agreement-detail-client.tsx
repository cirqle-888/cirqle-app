'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Combobox from '@/components/ui/combobox'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { useToast, ToastContainer } from '@/components/ui/toast'
import {
  ArrowLeft, Calendar, FileSignature, Plus, Pencil, Trash2, Loader2, Check, X,
  Play, Pause, CheckCircle2, Ban, RotateCcw, MessageSquarePlus, Clock, ExternalLink, Wallet, Layers,
} from 'lucide-react'
import {
  AGREEMENT_STATUS_CHIP, STATUS_LABEL, COMMITMENT_TYPES, CYCLES, CARRY_RULES,
  RENEWAL_TYPES, VISIBILITY_TYPES,
  type AgreementStatus, type CommitmentType, type Cycle, type CarryForwardRule,
  type RenewalType, type Visibility,
} from '@/lib/agreements/types'
import {
  saveAgreementItem, changeAgreementItemTerms, deleteAgreementItem, toggleMilestone,
  setAgreementStatus, updateAgreementDetails, deleteAgreement, addAgreementNote,
  type AgreementItemInput, type AgreementDeliverableInput, type AgreementMilestoneInput,
} from './actions'
import type { RetainerAnalytics } from '@/lib/agreements/analytics'

// ─── Constants ───────────────────────────────────────────────────────────────

const CONTENT_TYPES = [
  'post', 'reel', 'story', 'carousel', 'video', 'flyer', 'poster', 'blog', 'seo', 'ad', 'email', 'other',
]

const inputCls = 'w-full bg-secondary border border-foreground/15 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20'
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

type ItemForm = AgreementItemInput & { _mode: 'create' | 'edit' | 'change_terms' }

// ─── Helpers ─────────────────────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10)

function itemHeadline(it: { deliverables: Deliverable[]; committed_quantity: number | null }) {
  if (it.deliverables.length > 0) return it.deliverables.reduce((s, d) => s + Number(d.committed_quantity || 0), 0)
  return Number(it.committed_quantity || 0)
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
  agreement, items: initialItems, events: initialEvents, progress, analytics, currentMonth,
  services, canManage, canViewPricing,
}: {
  agreement: Agreement
  items: Item[]
  events: EventRow[]
  progress: any | null
  analytics: RetainerAnalytics | null
  currentMonth: string
  services: { id: string; name: string }[]
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
  const transitions = TRANSITIONS[agreement.status] || []
  const isDraft = agreement.status === 'draft' || agreement.status === 'pending_approval'

  async function refresh() { router.refresh() }

  async function handleStatus(to: AgreementStatus, label: string) {
    if ((to === 'cancelled') && !confirm(`${label} this agreement?`)) return
    setBusy('status')
    const res = await setAgreementStatus(agreement.id, to)
    setBusy(null)
    if (res.ok) { success(`Agreement ${label.toLowerCase()}d`); refresh() }
    else toastError('Could not update status', res.error)
  }

  async function handleDeleteAgreement() {
    if (!confirm('Delete this agreement? It will be archived (soft-deleted).')) return
    setBusy('delete')
    const res = await deleteAgreement(agreement.id)
    setBusy(null)
    if (res.ok) { success('Agreement deleted'); router.push('/dashboard/agreements') }
    else toastError('Delete failed', res.error)
  }

  async function handleDeleteItem(it: Item) {
    if (!confirm('Remove this item and its deliverables?')) return
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

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8 max-w-7xl mx-auto w-full">
      {/* Back */}
      <div className="flex items-center gap-4 text-sm">
        <Link href="/dashboard/agreements" className="flex items-center text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back to Agreements
        </Link>
      </div>

      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1 flex-wrap">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">{agreement.title}</h1>
            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${AGREEMENT_STATUS_CHIP[agreement.status]}`}>
              {STATUS_LABEL[agreement.status] || agreement.status}
            </span>
          </div>
          <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
            <span>{agreement.agreement_number}</span>
            <span>•</span>
            {agreement.client && (
              <Link href={`/dashboard/clients/${agreement.client.id}`} className="hover:text-foreground hover:underline">
                {agreement.client.name}
              </Link>
            )}
            <span>•</span>
            <span className="flex items-center">
              <Calendar className="w-3.5 h-3.5 mr-1" />
              {agreement.start_date} &rarr; {agreement.end_date || 'Ongoing'}
            </span>
            <span>•</span>
            <span className="capitalize">Renewal: {agreement.renewal_type}</span>
            {agreement.signed_document_url && (
              <>
                <span>•</span>
                <a href={agreement.signed_document_url} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline">
                  Signed doc <ExternalLink className="w-3 h-3" />
                </a>
              </>
            )}
          </div>
        </div>

        {canManage && (
          <div className="flex items-center gap-2 flex-wrap">
            {transitions.map(t => (
              <button key={t.to} onClick={() => handleStatus(t.to, t.label)} disabled={busy === 'status'}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg bg-secondary border border-border hover:bg-secondary/70 transition-colors disabled:opacity-50">
                <t.icon className={`w-3.5 h-3.5 ${t.tone}`} /> {t.label}
              </button>
            ))}
            <button onClick={() => setEditHeader(true)}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg bg-secondary border border-border hover:bg-secondary/70 transition-colors">
              <Pencil className="w-3.5 h-3.5" /> Edit
            </button>
            <button onClick={handleDeleteAgreement} disabled={busy === 'delete'} title="Delete agreement"
              className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-2 rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-500 transition-colors disabled:opacity-50">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {agreement.notes && (
        <p className="text-sm text-muted-foreground -mt-2 max-w-3xl">{agreement.notes}</p>
      )}

      {/* Progress overview */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: `Committed (${currentMonth})`, value: progress?.totalCommitted ?? 0, tone: '' },
          { label: 'Planned', value: progress?.totalPlanned ?? 0, tone: 'text-blue-600' },
          { label: 'Delivered', value: progress?.totalDelivered ?? 0, tone: 'text-green-600' },
          { label: 'Remaining', value: progress?.totalRemaining ?? 0, tone: 'text-amber-600' },
        ].map(card => (
          <div key={card.label} className="bg-card border rounded-xl p-5 shadow-sm">
            <div className="text-xs font-medium text-muted-foreground mb-1">{card.label}</div>
            <div className={`text-3xl font-bold ${card.tone}`}>{card.value}</div>
          </div>
        ))}
      </div>
      {progress == null && agreement.status === 'active' && (
        <p className="text-xs text-muted-foreground -mt-3">
          No progress yet for {currentMonth} — figures populate as calendar items and tasks are delivered.
        </p>
      )}

      {/* Retainer analytics dashboard (Phase 3c) — reuses the analytics engine */}
      {analytics && (
        <AgreementAnalyticsBlock a={analytics} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Items */}
        <div className="lg:col-span-2 rounded-xl border bg-card text-card-foreground shadow-sm">
          <div className="p-5 border-b flex justify-between items-center">
            <h3 className="font-semibold text-lg flex items-center gap-2">
              <FileSignature className="w-5 h-5 text-muted-foreground" /> Agreement Items
            </h3>
            {canManage && (
              <button onClick={() => setItemForm(newItemForm(currency))}
                className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
                <Plus className="w-4 h-4" /> Add item
              </button>
            )}
          </div>

          {initialItems.length === 0 ? (
            <div className="p-10 text-center text-muted-foreground">
              <p>No items yet.</p>
              {canManage && <p className="text-sm mt-1">Add a retainer or one-time package to define what is committed.</p>}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {initialItems.map(it => (
                <ItemCard
                  key={it.id} it={it} currency={currency} canManage={canManage}
                  canViewPricing={canViewPricing} isDraft={isDraft} serviceName={serviceName}
                  busy={busy}
                  onEdit={() => setItemForm(itemToForm(it, agreement.status))}
                  onChangeTerms={() => setItemForm(itemToForm(it, agreement.status, true))}
                  onDelete={() => handleDeleteItem(it)}
                  onToggleMilestone={handleToggleMilestone}
                />
              ))}
            </div>
          )}
        </div>

        {/* Timeline */}
        <div className="rounded-xl border bg-card text-card-foreground shadow-sm">
          <div className="p-5 border-b flex justify-between items-center">
            <h3 className="font-semibold text-lg flex items-center gap-2">
              <Clock className="w-5 h-5 text-muted-foreground" /> Timeline
            </h3>
            {canManage && (
              <button onClick={() => setNoteOpen(true)}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg bg-secondary border border-border hover:bg-secondary/70 transition-colors">
                <MessageSquarePlus className="w-3.5 h-3.5" /> Note
              </button>
            )}
          </div>
          {initialEvents.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">No activity yet.</div>
          ) : (
            <ul className="p-4 space-y-4 max-h-[520px] overflow-y-auto">
              {initialEvents.map(ev => (
                <li key={ev.id} className="flex gap-3">
                  <div className="mt-1 w-2 h-2 rounded-full bg-primary/60 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      {EVENT_LABEL[ev.action] || ev.action}
                      {ev.visibility === 'client' && (
                        <span className="ml-2 text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 border border-blue-500/20">Client</span>
                      )}
                    </p>
                    {ev.detail?.text && <p className="text-sm text-muted-foreground mt-0.5 break-words">{ev.detail.text}</p>}
                    <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                      {ev.actor_label ? `${ev.actor_label} · ` : ''}{new Date(ev.created_at).toLocaleString()}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
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

      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}

// ─── Agreement analytics dashboard (Phase 3c) ────────────────────────────────

const AN_HEALTH_DOT: Record<string, string> = { green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500' }
const AN_HEALTH_LABEL: Record<string, string> = { green: 'On track', amber: 'Near limit', red: 'Exceeded' }
const AN_FIN: Record<string, string> = {
  healthy: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  loss: 'text-red-600 dark:text-red-400',
}
const AN_FIN_LABEL: Record<string, string> = { healthy: 'Healthy', warning: 'Warning', loss: 'Loss-making' }

function AgreementAnalyticsBlock({ a }: { a: RetainerAnalytics }) {
  const cur = a.currency
  const native = (n: number | null | undefined) => n == null ? null : `${cur} ${Math.round(n).toLocaleString('en-US')}`
  const inr = (n: number | null | undefined) => n == null ? null : `₹${Math.round(n).toLocaleString('en-IN')}`
  const cells: { label: string; value: string; tone?: string }[] = []
  if (a.monthlyRetainer != null) cells.push({ label: 'Monthly retainer', value: native(a.monthlyRetainer)! })
  if (a.creativeAllocation != null) cells.push({ label: 'Creative allocation', value: native(a.creativeAllocation)! })
  if (a.managementAllocation != null) cells.push({ label: 'Management allocation', value: native(a.managementAllocation)! })
  if (a.allocatedUnitValue != null) cells.push({ label: 'Allocated unit value', value: `${native(a.allocatedUnitValue)} /unit` })
  if (a.allocatedValueDelivered != null) cells.push({ label: 'Value delivered', value: native(a.allocatedValueDelivered)! })
  if (a.allocatedValueRemaining != null) cells.push({ label: 'Value remaining', value: native(a.allocatedValueRemaining)! })
  if (a.internalCost != null) cells.push({ label: 'Internal cost', value: inr(a.internalCost)! })
  if (a.grossMargin != null) cells.push({ label: 'Est. gross margin', value: `${inr(a.grossMargin)}${a.marginPct != null ? ` · ${a.marginPct}%` : ''}`, tone: AN_FIN[a.financialHealth || 'healthy'] })

  return (
    <div className="rounded-xl border bg-card p-5 shadow-sm">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <h3 className="font-semibold text-sm flex items-center gap-1.5"><Wallet className="w-4 h-4 text-muted-foreground" /> Retainer Analytics <span className="text-[11px] font-normal text-muted-foreground">· {a.currency}</span></h3>
        <div className="flex items-center gap-3 text-xs">
          <span className="inline-flex items-center gap-1.5"><span className={`w-2 h-2 rounded-full ${AN_HEALTH_DOT[a.coverageHealth]}`} />{AN_HEALTH_LABEL[a.coverageHealth]}</span>
          {a.financialHealth && <span className={AN_FIN[a.financialHealth]}>{AN_FIN_LABEL[a.financialHealth]}</span>}
        </div>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
        <span>Utilisation · {a.delivered}/{a.included} delivered{a.extraTasks > 0 ? ` · ${a.extraTasks} extra` : ''}</span>
        <span className="font-semibold text-foreground">{a.utilisation}%</span>
      </div>
      <div className="h-2 w-full rounded-full bg-secondary overflow-hidden mb-4">
        <div className={`h-full rounded-full ${AN_HEALTH_DOT[a.coverageHealth]}`} style={{ width: `${Math.min(100, a.utilisation)}%` }} />
      </div>

      {cells.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {cells.map(c => (
            <div key={c.label}>
              <div className="text-[10px] text-muted-foreground">{c.label}</div>
              <div className={`text-sm font-semibold tabular-nums ${c.tone || ''}`}>{c.value}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Item card ───────────────────────────────────────────────────────────────

function ItemCard({
  it, currency, canManage, canViewPricing, isDraft, serviceName, busy,
  onEdit, onChangeTerms, onDelete, onToggleMilestone,
}: {
  it: Item; currency: string; canManage: boolean; canViewPricing: boolean; isDraft: boolean
  serviceName: Map<string, string>; busy: string | null
  onEdit: () => void; onChangeTerms: () => void; onDelete: () => void
  onToggleMilestone: (m: Milestone) => void
}) {
  const headline = itemHeadline(it)
  const typeLabel = COMMITMENT_TYPES.find(t => t.value === it.commitment_type)?.label
  return (
    <div className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-foreground">
              {it.service_id ? serviceName.get(it.service_id) || 'Service' : 'General'}
            </span>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-purple-500/12 text-purple-700 dark:text-purple-300 border border-purple-500/25">
              {typeLabel}{it.commitment_type === 'retainer' && it.cycle ? ` · ${it.cycle}` : ''}
            </span>
            {headline > 0 && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border">
                {headline} committed{it.commitment_type === 'retainer' ? '/cycle' : ''}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {it.effective_from} → {it.effective_to || 'current'}
            {canViewPricing && it.unit_price != null ? ` · ${currency} ${it.unit_price}` : ''}
            {it.notes ? ` · ${it.notes}` : ''}
          </p>
        </div>
        {canManage && (
          <div className="flex items-center gap-1 shrink-0">
            {isDraft ? (
              <button onClick={onEdit} title="Edit" className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
                <Pencil className="w-3.5 h-3.5" />
              </button>
            ) : (
              <button onClick={onChangeTerms} title="Change terms"
                className="text-[11px] px-2 py-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
                Change terms
              </button>
            )}
            {isDraft && (
              <button onClick={onDelete} disabled={busy === 'item:' + it.id} title="Remove"
                className="p-1.5 rounded-md hover:bg-red-500/10 text-muted-foreground hover:text-red-500 transition-colors disabled:opacity-50">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Internal allocation summary (retainer, operational only) */}
      {canViewPricing && it.commitment_type === 'retainer' &&
        (it.creative_allocation_amount != null || it.management_allocation_amount != null) && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs bg-secondary/30 rounded-lg px-3 py-2">
          <span className="font-medium text-muted-foreground">Internal allocation</span>
          {it.creative_allocation_amount != null && (
            <span>Creative <b>{currency} {it.creative_allocation_amount}</b></span>
          )}
          {it.management_allocation_amount != null && (
            <span>Management <b>{currency} {it.management_allocation_amount}</b></span>
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
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
          {it.deliverables.map((d, i) => (
            <div key={d.id || i} className="flex items-center justify-between gap-2 text-sm bg-secondary/40 rounded-lg px-3 py-2">
              <span className="truncate">{d.label}</span>
              <span className="text-muted-foreground shrink-0">{d.committed_quantity}</span>
            </div>
          ))}
        </div>
      )}

      {/* Milestones */}
      {it.milestones.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {it.milestones.map((m, i) => {
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
    coveredServiceIds: [],
    deliverables: [], milestones: [],
  }
}

function itemToForm(it: Item, status: AgreementStatus, changeTerms = false): ItemForm {
  const active = status !== 'draft' && status !== 'pending_approval'
  return {
    _mode: changeTerms || active ? 'change_terms' : 'edit',
    id: it.id,
    service_id: it.service_id, commitment_type: it.commitment_type,
    committed_quantity: it.committed_quantity, cycle: it.cycle,
    effective_from: changeTerms || active ? today() : it.effective_from,
    effective_to: it.effective_to,
    unit_price: it.unit_price ?? null, currency: it.currency || 'INR',
    carry_forward_rule: it.carry_forward_rule, extra_unit_price: it.extra_unit_price ?? null,
    display_order: it.display_order, notes: it.notes,
    creative_allocation_amount: it.creative_allocation_amount ?? null,
    management_allocation_amount: it.management_allocation_amount ?? null,
    included_quantity: it.included_quantity ?? null,
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
    <div className="mt-5 rounded-xl border border-border bg-secondary/20 p-4">
      <div className="flex items-center justify-between mb-1">
        <p className="text-sm font-semibold flex items-center gap-1.5">
          <Wallet className="w-4 h-4 text-muted-foreground" /> Internal Allocation
        </p>
        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border">Operational only</span>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Split the {currency} {retainer ?? '—'} monthly retainer internally. This is never billed to the client and never becomes an invoice line.
      </p>

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
    <div className="mt-5 rounded-xl border border-border bg-secondary/20 p-4">
      <div className="flex items-center justify-between mb-1">
        <p className="text-sm font-semibold flex items-center gap-1.5">
          <Layers className="w-4 h-4 text-muted-foreground" /> Covered Services
        </p>
        <span className="text-[11px] text-muted-foreground">{selected.size} selected</span>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Tasks on any of these services are covered by this retainer — no client billing (extra work can still be flagged per task).
      </p>
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
    </div>
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
      coveredServiceIds: form.commitment_type === 'retainer' ? (form.coveredServiceIds ?? []) : undefined,
      deliverables: form.deliverables.map((d, i) => ({ ...d, committed_quantity: Number(d.committed_quantity) || 0, display_order: i })),
      milestones: form.milestones.map((m, i) => ({ ...m, display_order: i })),
    }
    const res = changeTerms && form.id
      ? await changeAgreementItemTerms(agreementId, form.id, payload)
      : await saveAgreementItem(agreementId, payload)
    setSaving(false)
    if (res.ok) onSaved()
    else onError(res.ok ? '' : res.error)
  }

  const title = form._mode === 'create' ? 'Add item' : changeTerms ? 'Change terms' : 'Edit item'

  return (
    <ModalOverlay onClose={() => !saving && setForm(null)} sheetOnMobile>
      <div className="bg-card w-full sm:max-w-2xl rounded-t-2xl sm:rounded-2xl border border-border shadow-xl p-5 sm:p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold">{title}</h2>
          <button onClick={() => setForm(null)} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground"><X className="w-4 h-4" /></button>
        </div>

        {changeTerms && (
          <div className="mb-4 text-xs bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2 text-amber-700 dark:text-amber-300">
            This agreement is active. Saving closes the current term and starts a new one from the effective date — past months keep their original terms.
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>Service <span className="text-muted-foreground/60">(optional)</span></label>
            <Combobox options={services.map(s => ({ id: s.id, label: s.name }))}
              value={form.service_id || ''} onChange={id => set({ service_id: id || null })}
              placeholder="Search service…" sortKey="services" />
          </div>
          <div>
            <label className={labelCls}>Commitment</label>
            <select value={form.commitment_type}
              onChange={e => set({ commitment_type: e.target.value as CommitmentType, cycle: e.target.value === 'retainer' ? (form.cycle || 'monthly') : null })}
              className={inputCls}>
              {COMMITMENT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
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
            <label className={labelCls}>Committed quantity <span className="text-muted-foreground/60">(headline)</span></label>
            <input type="number" min="0" step="any" value={form.committed_quantity ?? ''}
              onChange={e => set({ committed_quantity: e.target.value === '' ? null : parseFloat(e.target.value) })}
              placeholder="Used when no deliverables below" className={inputCls} />
          </div>

          <div>
            <label className={labelCls}>Effective from</label>
            <input type="date" value={form.effective_from} onChange={e => set({ effective_from: e.target.value })} className={inputCls} />
          </div>
          {!changeTerms && (
            <div>
              <label className={labelCls}>Effective to <span className="text-muted-foreground/60">(optional)</span></label>
              <input type="date" value={form.effective_to || ''} onChange={e => set({ effective_to: e.target.value || null })} className={inputCls} />
            </div>
          )}

          {canViewPricing && (
            <>
              <div>
                <label className={labelCls}>{isRetainer ? 'Monthly retainer' : 'Package fee'} ({currency})</label>
                <input type="number" min="0" step="any" value={form.unit_price ?? ''}
                  onChange={e => set({ unit_price: e.target.value === '' ? null : parseFloat(e.target.value) })} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Extra-unit price <span className="text-muted-foreground/60">(optional)</span></label>
                <input type="number" min="0" step="any" value={form.extra_unit_price ?? ''}
                  onChange={e => set({ extra_unit_price: e.target.value === '' ? null : parseFloat(e.target.value) })}
                  placeholder="Blank = extra work not auto-billable" className={inputCls} />
              </div>
            </>
          )}

          {isRetainer && (
            <div>
              <label className={labelCls}>Carry-forward</label>
              <select value={form.carry_forward_rule} onChange={e => set({ carry_forward_rule: e.target.value as CarryForwardRule })} className={inputCls}>
                {CARRY_RULES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
          )}

          <div className="sm:col-span-2">
            <label className={labelCls}>Notes <span className="text-muted-foreground/60">(optional)</span></label>
            <input value={form.notes || ''} onChange={e => set({ notes: e.target.value })} className={inputCls} placeholder="Item context…" />
          </div>
        </div>

        {/* Internal Allocation (retainer only) — operational split, never billing */}
        {isRetainer && canViewPricing && (
          <AllocationEditor form={form} set={set} currency={currency} />
        )}

        {/* Covered services (retainer only) — a retainer can cover many services */}
        {isRetainer && (
          <CoveredServicesEditor form={form} set={set} services={services} />
        )}

        {/* Deliverables */}
        <div className="mt-5">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold">Deliverables</p>
            <button onClick={() => set({ deliverables: [...form.deliverables, { label: '', content_types: [], committed_quantity: 0, display_order: form.deliverables.length }] })}
              className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-md bg-secondary hover:bg-secondary/70 transition-colors">
              <Plus className="w-3.5 h-3.5" /> Add
            </button>
          </div>
          {form.deliverables.length === 0 && <p className="text-xs text-muted-foreground/70">No typed deliverables — the headline quantity is used.</p>}
          <div className="space-y-3">
            {form.deliverables.map((d, i) => (
              <div key={i} className="rounded-lg border border-border p-3 bg-secondary/20">
                <div className="flex gap-2 items-start">
                  <input value={d.label} onChange={e => setDeliverable(i, { label: e.target.value })} placeholder="Label e.g. Feed Posts" className={inputCls + ' flex-1'} />
                  <input type="number" min="0" step="any" value={d.committed_quantity}
                    onChange={e => setDeliverable(i, { committed_quantity: parseFloat(e.target.value) || 0 })}
                    placeholder="Qty" className={inputCls + ' w-24'} />
                  <button onClick={() => set({ deliverables: form.deliverables.filter((_, x) => x !== i) })}
                    className="p-2 rounded-md hover:bg-red-500/10 text-muted-foreground hover:text-red-500 transition-colors shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2">
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
        </div>

        {/* Milestones */}
        <div className="mt-5">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold">Milestones</p>
            <button onClick={() => set({ milestones: [...form.milestones, { label: '', display_order: form.milestones.length, due_date: null, visibility: 'internal' }] })}
              className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-md bg-secondary hover:bg-secondary/70 transition-colors">
              <Plus className="w-3.5 h-3.5" /> Add
            </button>
          </div>
          {form.milestones.length === 0 && <p className="text-xs text-muted-foreground/70">Optional — steps for one-time projects (Research → Concept → Final Files).</p>}
          <div className="space-y-2">
            {form.milestones.map((m, i) => (
              <div key={i} className="flex gap-2 items-center">
                <input value={m.label} onChange={e => setMilestone(i, { label: e.target.value })} placeholder="Milestone" className={inputCls + ' flex-1'} />
                <input type="date" value={m.due_date || ''} onChange={e => setMilestone(i, { due_date: e.target.value || null })} className={inputCls + ' w-40'} />
                <select value={m.visibility} onChange={e => setMilestone(i, { visibility: e.target.value as Visibility })} className={inputCls + ' w-32'}>
                  {VISIBILITY_TYPES.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
                </select>
                <button onClick={() => set({ milestones: form.milestones.filter((_, x) => x !== i) })}
                  className="p-2 rounded-md hover:bg-red-500/10 text-muted-foreground hover:text-red-500 transition-colors shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            ))}
          </div>
        </div>

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

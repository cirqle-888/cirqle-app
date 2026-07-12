'use client'

import { useState } from 'react'
import {
  DndContext, closestCenter, PointerSensor, TouchSensor,
  useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, verticalListSortingStrategy,
  useSortable, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Send, Loader2, CheckCircle2, Plus, X, Link2, ChevronDown, ChevronUp,
  Clock, RefreshCw, MessageSquarePlus, CalendarDays, FolderOpen,
  Pencil, Ban, GripVertical, Eye, AlertCircle, ArrowLeft,
} from 'lucide-react'
import Link from 'next/link'
import { CLIENT_STATUS_LABEL } from '@/lib/requests/core'
import { IntakeAppSwitcher } from '@/components/intake/app-switcher'
import {
  submitIntakeRequest, getExternalTimeline, addRequestLink,
  updateRequestRemarks, submitRevisionRequest, getMyRequests,
  reorderMyRequests, updateRequestField, cancelMyRequest,
  type IntakeSubmitInput, type EditableField,
} from './actions'

const inputCls = 'w-full bg-secondary border border-foreground/15 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20'
const labelCls = 'block text-xs font-medium text-muted-foreground mb-1.5'

const STATUS_CLS: Record<string, string> = {
  submitted:           'bg-blue-500/12 text-blue-400 border-blue-500/25',
  under_review:        'bg-blue-500/12 text-blue-400 border-blue-500/25',
  approved:            'bg-blue-500/12 text-blue-400 border-blue-500/25',
  started:             'bg-green-500/12 text-green-400 border-green-500/25',
  in_progress:         'bg-green-500/12 text-green-400 border-green-500/25',
  waiting_for_content: 'bg-orange-500/12 text-orange-400 border-orange-500/25',
  revision_requested:  'bg-orange-500/12 text-orange-400 border-orange-500/25',
  delivered:           'bg-violet-500/12 text-violet-300 border-violet-500/25',
  completed:           'bg-emerald-500/12 text-emerald-400 border-emerald-500/25',
  cancelled:           'bg-red-500/10 text-red-400/80 border-red-500/20',
}

const fmtDate = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''
const fmtDateTime = (d: string) =>
  new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

const emptyForm = (): IntakeSubmitInput => ({
  title: '', description: '', remarks: '', design_plan: '', priority: 'normal',
  due_date: null, is_planned: false, content_link: '', reference_link: '',
  extra_links: [], service_id: null, submitter_name: '', submitter_email: '', website: '',
})

/** Human sentence for an external timeline entry. Staff posts are attributed. */
function activityText(a: any): string {
  const d = a.detail || {}
  const fromCirqle = a.actor_type === 'admin' || a.actor_type === 'system'
  switch (a.action) {
    case 'submitted':          return 'Request submitted'
    case 'status_changed':     return `Status: ${CLIENT_STATUS_LABEL[d.to] || d.to || 'updated'}`
    case 'link_added':         return `Added link — ${d.label || d.url || ''}`
    case 'field_changed':      return d.field === 'remarks' ? 'Updated remarks' : `Updated ${d.field || 'details'}`
    case 'revision_requested': return `Revision requested${d.message ? ` — “${d.message}”` : ''}`
    case 'note':               return `${fromCirqle ? 'Cirqle: ' : ''}${d.message || 'Update'}`
    default:                   return a.action.replace(/_/g, ' ')
  }
}

/** Externally-open statuses. `delivered` (Under Review) stays open so the
 *  client can see the work is waiting on their review. Only Completed/
 *  Cancelled fall into the closed list. */
const OPEN_SET = new Set(['submitted', 'under_review', 'approved', 'started', 'in_progress', 'waiting_for_content', 'revision_requested', 'delivered'])

function SortableIntakeItem({ id, children }: {
  id: string
  children: (handle: React.ReactNode) => React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.55 : undefined,
        zIndex: isDragging ? 10 : undefined,
        position: isDragging ? 'relative' : undefined,
      }}
    >
      {children(
        <div
          {...attributes} {...listeners}
          className="cursor-grab active:cursor-grabbing p-1 text-muted-foreground/40 hover:text-muted-foreground/70 touch-none select-none"
          title="Hold and drag to reorder"
        >
          <GripVertical className="w-4 h-4" />
        </div>
      )}
    </div>
  )
}

/** Auto-grow a textarea with its content, capped at 600px (then scrolls).
 *  Keeps the initial min-height from the className. */
function autoGrow(e: React.FormEvent<HTMLTextAreaElement>) {
  const el = e.currentTarget
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight + 2, 600)}px`
}

export default function IntakeClient({
  token, linkType, requesterName, services, initialRequests,
  logoUrl, lastTaskTitle, driveFolderLink, switcher, hub,
}: {
  token: string
  linkType: 'client' | 'agency' | 'generic'
  requesterName: string | null
  services: { id: string; name: string }[]
  initialRequests: any[]
  logoUrl?: string | null
  lastTaskTitle?: string | null
  driveFolderLink?: string | null
  switcher?: { kind: string; label: string; href: string }[]
  hub?: string
}) {
  // Single-window layout: collapsible submit form on top, requests list below.
  // The form starts open for first-time visitors (no requests yet).
  const [formOpen, setFormOpen] = useState(initialRequests.length === 0)
  const [form, setForm] = useState<IntakeSubmitInput>(emptyForm())
  const [extraLabel, setExtraLabel] = useState('')
  const [extraUrl, setExtraUrl] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [sentRef, setSentRef] = useState<string | null>(null)
  const [requests, setRequests] = useState<any[]>(initialRequests)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<Record<string, any[]>>({})
  const [actionBox, setActionBox] = useState<{ id: string; kind: 'link' | 'remarks' | 'revision' | 'field'; field?: EditableField } | null>(null)
  const [actionText, setActionText] = useState('')
  const [actionUrl, setActionUrl] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const [intakeEditRank, setIntakeEditRank] = useState<{ id: string; val: string } | null>(null)

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  )

  async function refreshRequests() {
    const res = await getMyRequests(token)
    if (res.ok && res.data) setRequests(res.data.rows)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSending(true); setError('')
    const res = await submitIntakeRequest(token, form)
    setSending(false)
    if (res.ok && res.data) {
      setSentRef(res.data.ref)
      setForm(emptyForm())
      setFormOpen(false)
      void refreshRequests()
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } else setError(res.error || 'Something went wrong. Please try again.')
  }

  async function toggleExpand(id: string) {
    if (expanded === id) { setExpanded(null); return }
    setExpanded(id)
    if (!timeline[id]) {
      const res = await getExternalTimeline(token, id)
      if (res.ok && res.data) setTimeline(t => ({ ...t, [id]: res.data!.rows }))
    }
  }

  // ── Priority ranking (open requests, 1 = first) ────────────────────────────
  const openRequests = requests
    .filter(r => OPEN_SET.has(r.client_status))
    .sort((a, b) => (a.priority_rank ?? 999) - (b.priority_rank ?? 999) || (a.created_at || '').localeCompare(b.created_at || ''))
  const closedRequests = requests.filter(r => !OPEN_SET.has(r.client_status))

  function handleIntakeDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = openRequests.findIndex(r => r.id === active.id)
    const newIndex = openRequests.findIndex(r => r.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const newOrder = arrayMove(openRequests, oldIndex, newIndex)
    const rankMap = new Map(newOrder.map((r, i) => [r.id, i + 1]))
    setRequests(prev => prev.map(r => rankMap.has(r.id) ? { ...r, priority_rank: rankMap.get(r.id) } : r))
    void reorderMyRequests(token, newOrder.map(r => r.id))
  }

  function applyIntakeManualRank(id: string, targetPos: number) {
    const n = Math.max(1, Math.min(openRequests.length, Math.round(targetPos)))
    const currentIndex = openRequests.findIndex(r => r.id === id)
    if (currentIndex < 0) return
    const newOrder = arrayMove(openRequests, currentIndex, n - 1)
    const rankMap = new Map(newOrder.map((r, i) => [r.id, i + 1]))
    setRequests(prev => prev.map(r => rankMap.has(r.id) ? { ...r, priority_rank: rankMap.get(r.id) } : r))
    void reorderMyRequests(token, newOrder.map(r => r.id))
    setIntakeEditRank(null)
  }

  /** Statuses the requester can still cancel (work not started yet). */
  const CANCELLABLE = ['submitted', 'under_review', 'approved', 'waiting_for_content', 'revision_requested']

  function openField(r: any, field: EditableField) {
    setActionBox({ id: r.id, kind: 'field', field })
    setActionText(String(r[field] ?? '')); setActionUrl('')
  }

  async function handleCancel(r: any) {
    if (!confirm(`Cancel "${r.title}"? This tells Cirqle not to work on it.`)) return
    const res = await cancelMyRequest(token, r.id)
    if (res.ok) {
      void refreshRequests()
      setTimeline(t => { const n = { ...t }; delete n[r.id]; return n })
    } else alert(res.error || 'Could not cancel.')
  }

  async function runAction() {
    if (!actionBox) return
    setActionBusy(true)
    let res: { ok: boolean; error?: string }
    if (actionBox.kind === 'link') res = await addRequestLink(token, actionBox.id, actionText, actionUrl)
    else if (actionBox.kind === 'remarks') res = await updateRequestRemarks(token, actionBox.id, actionText)
    else if (actionBox.kind === 'field') res = await updateRequestField(token, actionBox.id, actionBox.field!, actionText)
    else res = await submitRevisionRequest(token, actionBox.id, actionText, actionUrl)
    setActionBusy(false)
    if (res.ok) {
      setActionBox(null); setActionText(''); setActionUrl('')
      setTimeline(t => { const n = { ...t }; delete n[actionBox.id]; return n })
      void refreshRequests()
      if (expanded === actionBox.id) {
        const tl = await getExternalTimeline(token, actionBox.id)
        if (tl.ok && tl.data) setTimeline(t => ({ ...t, [actionBox.id]: tl.data!.rows }))
      }
    } else alert(res.error || 'Could not save.')
  }

  return (
    <div className="max-w-3xl lg:max-w-6xl mx-auto px-4 py-8 sm:py-12">
      {hub && (
        <Link href={`/start/${hub}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors mb-6 group">
          <ArrowLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" /> Back to Hub
        </Link>
      )}
      {/* Brand header — workspace logo with wordmark fallback */}
      <div className="text-center mb-8">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt="Cirqle Design" className="h-12 mx-auto object-contain" />
        ) : (
          <>
            <div className="text-3xl font-extrabold tracking-tight">cirqle<span className="text-blue-400">.</span></div>
            <div className="text-[10px] tracking-[0.3em] text-muted-foreground uppercase mt-0.5">Design</div>
          </>
        )}
        <h1 className="text-lg font-bold mt-5">
          {requesterName ? `Welcome, ${requesterName}` : 'Submit a request'}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Send us your {linkType === 'agency' ? 'campaign and design requests' : 'design requests'} and track their progress.
        </p>
        {switcher && <IntakeAppSwitcher options={switcher} current="request_portal" />}
      </div>

      {/* Success banner (after submit) */}
      {sentRef && (
        <div className="bg-card border border-green-500/30 rounded-2xl px-4 py-3.5 mb-4 flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5 text-green-400 shrink-0" />
          <p className="text-sm flex-1">Request received — <b>{sentRef}</b>. We&apos;ll review it shortly; track it below.</p>
          <button onClick={() => setSentRef(null)} className="p-1 rounded text-muted-foreground hover:text-foreground shrink-0"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* ── Header row: requests are the main content; New Request is a button ── */}
      <div className="flex items-center justify-between gap-3 mb-3 px-1">
        <h2 className="text-base font-bold">Your requests ({requests.length})</h2>
        <button
          onClick={() => { setFormOpen(o => !o); setSentRef(null) }}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold transition-all shrink-0 ${
            formOpen ? 'bg-secondary border border-border text-foreground' : 'gradient-bg text-white shadow hover:opacity-90'
          }`}>
          <Plus className={`w-4 h-4 transition-transform duration-200 ${formOpen ? 'rotate-45' : ''}`} />
          {formOpen ? 'Close' : 'New Request'}
        </button>
      </div>

      {formOpen && (
          <form onSubmit={handleSubmit} className="bg-card border border-border rounded-2xl p-4 sm:p-6 space-y-4 mb-6">
            {/* Honeypot — hidden from humans */}
            <input type="text" value={form.website || ''} onChange={e => setForm(f => ({ ...f, website: e.target.value }))}
              className="hidden" tabIndex={-1} autoComplete="off" aria-hidden="true" />

            <div>
              <label className={labelCls}>What is this task / creative about? *</label>
              <input required value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                className={inputCls} placeholder={lastTaskTitle ? `e.g. ${lastTaskTitle}` : 'e.g. Weekend Sale — Offer Flyer'} />
            </div>

            <div>
              <label className={labelCls}>Details</label>
              <textarea rows={6} value={form.description || ''} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                onInput={autoGrow}
                className={inputCls + ' resize-y min-h-[140px]'}
                placeholder={'Describe the work in as much detail as you like — sizes, formats, headings, text to include, offers, products…\n\nLong paragraphs are welcome.'} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>Service</label>
                <select value={form.service_id || ''} onChange={e => setForm(f => ({ ...f, service_id: e.target.value || null }))} className={inputCls}>
                  <option value="">Not sure / other</option>
                  {services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Needed by</label>
                <input type="date" value={form.due_date || ''} onChange={e => setForm(f => ({ ...f, due_date: e.target.value || null }))} className={inputCls} />
              </div>
              {linkType === 'agency' && (
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={!!form.is_planned} onChange={e => setForm(f => ({ ...f, is_planned: e.target.checked }))} />
                  This is a planned / future campaign
                </label>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground/70 -mt-1">
              New requests join the end of your priority list — you can reorder them any time in <b>My Requests</b>.
            </p>

            <div>
              <label className={labelCls}>Design plan / notes</label>
              <textarea rows={5} value={form.design_plan || ''} onChange={e => setForm(f => ({ ...f, design_plan: e.target.value }))}
                onInput={autoGrow}
                className={inputCls + ' resize-y min-h-[110px]'}
                placeholder={'Style direction, colours, layout ideas, references to follow…\n\nShare your full brainstorm here.'} />
            </div>

            {/* Shared Drive folder — set by Cirqle per client */}
            {driveFolderLink && (
              <div className="bg-amber-500/8 border border-amber-500/25 rounded-xl p-3.5 flex items-start gap-3">
                <FolderOpen className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-amber-300">Your shared Drive folder</p>
                  <p className="text-xs text-amber-400/80 mt-0.5">
                    Create a folder named after this request and upload your content (images, logos, text files) there.
                  </p>
                </div>
                <a href={driveFolderLink} target="_blank" rel="noreferrer"
                  className="shrink-0 text-xs font-semibold px-3 py-2 rounded-lg bg-amber-500/15 text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 transition-colors">
                  Open folder ↗
                </a>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>Content link <span className="text-muted-foreground/60">(Drive, WeTransfer…)</span></label>
                <input value={form.content_link || ''} onChange={e => setForm(f => ({ ...f, content_link: e.target.value }))}
                  className={inputCls} placeholder="https://drive.google.com/…" />
              </div>
              <div>
                <label className={labelCls}>Reference link</label>
                <input value={form.reference_link || ''} onChange={e => setForm(f => ({ ...f, reference_link: e.target.value }))}
                  className={inputCls} placeholder="https://…" />
              </div>
            </div>

            {/* Extra links */}
            {(form.extra_links || []).length > 0 && (
              <div className="space-y-1.5">
                {form.extra_links!.map((l, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs bg-secondary rounded-lg px-3 py-2">
                    <Link2 className="w-3 h-3 text-muted-foreground shrink-0" />
                    <span className="font-medium shrink-0">{l.label}</span>
                    <span className="text-muted-foreground truncate flex-1">{l.url}</span>
                    <button type="button" onClick={() => setForm(f => ({ ...f, extra_links: f.extra_links!.filter((_, j) => j !== i) }))}
                      className="text-muted-foreground hover:text-red-400"><X className="w-3 h-3" /></button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input value={extraLabel} onChange={e => setExtraLabel(e.target.value)} className={inputCls + ' !w-32'} placeholder="Label" />
              <input value={extraUrl} onChange={e => setExtraUrl(e.target.value)} className={inputCls} placeholder="https://… (more links)" />
              <button type="button" disabled={!extraUrl.trim()}
                onClick={() => { setForm(f => ({ ...f, extra_links: [...(f.extra_links || []), { label: extraLabel || 'Link', url: extraUrl }] })); setExtraLabel(''); setExtraUrl('') }}
                className="px-3 rounded-xl bg-secondary border border-foreground/15 hover:bg-secondary/70 disabled:opacity-40 transition-colors shrink-0">
                <Plus className="w-4 h-4" />
              </button>
            </div>

            {(linkType === 'generic') && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1 border-t border-border">
                <div>
                  <label className={labelCls}>Your name *</label>
                  <input required value={form.submitter_name || ''} onChange={e => setForm(f => ({ ...f, submitter_name: e.target.value }))} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Your email *</label>
                  <input required type="email" value={form.submitter_email || ''} onChange={e => setForm(f => ({ ...f, submitter_email: e.target.value }))} className={inputCls} placeholder="So we can send you a tracking link" />
                </div>
              </div>
            )}

            {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>}

            <button type="submit" disabled={sending || !form.title.trim()}
              className="w-full py-3 text-sm font-semibold rounded-xl gradient-bg text-white hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center justify-center gap-2">
              {sending ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</> : <><Send className="w-4 h-4" /> Submit request</>}
            </button>
          </form>
      )}

      {/* ── Requests list (main content) ── */}
      <div>
        <div className="space-y-2.5">
          {requests.length === 0 && (
            <div className="bg-card border border-border rounded-2xl px-6 py-10 text-center text-sm text-muted-foreground">
              No requests yet — submit your first one above!
            </div>
          )}
          {openRequests.length > 1 && (
            <p className="text-[11px] text-muted-foreground/70 px-1 flex items-center gap-1">
              <GripVertical className="w-3.5 h-3.5" /> Hold and drag to set priority — #1 is what we work on first. Tap #N to type a position.
            </p>
          )}
          <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleIntakeDragEnd}>
            <SortableContext items={openRequests.map(r => r.id)} strategy={verticalListSortingStrategy}>
              {openRequests.map(r => {
                const isOpen = expanded === r.id
                const rankIdx = openRequests.findIndex(x => x.id === r.id)
                return (
                  <SortableIntakeItem key={r.id} id={r.id}>
                    {(handle) => (
                  <div className="bg-card border border-border rounded-2xl overflow-hidden">
                    <div role="button" tabIndex={0} onClick={() => toggleExpand(r.id)}
                      onKeyDown={e => { if (e.key === 'Enter') toggleExpand(r.id) }}
                      className="w-full text-left px-4 py-3.5 flex items-center gap-3 cursor-pointer">
                      {rankIdx >= 0 && (
                        <div className="flex flex-col items-center gap-0.5 shrink-0" onClick={e => e.stopPropagation()}>
                          {handle}
                          {intakeEditRank !== null && intakeEditRank.id === r.id ? (
                            <input
                              type="number" min={1} max={openRequests.length}
                              value={intakeEditRank.val}
                              onChange={e => setIntakeEditRank({ id: r.id, val: e.target.value })}
                              onBlur={() => { const n = parseInt(intakeEditRank!.val, 10); if (!isNaN(n)) applyIntakeManualRank(r.id, n); else setIntakeEditRank(null) }}
                              onKeyDown={e => {
                                if (e.key === 'Enter') { const n = parseInt(intakeEditRank!.val, 10); if (!isNaN(n)) applyIntakeManualRank(r.id, n); else setIntakeEditRank(null) }
                                else if (e.key === 'Escape') setIntakeEditRank(null)
                              }}
                              autoFocus
                              className="w-7 text-center text-[10px] font-bold text-violet-400 bg-transparent border-b border-violet-400/50 focus:outline-none"
                            />
                          ) : (
                            <button
                              onClick={() => setIntakeEditRank({ id: r.id, val: String(rankIdx + 1) })}
                              className="text-[10px] font-bold text-violet-400 hover:text-violet-300 transition-colors"
                              title="Tap to type a priority position"
                            >#{rankIdx + 1}</button>
                          )}
                        </div>
                      )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] font-mono text-muted-foreground">REQ-{String(r.ref_no).padStart(4, '0')}</span>
                      <p className="text-sm font-semibold break-words">{r.title}</p>
                    </div>
                    <div className="flex items-center gap-2.5 mt-1 text-[11px] text-muted-foreground">
                      {r.due_date && <span className="flex items-center gap-1"><CalendarDays className="w-3 h-3" />{fmtDate(r.due_date)}</span>}
                      <span>Submitted {fmtDate(r.created_at)}</span>
                    </div>
                  </div>
                  <span className={`text-[11px] px-2.5 py-1 rounded-full border shrink-0 ${STATUS_CLS[r.client_status] || STATUS_CLS.submitted}`}>
                    {CLIENT_STATUS_LABEL[r.client_status] || 'Submitted'}
                  </span>
                  {isOpen ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
                </div>

                {isOpen && (
                  <div className="border-t border-border px-4 py-4 space-y-4">
                    {/* Action-pending banners — make it obvious when the ball is in the client's court. */}
                    {r.client_status === 'delivered' && (
                      <div className="flex items-start gap-2 text-xs font-medium text-violet-200 bg-violet-500/10 border border-violet-500/30 rounded-lg px-3 py-2.5">
                        <Eye className="w-4 h-4 shrink-0 mt-0.5" />
                        <span><strong>Under review — action needed from you.</strong> Your work is ready. Please review it and approve, or use “Request revision” below if anything needs changing.</span>
                      </div>
                    )}
                    {(r.client_status === 'waiting_for_content' || r.client_status === 'revision_requested') && (
                      <div className="flex items-start gap-2 text-xs font-medium text-orange-200 bg-orange-500/10 border border-orange-500/30 rounded-lg px-3 py-2.5">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                        <span><strong>Action needed from you.</strong> We’re waiting on something from your side to continue — please add the content or details below.</span>
                      </div>
                    )}
                    {/* Full request details — every section editable (logged to activity) */}
                    <div className="space-y-3">
                      {([
                        ['title', 'Title', r.title],
                        ['description', 'Details', r.description],
                        ['design_plan', 'Design plan', r.design_plan],
                      ] as [EditableField, string, string | null][]).map(([field, label, value]) => (
                        <div key={field}>
                          <div className="flex items-center gap-2 mb-1">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">{label}</p>
                            <button onClick={() => openField(r, field)} title={`Edit ${label.toLowerCase()}`}
                              className="p-0.5 rounded text-muted-foreground/50 hover:text-foreground transition-colors">
                              <Pencil className="w-3 h-3" />
                            </button>
                          </div>
                          {value
                            ? <p className="text-sm text-foreground/90 whitespace-pre-wrap break-words">{value}</p>
                            : <p className="text-xs text-muted-foreground/40 italic">Not added yet — tap the pencil to add.</p>}
                        </div>
                      ))}
                      {r.remarks && (
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1">Remarks</p>
                          <p className="text-sm text-foreground/90 whitespace-pre-wrap break-words">{r.remarks}</p>
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                        <CalendarDays className="w-3.5 h-3.5" /> Deadline:{' '}
                        <span className="text-foreground/90 font-medium">{r.due_date ? fmtDate(r.due_date) : 'not set'}</span>
                        <button onClick={() => openField(r, 'due_date')} title="Edit deadline"
                          className="p-0.5 rounded text-muted-foreground/50 hover:text-foreground transition-colors">
                          <Pencil className="w-3 h-3" />
                        </button>
                      </p>
                    </div>

                    {driveFolderLink && (
                      <a href={driveFolderLink} target="_blank" rel="noreferrer"
                        className="flex items-center gap-2 text-xs font-medium text-amber-300 bg-amber-500/8 border border-amber-500/25 rounded-lg px-3 py-2 hover:bg-amber-500/15 transition-colors">
                        <FolderOpen className="w-3.5 h-3.5" /> Open your Drive folder — add a folder for this request &amp; upload content ↗
                      </a>
                    )}
                    {/* Quick actions */}
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => { setActionBox({ id: r.id, kind: 'link' }); setActionText(''); setActionUrl('') }}
                        className="text-xs px-3 py-1.5 rounded-lg bg-secondary hover:bg-secondary/70 transition-colors flex items-center gap-1.5">
                        <Link2 className="w-3 h-3" /> Add link
                      </button>
                      <button onClick={() => { setActionBox({ id: r.id, kind: 'remarks' }); setActionText(r.remarks || ''); setActionUrl('') }}
                        className="text-xs px-3 py-1.5 rounded-lg bg-secondary hover:bg-secondary/70 transition-colors flex items-center gap-1.5">
                        <MessageSquarePlus className="w-3 h-3" /> Update remarks
                      </button>
                      <button onClick={() => { setActionBox({ id: r.id, kind: 'revision' }); setActionText(''); setActionUrl('') }}
                        className="text-xs px-3 py-1.5 rounded-lg bg-pink-500/10 text-pink-400 border border-pink-500/25 hover:bg-pink-500/20 transition-colors flex items-center gap-1.5">
                        <RefreshCw className="w-3 h-3" /> Request revision
                      </button>
                      {CANCELLABLE.includes(r.client_status) && (
                        <button onClick={() => handleCancel(r)}
                          className="text-xs px-3 py-1.5 rounded-lg bg-red-500/10 text-red-400 border border-red-500/25 hover:bg-red-500/20 transition-colors flex items-center gap-1.5">
                          <Ban className="w-3 h-3" /> Cancel request
                        </button>
                      )}
                    </div>

                    {actionBox !== null && actionBox.id === r.id && (
                      <div className="bg-secondary/60 border border-border rounded-xl p-3 space-y-2">
                        {actionBox.kind === 'link' && (
                          <>
                            <input value={actionText} onChange={e => setActionText(e.target.value)} className={inputCls} placeholder="Label (e.g. New content)" />
                            <input value={actionUrl} onChange={e => setActionUrl(e.target.value)} className={inputCls} placeholder="https://…" />
                          </>
                        )}
                        {actionBox.kind === 'remarks' && (
                          <textarea rows={3} value={actionText} onChange={e => setActionText(e.target.value)} className={inputCls + ' resize-none'} placeholder="Your remarks…" />
                        )}
                        {actionBox.kind === 'revision' && (
                          <>
                            <textarea rows={3} value={actionText} onChange={e => setActionText(e.target.value)} className={inputCls + ' resize-none'} placeholder="What needs to change?" />
                            <input value={actionUrl} onChange={e => setActionUrl(e.target.value)} className={inputCls} placeholder="Reference link (optional)" />
                          </>
                        )}
                        {actionBox.kind === 'field' && (
                          actionBox.field === 'title'
                            ? <input value={actionText} onChange={e => setActionText(e.target.value)} className={inputCls} placeholder="Request title" />
                            : actionBox.field === 'due_date'
                              ? <input type="date" value={actionText} onChange={e => setActionText(e.target.value)} className={inputCls} />
                              : <textarea rows={5} value={actionText} onChange={e => setActionText(e.target.value)} onInput={autoGrow}
                                  className={inputCls + ' resize-y min-h-[110px]'}
                                  placeholder={actionBox.field === 'description' ? 'Describe the work…' : 'Style direction, colours, references…'} />
                        )}
                        <div className="flex gap-2">
                          <button onClick={() => setActionBox(null)} className="flex-1 text-xs py-2 rounded-lg bg-secondary hover:bg-secondary/70 transition-colors">Cancel</button>
                          <button onClick={runAction} disabled={actionBusy || (
                            actionBox.kind === 'link' ? !actionUrl.trim()
                            : actionBox.kind === 'field' ? (actionBox.field === 'title' && !actionText.trim())
                            : !actionText.trim()
                          )}
                            className="flex-1 text-xs py-2 rounded-lg gradient-bg text-white hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center justify-center gap-1.5">
                            {actionBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : null} Save
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Links on the request */}
                    {(r.content_link || r.reference_link || r.deliverables_link || (r.extra_links || []).length > 0) && (
                      <div className="space-y-1">
                        {r.content_link && <a href={r.content_link} target="_blank" rel="noreferrer" className="block text-xs text-blue-400 hover:underline truncate">📁 Content — {r.content_link}</a>}
                        {r.reference_link && <a href={r.reference_link} target="_blank" rel="noreferrer" className="block text-xs text-blue-400 hover:underline truncate">🔍 Reference — {r.reference_link}</a>}
                        {r.deliverables_link && <a href={r.deliverables_link} target="_blank" rel="noreferrer" className="block text-xs text-emerald-400 hover:underline truncate">✅ Deliverables — {r.deliverables_link}</a>}
                        {(r.extra_links || []).map((l: any, i: number) => (
                          <a key={i} href={l.url} target="_blank" rel="noreferrer" className="block text-xs text-blue-400 hover:underline truncate">🔗 {l.label} — {l.url}</a>
                        ))}
                      </div>
                    )}

                    {/* External timeline */}
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-2">Activity</p>
                      <div className="space-y-2">
                        {(timeline[r.id] || []).map(a => (
                          <div key={a.id} className="flex items-start gap-2.5 text-xs">
                            <Clock className="w-3 h-3 text-muted-foreground/50 mt-0.5 shrink-0" />
                            <div className="min-w-0">
                              <p className="text-foreground/90">{activityText(a)}</p>
                              <p className="text-[10px] text-muted-foreground/60">
                                {fmtDateTime(a.created_at)}
                                {(a.actor_type === 'admin' || a.actor_type === 'system') ? ' · from Cirqle' : ''}
                              </p>
                            </div>
                          </div>
                        ))}
                        {!timeline[r.id] && <p className="text-xs text-muted-foreground/50">Loading…</p>}
                        {timeline[r.id]?.length === 0 && <p className="text-xs text-muted-foreground/50">No activity yet.</p>}
                      </div>
                    </div>
                  </div>
                )}
              </div>
                    )}
                  </SortableIntakeItem>
                )
              })}
            </SortableContext>
          </DndContext>
          {closedRequests.map(r => {
            const isOpen = expanded === r.id
            return (
              <div key={r.id} className="bg-card border border-border rounded-2xl overflow-hidden">
                <div role="button" tabIndex={0} onClick={() => toggleExpand(r.id)}
                  onKeyDown={e => { if (e.key === 'Enter') toggleExpand(r.id) }}
                  className="w-full text-left px-4 py-3.5 flex items-center gap-3 cursor-pointer">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] font-mono text-muted-foreground">REQ-{String(r.ref_no).padStart(4, '0')}</span>
                      <p className="text-sm font-semibold break-words">{r.title}</p>
                    </div>
                    <div className="flex items-center gap-2.5 mt-1 text-[11px] text-muted-foreground">
                      {r.due_date && <span className="flex items-center gap-1"><CalendarDays className="w-3 h-3" />{fmtDate(r.due_date)}</span>}
                      <span>Submitted {fmtDate(r.created_at)}</span>
                    </div>
                  </div>
                  <span className={`text-[11px] px-2.5 py-1 rounded-full border shrink-0 ${STATUS_CLS[r.client_status] || STATUS_CLS.submitted}`}>
                    {CLIENT_STATUS_LABEL[r.client_status] || 'Submitted'}
                  </span>
                  {isOpen ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
                </div>
                {isOpen && (
                  <div className="border-t border-border px-4 py-4">
                    <p className="text-xs text-muted-foreground/60">This request is {r.client_status}.</p>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <p className="text-center text-[11px] text-muted-foreground/50 mt-8">
        Cirqle Design · cirqle.work · This page only shows your own requests.
      </p>
    </div>
  )
}

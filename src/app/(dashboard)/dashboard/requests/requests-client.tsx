'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { useToast, ToastContainer } from '@/components/ui/toast'
import {
  Inbox, AlertTriangle, ChevronRight, Clock, Link2, Loader2, Play,
  CalendarDays, MessageSquarePlus, Save, CheckCircle2, X, Flag,
} from 'lucide-react'
import {
  CLIENT_STATUS_LABEL, STATUS_CHIP, PRIORITY_CHIP, refLabel, type RequestStatus,
} from '@/lib/requests/core'
import {
  setRequestStatusAction, markRequestViewed, getRequestTimeline,
  postExternalUpdate, updateInternalNotes, markRevisionAddressed,
} from './actions'

const TABS: { key: string; label: string; statuses: string[] }[] = [
  { key: 'new',      label: 'New',      statuses: ['submitted'] },
  { key: 'reviewed', label: 'Reviewed', statuses: ['under_review'] },
  { key: 'approved', label: 'Approved', statuses: ['approved'] },
  { key: 'started',  label: 'Started',  statuses: ['started', 'in_progress', 'waiting_for_content', 'revision_requested', 'completed', 'delivered'] },
  { key: 'rejected', label: 'Rejected', statuses: ['rejected'] },
  { key: 'archived', label: 'Archived', statuses: ['archived'] },
]

const STATUS_LABEL: Record<string, string> = {
  ...CLIENT_STATUS_LABEL,
  rejected: 'Rejected', archived: 'Archived',
}

/** Staff transitions offered per current status (Start is separate — Phase promotion). */
const TRANSITIONS: Record<string, { to: RequestStatus; label: string }[]> = {
  submitted:           [{ to: 'under_review', label: 'Mark Under Review' }, { to: 'approved', label: 'Approve' }, { to: 'rejected', label: 'Reject' }],
  under_review:        [{ to: 'approved', label: 'Approve' }, { to: 'rejected', label: 'Reject' }],
  approved:            [{ to: 'waiting_for_content', label: 'Waiting for Content' }, { to: 'rejected', label: 'Reject' }],
  started:             [{ to: 'waiting_for_content', label: 'Waiting for Content' }, { to: 'completed', label: 'Mark Completed' }],
  in_progress:         [{ to: 'waiting_for_content', label: 'Waiting for Content' }, { to: 'completed', label: 'Mark Completed' }],
  waiting_for_content: [{ to: 'completed', label: 'Mark Completed' }],
  revision_requested:  [{ to: 'waiting_for_content', label: 'Waiting for Content' }, { to: 'completed', label: 'Mark Completed' }],
  completed:           [{ to: 'delivered', label: 'Mark Delivered' }],
  delivered:           [],
  rejected:            [],
  archived:            [],
}

const fmtDate = (d?: string | null) => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
const fmtDT = (d: string) => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const ago = (d: string) => {
  const h = Math.floor((Date.now() - new Date(d).getTime()) / 3600000)
  if (h < 1) return 'just now'
  if (h < 24) return `${h}h ago`
  const days = Math.floor(h / 24)
  return `${days}d ago`
}

const VIS_CHIP: Record<string, string> = {
  internal: 'bg-secondary text-muted-foreground border-border',
  client:   'bg-violet-500/12 text-violet-300 border-violet-500/25',
  agency:   'bg-blue-500/12 text-blue-400 border-blue-500/25',
}

function activityText(a: any): string {
  const d = a.detail || {}
  switch (a.action) {
    case 'submitted':             return `Submitted “${d.title || ''}”`
    case 'status_changed':        return `Status: ${STATUS_LABEL[d.to] || d.to}${d.from ? ` (was ${STATUS_LABEL[d.from] || d.from})` : ''}`
    case 'link_added':            return `Added link — ${d.label || d.url || ''}`
    case 'field_changed':         return `Changed ${d.field || 'a field'}${d.field === 'remarks' ? '' : ` (${d.from ?? '—'} → ${d.to ?? '—'})`}`
    case 'revision_requested':    return `Revision requested${d.message ? ` — “${d.message}”` : ''}`
    case 'note':                  return d.message || 'Update posted'
    case 'promoted':              return `Promoted → Task #${d.task_number ?? ''}`
    case 'internal_note_updated': return 'Internal notes updated'
    default:                      return String(a.action).replace(/_/g, ' ')
  }
}

const hasNewExternal = (r: any) =>
  r.last_external_activity_at && (!r.last_staff_viewed_at || r.last_external_activity_at > r.last_staff_viewed_at)

export default function RequestsClient({
  migrated, initialRequests, perms,
}: {
  migrated: boolean
  initialRequests: any[]
  perms: { review: boolean; start: boolean; manage: boolean; activity: boolean }
}) {
  const router = useRouter()
  const { toasts, dismiss, success, error: toastError } = useToast()
  const [requests, setRequests] = useState(initialRequests)
  const [tab, setTab] = useState('new')
  const [open, setOpen] = useState<any | null>(null)
  const [timeline, setTimeline] = useState<any[]>([])
  const [revisions, setRevisions] = useState<any[]>([])
  const [tlLoading, setTlLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [updateMsg, setUpdateMsg] = useState('')
  const [notes, setNotes] = useState('')

  const counts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const t of TABS) m[t.key] = requests.filter(r => t.statuses.includes(r.status)).length
    return m
  }, [requests])

  const rows = useMemo(() => {
    const t = TABS.find(x => x.key === tab)!
    return requests.filter(r => t.statuses.includes(r.status))
  }, [requests, tab])

  async function openRequest(r: any) {
    setOpen(r); setNotes(r.internal_notes || ''); setUpdateMsg('')
    setTimeline([]); setRevisions([]); setTlLoading(true)
    // Clear the "new external activity" indicator.
    if (hasNewExternal(r)) {
      void markRequestViewed(r.id)
      setRequests(prev => prev.map(x => x.id === r.id ? { ...x, last_staff_viewed_at: new Date().toISOString() } : x))
    }
    if (perms.activity) {
      const res = await getRequestTimeline(r.id)
      if (res.ok && res.data) { setTimeline(res.data.rows); setRevisions(res.data.revisions) }
    }
    setTlLoading(false)
  }

  async function doStatus(r: any, to: RequestStatus) {
    setBusy(true)
    const res = await setRequestStatusAction(r.id, to)
    setBusy(false)
    if (res.ok) {
      setRequests(prev => prev.map(x => x.id === r.id ? { ...x, status: to } : x))
      setOpen((o: any) => o && o.id === r.id ? { ...o, status: to } : o)
      success(`Status → ${STATUS_LABEL[to] || to}`)
      router.refresh()
    } else toastError('Could not update status', res.error)
  }

  async function doPostUpdate() {
    if (!open || !updateMsg.trim()) return
    setBusy(true)
    const res = await postExternalUpdate(open.id, updateMsg)
    setBusy(false)
    if (res.ok) {
      setUpdateMsg('')
      success('Update posted', 'Visible to the requester on their tracking page')
      const tl = await getRequestTimeline(open.id)
      if (tl.ok && tl.data) setTimeline(tl.data.rows)
    } else toastError('Could not post update', res.error)
  }

  async function doSaveNotes() {
    if (!open) return
    setBusy(true)
    const res = await updateInternalNotes(open.id, notes)
    setBusy(false)
    if (res.ok) {
      setRequests(prev => prev.map(x => x.id === open.id ? { ...x, internal_notes: notes } : x))
      success('Internal notes saved')
    } else toastError('Could not save notes', res.error)
  }

  const requesterOf = (r: any) =>
    r.client?.name ? `${r.client.name}${r.client.code ? ' · ' + r.client.code : ''}`
    : r.agency?.name ? `Agency: ${r.agency.name}`
    : r.submitter_name ? `${r.submitter_name} (guest)` : 'Guest'

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
      <div className="flex items-center gap-2.5 mb-1">
        <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center"><Inbox className="w-4.5 h-4.5 text-primary" /></div>
        <div>
          <h1 className="text-lg font-bold">Requests</h1>
          <p className="text-xs text-muted-foreground">External submissions from clients &amp; agencies — isolated from Tasks until you Start them.</p>
        </div>
      </div>

      {!migrated && (
        <div className="mt-4 flex items-start gap-2.5 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <p className="text-sm text-amber-300">
            Run <code className="font-mono text-xs">supabase/migrations/20260610120000_request_portal.sql</code> in the Supabase SQL editor to activate the Request Portal.
          </p>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1.5 mt-5 mb-4 overflow-x-auto pb-1">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition-colors border ${
              tab === t.key ? 'gradient-bg text-white border-transparent shadow' : 'bg-secondary text-muted-foreground border-border hover:text-foreground'
            }`}>
            {t.label}{counts[t.key] ? ` (${counts[t.key]})` : ''}
          </button>
        ))}
      </div>

      {/* Rows */}
      <div className="space-y-2">
        {rows.length === 0 && (
          <div className="bg-card border border-border rounded-2xl px-6 py-12 text-center text-sm text-muted-foreground">
            Nothing here yet.
          </div>
        )}
        {rows.map(r => (
          <button key={r.id} onClick={() => openRequest(r)}
            className="w-full text-left bg-card border border-border rounded-xl px-4 py-3 flex items-center gap-3 hover:border-violet-500/40 transition-colors">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] font-mono text-muted-foreground shrink-0">{refLabel(r.ref_no)}</span>
                <p className="text-sm font-semibold truncate">{r.title}</p>
                {r.is_planned && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">planned</span>}
                {hasNewExternal(r) && (
                  <span className="flex items-center gap-1 text-[10px] font-semibold text-amber-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                    New {r.source === 'agency' ? 'Agency' : 'Client'} Update
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2.5 mt-1 text-[11px] text-muted-foreground flex-wrap">
                <span className="truncate max-w-[220px]">{requesterOf(r)}</span>
                {r.priority_rank != null && !['completed', 'delivered', 'rejected', 'archived'].includes(r.status) && (
                  <span className="font-bold text-violet-400" title="Requester's priority order">P#{r.priority_rank}</span>
                )}
                {r.priority !== 'normal' && <span className={`flex items-center gap-0.5 font-medium ${PRIORITY_CHIP[r.priority]}`}><Flag className="w-3 h-3" />{r.priority}</span>}
                {r.due_date && <span className="flex items-center gap-1"><CalendarDays className="w-3 h-3" />due {fmtDate(r.due_date)}</span>}
                <span>{ago(r.created_at)}</span>
                {r.service?.name && <span className="text-cyan-400/70">{r.service.name}</span>}
              </div>
            </div>
            <span className={`text-[11px] px-2.5 py-1 rounded-full border shrink-0 ${STATUS_CHIP[r.status] || STATUS_CHIP.submitted}`}>
              {STATUS_LABEL[r.status] || r.status}
            </span>
            <ChevronRight className="w-4 h-4 text-muted-foreground/40 shrink-0" />
          </button>
        ))}
      </div>

      {/* ── Detail drawer ── */}
      {open && (
        <ModalOverlay onClose={() => setOpen(null)}>
          <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full max-w-3xl shadow-2xl max-h-[92dvh] flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-start justify-between px-5 py-4 border-b border-border shrink-0 gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] font-mono text-muted-foreground">{refLabel(open.ref_no)}</span>
                  <span className={`text-[11px] px-2 py-0.5 rounded-full border ${STATUS_CHIP[open.status] || ''}`}>{STATUS_LABEL[open.status] || open.status}</span>
                  {open.priority !== 'normal' && <span className={`text-[11px] font-medium ${PRIORITY_CHIP[open.priority]}`}>⚑ {open.priority}</span>}
                </div>
                <h2 className="font-bold text-base mt-1 leading-snug">{open.title}</h2>
                <p className="text-xs text-muted-foreground mt-0.5">{requesterOf(open)} · submitted {fmtDate(open.created_at)}{open.due_date ? ` · due ${fmtDate(open.due_date)}` : ''}</p>
              </div>
              <button onClick={() => setOpen(null)} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground shrink-0"><X className="w-4 h-4" /></button>
            </div>

            <div className="overflow-y-auto flex-1 p-5 space-y-5">
              {/* Action bar */}
              <div className="flex flex-wrap gap-2">
                {perms.start && !open.promoted_task_id && ['submitted', 'under_review', 'approved'].includes(open.status) && (
                  <Link href={`/dashboard/tasks?fromRequest=${open.id}`}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg gradient-bg text-white hover:opacity-90 transition-opacity">
                    <Play className="w-4 h-4" /> Start — Create Task
                  </Link>
                )}
                {open.promoted_task_id && (
                  <span className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-green-500/10 text-green-400 border border-green-500/25">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Promoted to a task
                  </span>
                )}
                {(TRANSITIONS[open.status] || []).map(t => (
                  (t.to === 'rejected' || t.to === 'under_review' || t.to === 'approved' ? perms.review : perms.manage) && (
                    <button key={t.to} disabled={busy} onClick={() => doStatus(open, t.to)}
                      className="px-3 py-2 text-xs font-medium rounded-lg bg-secondary border border-border hover:bg-secondary/70 transition-colors disabled:opacity-50">
                      {t.label}
                    </button>
                  )
                ))}
                {perms.manage && open.status !== 'archived' && (
                  <button disabled={busy} onClick={() => doStatus(open, 'archived')}
                    className="px-3 py-2 text-xs font-medium rounded-lg bg-secondary border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50">
                    Archive
                  </button>
                )}
              </div>

              {/* Details */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                {open.description && <div className="sm:col-span-2"><p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1">Details</p><p className="whitespace-pre-wrap text-foreground/90">{open.description}</p></div>}
                {open.design_plan && <div className="sm:col-span-2"><p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1">Design plan</p><p className="whitespace-pre-wrap text-foreground/90">{open.design_plan}</p></div>}
                {open.remarks && <div className="sm:col-span-2"><p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1">Requester remarks</p><p className="whitespace-pre-wrap text-foreground/90">{open.remarks}</p></div>}
              </div>

              {/* Links */}
              {(open.content_link || open.reference_link || open.deliverables_link || open.drive_folder_link || (open.extra_links || []).length > 0) && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5">Links</p>
                  <div className="space-y-1">
                    {open.drive_folder_link && <a href={open.drive_folder_link} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-xs text-blue-400 hover:underline"><Link2 className="w-3 h-3" />Drive folder</a>}
                    {open.content_link && <a href={open.content_link} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-xs text-blue-400 hover:underline"><Link2 className="w-3 h-3" />Content</a>}
                    {open.reference_link && <a href={open.reference_link} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-xs text-blue-400 hover:underline"><Link2 className="w-3 h-3" />Reference</a>}
                    {open.deliverables_link && <a href={open.deliverables_link} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-xs text-emerald-400 hover:underline"><Link2 className="w-3 h-3" />Deliverables</a>}
                    {(open.extra_links || []).map((l: any, i: number) => (
                      <a key={i} href={l.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-xs text-blue-400 hover:underline"><Link2 className="w-3 h-3" />{l.label || l.url}</a>
                    ))}
                  </div>
                </div>
              )}

              {/* Open revisions */}
              {revisions.filter(v => v.status === 'open').length > 0 && (
                <div className="bg-pink-500/5 border border-pink-500/25 rounded-xl p-3.5">
                  <p className="text-xs font-semibold text-pink-400 mb-2">Open revisions</p>
                  <div className="space-y-2">
                    {revisions.filter(v => v.status === 'open').map(v => (
                      <div key={v.id} className="flex items-start justify-between gap-3 text-xs">
                        <div className="min-w-0">
                          <p className="text-foreground/90">{v.note}</p>
                          {v.link && <a href={v.link} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">{v.link}</a>}
                          <p className="text-[10px] text-muted-foreground/60 mt-0.5">{fmtDT(v.created_at)} · {v.requested_by_type}</p>
                        </div>
                        {perms.manage && (
                          <button onClick={async () => { const res = await markRevisionAddressed(v.id); if (res.ok) setRevisions(prev => prev.map(x => x.id === v.id ? { ...x, status: 'addressed' } : x)) }}
                            className="text-[11px] px-2 py-1 rounded-md bg-secondary hover:bg-secondary/70 shrink-0 transition-colors">Addressed</button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Post requester-visible update */}
              {perms.manage && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5">Post an update to the requester</p>
                  <div className="flex gap-2">
                    <input value={updateMsg} onChange={e => setUpdateMsg(e.target.value)}
                      className="flex-1 bg-secondary border border-foreground/15 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50"
                      placeholder='e.g. "Waiting for your content — please upload to the Drive folder"' />
                    <button onClick={doPostUpdate} disabled={busy || !updateMsg.trim()}
                      className="px-3 rounded-xl gradient-bg text-white hover:opacity-90 disabled:opacity-50 transition-opacity shrink-0">
                      <MessageSquarePlus className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}

              {/* Internal notes */}
              {perms.manage && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5">Internal notes <span className="normal-case text-muted-foreground/40">(never visible externally)</span></p>
                  <div className="flex gap-2">
                    <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)}
                      className="flex-1 bg-secondary border border-foreground/15 rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:border-violet-500/50" />
                    <button onClick={doSaveNotes} disabled={busy}
                      className="px-3 rounded-xl bg-secondary border border-border hover:bg-secondary/70 disabled:opacity-50 transition-colors shrink-0">
                      <Save className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}

              {/* Timeline */}
              {perms.activity && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-2">Activity timeline</p>
                  {tlLoading ? (
                    <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</p>
                  ) : (
                    <div className="space-y-2.5">
                      {timeline.length === 0 && <p className="text-xs text-muted-foreground/50">No activity yet.</p>}
                      {timeline.map(a => (
                        <div key={a.id} className="flex items-start gap-2.5">
                          <Clock className="w-3 h-3 text-muted-foreground/50 mt-1 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-xs text-foreground/90">{activityText(a)}</p>
                              <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${VIS_CHIP[a.visibility] || VIS_CHIP.internal}`}>{a.visibility}</span>
                            </div>
                            <p className="text-[10px] text-muted-foreground/60 mt-0.5">{fmtDT(a.created_at)} · {a.actor_label || a.actor_type}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </ModalOverlay>
      )}

      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}

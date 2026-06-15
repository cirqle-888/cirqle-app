'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  DndContext, closestCenter, PointerSensor, TouchSensor,
  useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, verticalListSortingStrategy,
  useSortable, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { ActiveFilterChips } from '@/components/ui/active-filter-chips'
import { TokenizedSearch, type SearchFacet } from '@/components/ui/tokenized-search'
import { recordMatchesFacets, type FacetFieldDef } from '@/lib/search/match-facets'
import { useToast, ToastContainer } from '@/components/ui/toast'
import {
  Inbox, AlertTriangle, ChevronRight, Clock, Link2, Loader2, Play,
  CalendarDays, MessageSquarePlus, Save, CheckCircle2, X, Flag,
  Search, Plus, UserRound, List, LayoutGrid, Link as LinkIcon, Trash2,
  ExternalLink, GripVertical, Share2,
} from 'lucide-react'
import {
  CLIENT_STATUS_LABEL, STATUS_CHIP, PRIORITY_CHIP, refLabel, type RequestStatus,
} from '@/lib/requests/core'
import {
  setRequestStatusAction, markRequestViewed, getRequestTimeline,
  postExternalUpdate, updateInternalNotes, markRevisionAddressed,
  assignRequestEmployee, createManualRequest, searchTasksForLink, linkRequestToTask,
  reorderStaffPriority,
} from './actions'

const TABS: { key: string; label: string; statuses: string[] }[] = [
  { key: 'new',      label: 'New',                 statuses: ['submitted'] },
  { key: 'reviewed', label: 'Reviewed',             statuses: ['under_review'] },
  { key: 'approved', label: 'Approved',             statuses: ['approved'] },
  { key: 'started',  label: 'Started',              statuses: ['started'] },
  { key: 'ongoing',  label: 'On Going',             statuses: ['in_progress', 'waiting_for_content', 'revision_requested'] },
  { key: 'done',     label: 'Done',                 statuses: ['completed', 'delivered'] },
  { key: 'all',      label: 'All',                  statuses: ['submitted', 'under_review', 'approved', 'started', 'in_progress', 'waiting_for_content', 'revision_requested', 'completed', 'delivered', 'rejected', 'cancelled'] },
  { key: 'rejected', label: 'Rejected / Cancelled', statuses: ['rejected', 'cancelled'] },
  { key: 'archived', label: 'Archived',             statuses: ['archived'] },
]

const SORTABLE_TABS = new Set(['new', 'reviewed', 'approved', 'started', 'ongoing'])

const STATUS_LABEL: Record<string, string> = {
  ...CLIENT_STATUS_LABEL,
  rejected: 'Rejected', archived: 'Archived',
}

/** Staff transitions offered per current status (Start is separate — Phase promotion). */
const TRANSITIONS: Record<string, { to: RequestStatus; label: string }[]> = {
  submitted:           [{ to: 'under_review', label: 'Mark Under Review' }, { to: 'approved', label: 'Approve' }, { to: 'rejected', label: 'Reject' }],
  under_review:        [{ to: 'approved', label: 'Approve' }, { to: 'rejected', label: 'Reject' }],
  approved:            [{ to: 'waiting_for_content', label: 'Waiting for Content' }, { to: 'rejected', label: 'Reject' }, { to: 'cancelled', label: 'Cancel' }],
  started:             [{ to: 'waiting_for_content', label: 'Waiting for Content' }, { to: 'completed', label: 'Mark Completed' }, { to: 'cancelled', label: 'Cancel' }],
  in_progress:         [{ to: 'waiting_for_content', label: 'Waiting for Content' }, { to: 'completed', label: 'Mark Completed' }, { to: 'cancelled', label: 'Cancel' }],
  waiting_for_content: [{ to: 'completed', label: 'Mark Completed' }, { to: 'cancelled', label: 'Cancel' }],
  revision_requested:  [{ to: 'waiting_for_content', label: 'Waiting for Content' }, { to: 'completed', label: 'Mark Completed' }, { to: 'cancelled', label: 'Cancel' }],
  completed:           [{ to: 'delivered', label: 'Mark Delivered' }],
  delivered:           [],
  rejected:            [],
  archived:            [{ to: 'submitted', label: 'Unarchive' }],
  cancelled:           [],
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
    case 'assigned':              return `Assigned to ${d.employee_name || 'an employee'}`
    case 'unassigned':            return 'Assignment cleared'
    default:                      return String(a.action).replace(/_/g, ' ')
  }
}

const hasNewExternal = (r: any) =>
  r.last_external_activity_at && (!r.last_staff_viewed_at || r.last_external_activity_at > r.last_staff_viewed_at)

const EMPTY_NEW = {
  clientId: '', title: '', description: '', designPlan: '', remarks: '',
  contentLink: '', referenceLink: '', isPlanned: false, serviceId: '',
  priority: 'normal', dueDate: '', assignedEmployeeId: '', estimatedValue: '',
  extraLinks: [] as { label: string; url: string }[],
}

const inrFmt = (n: number) =>
  '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 })

/** Status buckets for the by-client board summary (pending / active / done). */
const PENDING_STATUSES = ['submitted', 'under_review', 'approved']
const ACTIVE_STATUSES  = ['started', 'in_progress', 'waiting_for_content', 'revision_requested']
const DONE_STATUSES    = ['completed', 'delivered']

function SortableListItem({ id, disabled, children }: {
  id: string
  disabled?: boolean
  children: (handle: React.ReactNode) => React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled })
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
        disabled ? null : (
          <div
            {...attributes} {...listeners}
            className="cursor-grab active:cursor-grabbing p-1.5 text-muted-foreground/30 hover:text-muted-foreground/60 transition-colors touch-none select-none"
            title="Drag to reorder"
          >
            <GripVertical className="w-4 h-4" />
          </div>
        )
      )}
    </div>
  )
}

function getShareStatusStyle(status: string): React.CSSProperties {
  const map: Record<string, React.CSSProperties> = {
    submitted:           { color: '#60a5fa', borderColor: 'rgba(96,165,250,0.4)',  background: 'rgba(59,130,246,0.12)' },
    under_review:        { color: '#fbbf24', borderColor: 'rgba(251,191,36,0.4)',  background: 'rgba(245,158,11,0.12)' },
    approved:            { color: '#a78bfa', borderColor: 'rgba(167,139,250,0.4)', background: 'rgba(124,58,237,0.12)' },
    started:             { color: '#4ade80', borderColor: 'rgba(74,222,128,0.4)',  background: 'rgba(34,197,94,0.12)' },
    in_progress:         { color: '#4ade80', borderColor: 'rgba(74,222,128,0.4)',  background: 'rgba(34,197,94,0.12)' },
    waiting_for_content: { color: '#fb923c', borderColor: 'rgba(251,146,60,0.4)',  background: 'rgba(234,88,12,0.12)' },
    revision_requested:  { color: '#f472b6', borderColor: 'rgba(244,114,182,0.4)', background: 'rgba(219,39,119,0.12)' },
    completed:           { color: '#34d399', borderColor: 'rgba(52,211,153,0.4)',  background: 'rgba(16,185,129,0.12)' },
    delivered:           { color: '#6ee7b7', borderColor: 'rgba(110,231,183,0.4)', background: 'rgba(5,150,105,0.12)' },
  }
  return map[status] || { color: '#9ca3af', borderColor: 'rgba(156,163,175,0.4)', background: 'rgba(107,114,128,0.12)' }
}

export default function RequestsClient({
  migrated, initialRequests, perms, clients = [], employees = [], services = [],
  servicePricing = [], initialFocusId = null,
}: {
  migrated: boolean
  initialRequests: any[]
  perms: { review: boolean; start: boolean; manage: boolean; activity: boolean }
  clients?: { id: string; name: string; code?: string | null; drive_folder_link?: string | null }[]
  employees?: { id: string; cqid?: string | null; name: string }[]
  services?: { id: string; name: string }[]
  servicePricing?: { client_id: string; service_id: string; price: number | null }[]
  initialFocusId?: string | null
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

  // Filters + staff-created request modal
  const [searchFacets, setSearchFacets] = useState<SearchFacet[]>([])
  const [searchDraft, setSearchDraft] = useState('')
  const activeFacets = useMemo<SearchFacet[]>(
    () => searchDraft.trim() ? [...searchFacets, { field: 'any', op: 'contains' as const, text: searchDraft.trim() }] : searchFacets,
    [searchFacets, searchDraft],
  )
  const REQUEST_FIELDS: Record<string, FacetFieldDef> = useMemo(() => ({
    title:  { type: 'text', get: (r: any) => r.title },
    client: { type: 'text', get: (r: any) => r.client?.name },
    agency: { type: 'text', get: (r: any) => r.agency?.name },
    ref:    { type: 'text', get: (r: any) => refLabel(r.ref_no) },
  }), [])
  const requestGeneric = (r: any) =>
    `${refLabel(r.ref_no)} ${r.title || ''} ${r.client?.name || ''} ${r.agency?.name || ''} ${r.submitter_name || ''} ${r.assigned_employee?.name || ''}`
  const [clientFilter, setClientFilter] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [newForm, setNewForm] = useState(EMPTY_NEW)
  const [creating, setCreating] = useState(false)

  // View mode: flat list (tabbed) or kanban board (all statuses at once)
  const [view, setView] = useState<'list' | 'board'>('list')
  const [boardBy, setBoardBy] = useState<'status' | 'client'>('status')

  // Priority drag + manual rank override
  const [editRank, setEditRank] = useState<{ id: string; val: string } | null>(null)

  // Share modal
  const [showShare, setShowShare] = useState(false)
  const [shareClientId, setShareClientId] = useState('')
  const [shareIncludeCompleted, setShareIncludeCompleted] = useState(false)
  const [shareGenerating, setShareGenerating] = useState(false)
  const shareCardRef = useRef<HTMLDivElement>(null)

  // DnD sensors — require 8px move (pointer) or 200ms hold (touch) before drag activates,
  // so normal taps still open the drawer.
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  )

  // Link-an-existing-task picker (inside the drawer)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkQ, setLinkQ] = useState('')
  const [linkResults, setLinkResults] = useState<any[] | null>(null)
  const [linkSearching, setLinkSearching] = useState(false)

  // Deep link (?focus=<id>) — e.g. arriving from a task's request brief.
  useEffect(() => {
    if (!initialFocusId) return
    const r = initialRequests.find(x => x.id === initialFocusId)
    if (r) {
      void openRequest(r)
      const t = TABS.find(x => x.statuses.includes(r.status))
      if (t) setTab(t.key)
    }
    window.history.replaceState(null, '', '/dashboard/requests')
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const t of TABS) m[t.key] = requests.filter(r => t.statuses.includes(r.status)).length
    return m
  }, [requests])

  // Only offer clients that actually have requests in the filter dropdown.
  const filterClients = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of requests) if (r.client?.id && !seen.has(r.client.id)) seen.set(r.client.id, r.client.name)
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [requests])

  // Per-client Drive folder (configured on Settings → Intake Links).
  const driveLinkOf = (clientId?: string | null) =>
    (clientId && clients.find(c => c.id === clientId)?.drive_folder_link) || null

  // Pipeline value (admin) — open requests only. Staff-entered estimated_value
  // wins; otherwise fall back to the client+service price from the Pricing Matrix.
  const requestValue = (r: any): number => {
    if (r.estimated_value != null) return Number(r.estimated_value) || 0
    if (r.client?.id && r.service?.id) {
      const p = servicePricing.find(x => x.client_id === r.client.id && x.service_id === r.service.id)
      if (p?.price) return Number(p.price) || 0
    }
    return 0
  }
  const pipeline = useMemo(() => {
    const open = requests.filter(r => [...PENDING_STATUSES, ...ACTIVE_STATUSES].includes(r.status))
    return {
      count: open.length,
      value: open.reduce((s, r) => s + requestValue(r), 0),
      pendingValue: open.filter(r => PENDING_STATUSES.includes(r.status)).reduce((s, r) => s + requestValue(r), 0),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests, servicePricing])

  const rows = useMemo(() => {
    const t = TABS.find(x => x.key === tab)!
    const filtered = requests.filter(r => {
      if (!t.statuses.includes(r.status)) return false
      if (clientFilter && r.client?.id !== clientFilter) return false
      if (activeFacets.length && !recordMatchesFacets(activeFacets, r, REQUEST_FIELDS, requestGeneric)) return false
      return true
    })
    return filtered.sort((a, b) => (a.priority_rank ?? 9999) - (b.priority_rank ?? 9999))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests, tab, activeFacets, clientFilter])

  async function openRequest(r: any) {
    setOpen(r); setNotes(r.internal_notes || ''); setUpdateMsg('')
    setLinkOpen(false); setLinkQ(''); setLinkResults(null)
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
      success(to === 'submitted' ? 'Unarchived — back in the New tab' : `Status → ${STATUS_LABEL[to] || to}`)
      router.refresh()
    } else {
      toastError('Could not update status',
        to === 'cancelled'
          ? 'If this keeps failing, run supabase/migrations/20260612120000_request_cancelled_value.sql first.'
          : res.error)
    }
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

  async function doAssign(r: any, employeeId: string) {
    const emp = employees.find(e => e.id === employeeId) || null
    setBusy(true)
    const res = await assignRequestEmployee(r.id, employeeId || null, emp?.name || null)
    setBusy(false)
    if (res.ok) {
      const patch = { assigned_employee_id: employeeId || null, assigned_employee: emp ? { id: emp.id, name: emp.name } : null }
      setRequests(prev => prev.map(x => x.id === r.id ? { ...x, ...patch } : x))
      setOpen((o: any) => o && o.id === r.id ? { ...o, ...patch } : o)
      success(emp ? `Assigned to ${emp.name}` : 'Assignment cleared',
        emp ? 'They get the task assignment when this request is started' : undefined)
    } else toastError('Could not assign', res.error)
  }

  async function doCreate() {
    if (creating) return
    setCreating(true)
    const res = await createManualRequest({
      clientId: newForm.clientId,
      title: newForm.title,
      description: newForm.description,
      designPlan: newForm.designPlan,
      remarks: newForm.remarks,
      contentLink: newForm.contentLink,
      referenceLink: newForm.referenceLink,
      extraLinks: newForm.extraLinks,
      isPlanned: newForm.isPlanned,
      serviceId: newForm.serviceId || null,
      priority: newForm.priority,
      dueDate: newForm.dueDate || null,
      assignedEmployeeId: newForm.assignedEmployeeId || null,
      estimatedValue: newForm.estimatedValue ? parseFloat(newForm.estimatedValue) : null,
    })
    setCreating(false)
    if (res.ok && res.data) {
      setRequests(prev => [res.data, ...prev])
      setShowNew(false)
      setNewForm(EMPTY_NEW)
      setTab('new')
      success(`${refLabel(res.data.ref_no)} created`, 'Visible on the client’s intake portal — press Start when work begins')
    } else toastError('Could not create the request', res.error)
  }

  async function doLinkSearch() {
    if (!open || !linkQ.trim()) return
    setLinkSearching(true)
    const res = await searchTasksForLink(linkQ, open.client?.id || null)
    setLinkSearching(false)
    if (res.ok) setLinkResults(res.data || [])
    else toastError('Search failed', res.error)
  }

  async function doLinkTask(task: any) {
    if (!open) return
    setBusy(true)
    const res = await linkRequestToTask(open.id, task.id)
    setBusy(false)
    if (res.ok) {
      const patch = {
        promoted_task_id: task.id,
        promoted_task: { id: task.id, task_number: task.task_number, title: task.title, status: task.status },
        status: 'started',
      }
      setRequests(prev => prev.map(x => x.id === open.id ? { ...x, ...patch } : x))
      setOpen((o: any) => o ? { ...o, ...patch } : o)
      setLinkOpen(false); setLinkQ(''); setLinkResults(null)
      success(`Linked to Task #${task.task_number ?? ''}`, 'Requester notified — status now mirrors the task')
      router.refresh()
    } else toastError('Could not link the task', res.error)
  }

  const isDraggableTab = view === 'list' && SORTABLE_TABS.has(tab) && perms.manage && !activeFacets.length && !searchDraft.trim()

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = rows.findIndex(r => r.id === active.id)
    const newIndex = rows.findIndex(r => r.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const newOrder = arrayMove(rows, oldIndex, newIndex)
    const rankMap = new Map(newOrder.map((r, i) => [r.id, i + 1]))
    setRequests(prev => prev.map(r => rankMap.has(r.id) ? { ...r, priority_rank: rankMap.get(r.id) } : r))
    void reorderStaffPriority(newOrder.map(r => r.id))
  }

  function applyManualRank(id: string, targetPos: number) {
    const n = Math.max(1, Math.min(rows.length, Math.round(targetPos)))
    const currentIndex = rows.findIndex(r => r.id === id)
    if (currentIndex < 0) return
    const newOrder = arrayMove(rows, currentIndex, n - 1)
    const rankMap = new Map(newOrder.map((r, i) => [r.id, i + 1]))
    setRequests(prev => prev.map(r => rankMap.has(r.id) ? { ...r, priority_rank: rankMap.get(r.id) } : r))
    void reorderStaffPriority(newOrder.map(r => r.id))
    setEditRank(null)
  }

  const shareClientName = useMemo(
    () => filterClients.find(([id]) => id === shareClientId)?.[1] || clients.find(c => c.id === shareClientId)?.name || '',
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shareClientId, filterClients, clients],
  )

  const shareRequests = useMemo(() => {
    if (!shareClientId) return []
    const SHARE_ACTIVE = ['submitted', 'under_review', 'approved', 'started', 'in_progress', 'waiting_for_content', 'revision_requested']
    const SHARE_DONE   = ['completed', 'delivered']
    return requests
      .filter(r => r.client?.id === shareClientId && (SHARE_ACTIVE.includes(r.status) || (shareIncludeCompleted && SHARE_DONE.includes(r.status))))
      .sort((a, b) => (a.priority_rank ?? 999) - (b.priority_rank ?? 999))
  }, [requests, shareClientId, shareIncludeCompleted])

  const downloadShareImage = useCallback(async () => {
    if (!shareCardRef.current) return
    setShareGenerating(true)
    try {
      const { default: html2canvas } = await import('html2canvas')
      const canvas = await html2canvas(shareCardRef.current, { backgroundColor: '#111827', scale: 2, useCORS: true, logging: false })
      const url = canvas.toDataURL('image/png')
      const a = document.createElement('a')
      a.href = url
      a.download = `cirqle-${(shareClientName || 'requests').toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.png`
      a.click()
    } catch { /* silent */ }
    setShareGenerating(false)
  }, [shareClientName])

  // Board columns (board ignores tabs; search + client filters still apply)
  const boardRows = useMemo(() => {
    return requests.filter(r => {
      if (clientFilter && r.client?.id !== clientFilter) return false
      if (activeFacets.length && !recordMatchesFacets(activeFacets, r, REQUEST_FIELDS, requestGeneric)) return false
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests, activeFacets, clientFilter])

  const boardCols = useMemo(() => {
    if (boardBy === 'status') {
      return TABS.map(t => ({
        key: t.key, label: t.label,
        rows: boardRows.filter(r => t.statuses.includes(r.status)),
      })).filter(c => c.key !== 'all' && (c.key !== 'archived' || c.rows.length > 0))
    }
    // By client: one column per requester, with pending/active/done summary.
    const groups = new Map<string, { label: string; rows: any[] }>()
    for (const r of boardRows) {
      const key = r.client?.id || r.agency?.id || 'other'
      const label = r.client?.name || (r.agency?.name ? `Agency: ${r.agency.name}` : 'Other / Guest')
      if (!groups.has(key)) groups.set(key, { label, rows: [] })
      groups.get(key)!.rows.push(r)
    }
    return [...groups.entries()]
      .sort((a, b) => b[1].rows.length - a[1].rows.length)
      .map(([key, g]) => ({ key, label: g.label, rows: g.rows }))
  }, [boardRows, boardBy])

  const requesterOf = (r: any) =>
    r.client?.name ? `${r.client.name}${r.client.code ? ' · ' + r.client.code : ''}`
    : r.agency?.name ? `Agency: ${r.agency.name}`
    : r.submitter_name ? `${r.submitter_name} (guest)` : 'Guest'

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
      <div className="flex items-center gap-2.5 mb-1 flex-wrap">
        <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center"><Inbox className="w-4.5 h-4.5 text-primary" /></div>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold">Requests</h1>
          <p className="text-xs text-muted-foreground">External submissions from clients &amp; agencies — isolated from Tasks until you Start them.</p>
        </div>
        {perms.manage && migrated && pipeline.count > 0 && (
          <div className="text-right shrink-0" title="Estimated value of open requests (staff estimate, else Pricing Matrix price)">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Pipeline Value</p>
            <p className="text-base font-bold text-violet-400">{inrFmt(pipeline.value)}</p>
            <p className="text-[10px] text-muted-foreground">{pipeline.count} open · {inrFmt(pipeline.pendingValue)} not started</p>
          </div>
        )}
      </div>

      {!migrated && (
        <div className="mt-4 flex items-start gap-2.5 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <p className="text-sm text-amber-300">
            Run <code className="font-mono text-xs">supabase/migrations/20260610120000_request_portal.sql</code> in the Supabase SQL editor to activate the Request Portal.
          </p>
        </div>
      )}

      {/* Tabs (list) / group-by (board) + New Request */}
      <div className="flex items-center gap-1.5 mt-5 mb-3 overflow-x-auto pb-1">
        {view === 'list' ? TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition-colors border ${
              tab === t.key ? 'gradient-bg text-white border-transparent shadow' : 'bg-secondary text-muted-foreground border-border hover:text-foreground'
            }`}>
            {t.label}{counts[t.key] ? ` (${counts[t.key]})` : ''}
          </button>
        )) : (
          <>
            <span className="text-xs text-muted-foreground mr-1">Group by</span>
            {(['status', 'client'] as const).map(g => (
              <button key={g} onClick={() => setBoardBy(g)}
                className={`px-3.5 py-1.5 rounded-xl text-xs font-medium capitalize whitespace-nowrap transition-colors border ${
                  boardBy === g ? 'gradient-bg text-white border-transparent shadow' : 'bg-secondary text-muted-foreground border-border hover:text-foreground'
                }`}>
                {g}
              </button>
            ))}
          </>
        )}
        {perms.manage && migrated && (
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => { setShowShare(true); setShareClientId(clientFilter || ''); setShareIncludeCompleted(false) }}
              title="Share a client's request status as an image"
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap bg-secondary border border-border hover:text-foreground text-muted-foreground transition-colors">
              <Share2 className="w-3.5 h-3.5" /> Share
            </button>
            <button onClick={() => setShowNew(true)}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap gradient-bg text-white hover:opacity-90 transition-opacity">
              <Plus className="w-3.5 h-3.5" /> New Request
            </button>
          </div>
        )}
      </div>

      {/* Search + client filter + view toggle */}
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <TokenizedSearch
          className="flex-1"
          facets={searchFacets}
          onFacetsChange={setSearchFacets}
          draft={searchDraft}
          onDraftChange={setSearchDraft}
          placeholder="Search title, client, REQ number…"
          resultCount={rows.length}
          resultNoun="request"
          fields={[
            { key: 'title', label: 'Title', type: 'text' },
            { key: 'client', label: 'Client', type: 'text' },
            { key: 'agency', label: 'Agency', type: 'text' },
            { key: 'ref', label: 'REQ #', type: 'text' },
          ]}
        />
        <select value={clientFilter} onChange={e => setClientFilter(e.target.value)}
          className="bg-secondary border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50 sm:w-56">
          <option value="">All clients</option>
          {filterClients.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <div className="flex rounded-xl border border-border overflow-hidden shrink-0">
          <button onClick={() => setView('list')} title="List view"
            className={`px-3 py-2 transition-colors ${view === 'list' ? 'gradient-bg text-white' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}>
            <List className="w-4 h-4" />
          </button>
          <button onClick={() => setView('board')} title="Board view"
            className={`px-3 py-2 transition-colors ${view === 'board' ? 'gradient-bg text-white' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}>
            <LayoutGrid className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Tokenized active filters (client dropdown chip; search shows in the bar) */}
      <ActiveFilterChips
        className="mb-3"
        chips={[
          ...(clientFilter ? [{ key: 'client', label: 'Client', value: filterClients.find(([id]) => id === clientFilter)?.[1] || 'Selected', onRemove: () => setClientFilter('') }] : []),
        ]}
        onClearAll={() => { setClientFilter('') }}
      />

      {/* ── Board view ── */}
      {view === 'board' && (
        <div className="flex gap-3 overflow-x-auto pb-4 items-start">
          {boardCols.map(col => {
            const pending = col.rows.filter(r => PENDING_STATUSES.includes(r.status)).length
            const active  = col.rows.filter(r => ACTIVE_STATUSES.includes(r.status)).length
            const done    = col.rows.filter(r => DONE_STATUSES.includes(r.status)).length
            return (
              <div key={col.key} className="w-64 shrink-0 bg-secondary/40 border border-border rounded-2xl">
                <div className="px-3 py-2.5 border-b border-border/60">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-bold truncate">{col.label}</p>
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-secondary border border-border text-muted-foreground shrink-0">{col.rows.length}</span>
                  </div>
                  {boardBy === 'client' && col.rows.length > 0 && (
                    <p className="text-[10px] text-muted-foreground mt-1">
                      {pending > 0 && <span className="text-blue-400">{pending} pending</span>}
                      {pending > 0 && (active > 0 || done > 0) && ' · '}
                      {active > 0 && <span className="text-green-400">{active} started</span>}
                      {active > 0 && done > 0 && ' · '}
                      {done > 0 && <span className="text-emerald-300">{done} done</span>}
                    </p>
                  )}
                </div>
                <div className="p-2 space-y-2 max-h-[60dvh] overflow-y-auto">
                  {col.rows.length === 0 && <p className="text-[11px] text-muted-foreground/50 text-center py-4">Empty</p>}
                  {col.rows.map(r => (
                    <button key={r.id} onClick={() => openRequest(r)}
                      className="w-full text-left bg-card border border-border rounded-xl p-2.5 hover:border-violet-500/40 transition-colors">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-mono text-muted-foreground shrink-0">{refLabel(r.ref_no)}</span>
                        {hasNewExternal(r) && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />}
                        {r.priority !== 'normal' && <Flag className={`w-3 h-3 shrink-0 ${PRIORITY_CHIP[r.priority]}`} />}
                      </div>
                      <p className="text-xs font-semibold leading-snug mt-0.5 line-clamp-2">{r.title}</p>
                      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                        {boardBy === 'status'
                          ? <span className="text-[10px] text-muted-foreground truncate max-w-[140px]">{requesterOf(r)}</span>
                          : <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${STATUS_CHIP[r.status] || ''}`}>{STATUS_LABEL[r.status] || r.status}</span>}
                        {r.assigned_employee?.name && (
                          <span className="flex items-center gap-0.5 text-[10px] text-violet-300/80"><UserRound className="w-2.5 h-2.5" />{r.assigned_employee.name.split(' ')[0]}</span>
                        )}
                        {r.promoted_task?.task_number != null && (
                          <span className="text-[10px] font-mono text-green-400/80">#{r.promoted_task.task_number}</span>
                        )}
                        {r.due_date && <span className="text-[10px] text-muted-foreground">due {fmtDate(r.due_date)}</span>}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── List view ── */}
      {view === 'list' && (
      <div className="space-y-2">
        {rows.length === 0 && (
          <div className="bg-card border border-border rounded-2xl px-6 py-12 text-center text-sm text-muted-foreground">
            Nothing here yet.
          </div>
        )}
        {isDraggableTab && rows.length > 1 && (
          <p className="text-[11px] text-muted-foreground/50 px-1 flex items-center gap-1">
            <GripVertical className="w-3.5 h-3.5" /> Drag to reorder · tap #N to set manually
          </p>
        )}
        <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={rows.map(r => r.id)} strategy={verticalListSortingStrategy}>
            {rows.map((r, idx) => (
              <SortableListItem key={r.id} id={r.id} disabled={!isDraggableTab}>
                {(handle) => (
                  <div className="flex items-center bg-card border border-border rounded-xl hover:border-violet-500/40 transition-colors">
                    {isDraggableTab && (
                      <div className="flex flex-col items-center shrink-0 px-1 py-3 gap-0.5" onClick={e => e.stopPropagation()}>
                        {handle}
                        {editRank !== null && editRank.id === r.id ? (
                          <input
                            type="number" min={1} max={rows.length}
                            value={editRank.val}
                            onChange={e => setEditRank({ id: r.id, val: e.target.value })}
                            onBlur={() => { const n = parseInt(editRank!.val, 10); if (!isNaN(n)) applyManualRank(r.id, n); else setEditRank(null) }}
                            onKeyDown={e => {
                              if (e.key === 'Enter') { const n = parseInt(editRank!.val, 10); if (!isNaN(n)) applyManualRank(r.id, n); else setEditRank(null) }
                              else if (e.key === 'Escape') setEditRank(null)
                            }}
                            autoFocus
                            className="w-8 text-center text-[10px] font-bold text-violet-400 bg-transparent border-b border-violet-400/60 focus:outline-none"
                          />
                        ) : (
                          <button
                            onClick={() => setEditRank({ id: r.id, val: String(idx + 1) })}
                            className="text-[10px] font-bold text-violet-400/50 hover:text-violet-400 transition-colors leading-none"
                            title="Tap to set rank manually"
                          >#{idx + 1}</button>
                        )}
                      </div>
                    )}
                    <button className="flex-1 min-w-0 text-left px-3 py-3 flex items-center gap-3" onClick={() => openRequest(r)}>
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
                          {!isDraggableTab && r.priority_rank != null && !['completed', 'delivered', 'rejected', 'archived'].includes(r.status) && (
                            <span className="font-bold text-violet-400" title="Requester's priority order">P#{r.priority_rank}</span>
                          )}
                          {r.priority !== 'normal' && <span className={`flex items-center gap-0.5 font-medium ${PRIORITY_CHIP[r.priority]}`}><Flag className="w-3 h-3" />{r.priority}</span>}
                          {r.due_date && <span className="flex items-center gap-1"><CalendarDays className="w-3 h-3" />due {fmtDate(r.due_date)}</span>}
                          <span>{ago(r.created_at)}</span>
                          {r.service?.name && <span className="text-cyan-400/70">{r.service.name}</span>}
                          {r.assigned_employee?.name && (
                            <span className="flex items-center gap-1 text-violet-300/80"><UserRound className="w-3 h-3" />{r.assigned_employee.name}</span>
                          )}
                          {r.promoted_task?.task_number != null && (
                            <span className="font-mono text-green-400/80" title={`Linked task: ${r.promoted_task.title}`}>Task #{r.promoted_task.task_number}</span>
                          )}
                          {r.source === 'manual' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary border border-border text-muted-foreground">added by you</span>}
                        </div>
                      </div>
                      <span className={`text-[11px] px-2.5 py-1 rounded-full border shrink-0 ${STATUS_CHIP[r.status] || STATUS_CHIP.submitted}`}>
                        {STATUS_LABEL[r.status] || r.status}
                      </span>
                      <ChevronRight className="w-4 h-4 text-muted-foreground/40 shrink-0" />
                    </button>
                  </div>
                )}
              </SortableListItem>
            ))}
          </SortableContext>
        </DndContext>
      </div>
      )}

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
                {perms.start && !open.promoted_task_id && ['submitted', 'under_review', 'approved'].includes(open.status) && (
                  <button onClick={() => setLinkOpen(v => !v)}
                    className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-secondary border border-border hover:bg-secondary/70 transition-colors">
                    <LinkIcon className="w-3.5 h-3.5" /> Link Existing Task
                  </button>
                )}
                {open.promoted_task_id && (
                  <Link href={`/dashboard/tasks?q=${encodeURIComponent('#' + (open.promoted_task?.task_number ?? ''))}`}
                    className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-green-500/10 text-green-400 border border-green-500/25 hover:bg-green-500/20 transition-colors"
                    title={open.promoted_task?.title || 'Open the linked task'}>
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    View Task{open.promoted_task?.task_number != null ? ` #${open.promoted_task.task_number}` : ''}
                    <ExternalLink className="w-3 h-3" />
                  </Link>
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
                {(driveLinkOf(open.client?.id) || open.drive_folder_link) && (
                  <a href={driveLinkOf(open.client?.id) || open.drive_folder_link} target="_blank" rel="noreferrer"
                    className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/25 hover:bg-blue-500/20 transition-colors"
                    title="The client's Drive folder (set on Settings → Intake Links)">
                    <ExternalLink className="w-3.5 h-3.5" /> Drive Folder
                  </a>
                )}
              </div>

              {/* Link an existing task (work already created on the Tasks page) */}
              {linkOpen && !open.promoted_task_id && (
                <div className="bg-secondary/40 border border-border rounded-xl p-3.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-2">
                    Link an existing task{open.client?.name ? ` — searching ${open.client.name}'s tasks` : ''}
                  </p>
                  <div className="flex gap-2">
                    <input value={linkQ} onChange={e => setLinkQ(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') doLinkSearch() }}
                      placeholder="Search by title or #task number…"
                      className="flex-1 bg-secondary border border-foreground/15 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50" />
                    <button onClick={doLinkSearch} disabled={linkSearching || !linkQ.trim()}
                      className="px-3 rounded-xl bg-secondary border border-border hover:bg-secondary/70 disabled:opacity-50 transition-colors shrink-0">
                      {linkSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                    </button>
                  </div>
                  {linkResults !== null && (
                    <div className="mt-2 space-y-1.5">
                      {linkResults.length === 0 && <p className="text-xs text-muted-foreground/60">No unlinked tasks found.</p>}
                      {linkResults.map(t => (
                        <button key={t.id} disabled={busy} onClick={() => doLinkTask(t)}
                          className="w-full text-left flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 hover:border-violet-500/40 transition-colors disabled:opacity-50">
                          <span className="text-[10px] font-mono text-muted-foreground shrink-0">#{t.task_number ?? '—'}</span>
                          <span className="text-xs font-medium truncate flex-1">{t.title}</span>
                          <span className="text-[10px] text-muted-foreground shrink-0">{t.client?.name ? `${t.client.name} · ` : ''}{t.status} · {fmtDate(t.task_date)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Assign employee — planning marker until Start; the task
                  assignment is created automatically at promotion. */}
              {perms.manage && (
                <div className="flex items-center gap-2.5">
                  <UserRound className="w-4 h-4 text-muted-foreground shrink-0" />
                  <select value={open.assigned_employee_id || ''} disabled={busy}
                    onChange={e => doAssign(open, e.target.value)}
                    className="bg-secondary border border-border rounded-xl px-3 py-1.5 text-xs focus:outline-none focus:border-violet-500/50 disabled:opacity-50">
                    <option value="">Unassigned</option>
                    {employees.map(e => <option key={e.id} value={e.id}>{e.cqid ? `${e.cqid} · ` : ''}{e.name}</option>)}
                  </select>
                  {!open.promoted_task_id && open.assigned_employee_id && (
                    <span className="text-[10px] text-muted-foreground">assigned on the task when you press Start</span>
                  )}
                </div>
              )}

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

      {/* ── New Request (staff-created opportunity) ── */}
      {showNew && (
        <ModalOverlay onClose={() => setShowNew(false)}>
          <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full max-w-lg shadow-2xl max-h-[92dvh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
              <div>
                <h2 className="font-bold text-base">New Request</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Lands in the inbox as New and shows on the client’s intake portal. No task number until you press Start.
                </p>
              </div>
              <button onClick={() => setShowNew(false)} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground"><X className="w-4 h-4" /></button>
            </div>
            <div className="overflow-y-auto flex-1 p-5 space-y-3.5">
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Client *</label>
                <select value={newForm.clientId} onChange={e => setNewForm(f => ({ ...f, clientId: e.target.value }))}
                  className="mt-1 w-full bg-secondary border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50">
                  <option value="">Select client…</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}{c.code ? ` · ${c.code}` : ''}</option>)}
                </select>
                {driveLinkOf(newForm.clientId) && (
                  <a href={driveLinkOf(newForm.clientId)!} target="_blank" rel="noreferrer"
                    className="mt-1.5 inline-flex items-center gap-1 text-xs text-blue-400 hover:underline">
                    <ExternalLink className="w-3 h-3" /> Open this client&rsquo;s Drive folder
                  </a>
                )}
              </div>
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Title *</label>
                <input value={newForm.title} onChange={e => setNewForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="e.g. Onam campaign poster set"
                  className="mt-1 w-full bg-secondary border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50" />
              </div>
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Details</label>
                <textarea rows={3} value={newForm.description} onChange={e => setNewForm(f => ({ ...f, description: e.target.value }))}
                  className="mt-1 w-full bg-secondary border border-border rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:border-violet-500/50" />
              </div>
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Design plan</label>
                <textarea rows={2} value={newForm.designPlan} onChange={e => setNewForm(f => ({ ...f, designPlan: e.target.value }))}
                  placeholder="Layout, sizes, formats, copy direction…"
                  className="mt-1 w-full bg-secondary border border-border rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:border-violet-500/50" />
              </div>
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Remarks</label>
                <textarea rows={2} value={newForm.remarks} onChange={e => setNewForm(f => ({ ...f, remarks: e.target.value }))}
                  className="mt-1 w-full bg-secondary border border-border rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:border-violet-500/50" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Content link</label>
                  <input value={newForm.contentLink} onChange={e => setNewForm(f => ({ ...f, contentLink: e.target.value }))}
                    placeholder="https://…"
                    className="mt-1 w-full bg-secondary border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50" />
                </div>
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Reference link</label>
                  <input value={newForm.referenceLink} onChange={e => setNewForm(f => ({ ...f, referenceLink: e.target.value }))}
                    placeholder="https://…"
                    className="mt-1 w-full bg-secondary border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50" />
                </div>
              </div>
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">More links</label>
                {newForm.extraLinks.map((l, i) => (
                  <div key={i} className="flex gap-2 mt-1.5">
                    <input value={l.label} onChange={e => setNewForm(f => ({ ...f, extraLinks: f.extraLinks.map((x, j) => j === i ? { ...x, label: e.target.value } : x) }))}
                      placeholder="Label"
                      className="w-28 bg-secondary border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50" />
                    <input value={l.url} onChange={e => setNewForm(f => ({ ...f, extraLinks: f.extraLinks.map((x, j) => j === i ? { ...x, url: e.target.value } : x) }))}
                      placeholder="https://…"
                      className="flex-1 bg-secondary border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50" />
                    <button onClick={() => setNewForm(f => ({ ...f, extraLinks: f.extraLinks.filter((_, j) => j !== i) }))}
                      className="px-2.5 rounded-xl bg-secondary border border-border text-muted-foreground hover:text-red-400 transition-colors shrink-0">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                {newForm.extraLinks.length < 10 && (
                  <button onClick={() => setNewForm(f => ({ ...f, extraLinks: [...f.extraLinks, { label: '', url: '' }] }))}
                    className="mt-1.5 flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300 transition-colors">
                    <Plus className="w-3 h-3" /> Add link
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Service</label>
                  <select value={newForm.serviceId} onChange={e => setNewForm(f => ({ ...f, serviceId: e.target.value }))}
                    className="mt-1 w-full bg-secondary border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50">
                    <option value="">—</option>
                    {services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Assign employee</label>
                  <select value={newForm.assignedEmployeeId} onChange={e => setNewForm(f => ({ ...f, assignedEmployeeId: e.target.value }))}
                    className="mt-1 w-full bg-secondary border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50">
                    <option value="">Unassigned</option>
                    {employees.map(e => <option key={e.id} value={e.id}>{e.cqid ? `${e.cqid} · ` : ''}{e.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Due date</label>
                  <input type="date" value={newForm.dueDate} onChange={e => setNewForm(f => ({ ...f, dueDate: e.target.value }))}
                    className="mt-1 w-full bg-secondary border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50" />
                </div>
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Estimated value (₹)</label>
                  <input type="number" min="0" value={newForm.estimatedValue}
                    onChange={e => setNewForm(f => ({ ...f, estimatedValue: e.target.value }))}
                    placeholder="Pricing Matrix price if blank"
                    className="mt-1 w-full bg-secondary border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50" />
                </div>
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Priority</label>
                  <select value={newForm.priority} onChange={e => setNewForm(f => ({ ...f, priority: e.target.value }))}
                    className="mt-1 w-full bg-secondary border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50">
                    <option value="low">Low</option>
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                <input type="checkbox" checked={newForm.isPlanned}
                  onChange={e => setNewForm(f => ({ ...f, isPlanned: e.target.checked }))}
                  className="w-3.5 h-3.5 rounded accent-violet-500" />
                Planned / future campaign (shows a “planned” tag in the inbox)
              </label>
            </div>
            <div className="px-5 py-4 border-t border-border flex justify-end gap-2 shrink-0">
              <button onClick={() => setShowNew(false)}
                className="px-4 py-2 text-sm rounded-xl bg-secondary border border-border hover:bg-secondary/70 transition-colors">Cancel</button>
              <button onClick={doCreate} disabled={creating || !newForm.clientId || !newForm.title.trim()}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-xl gradient-bg text-white hover:opacity-90 disabled:opacity-50 transition-opacity">
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create Request
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* ── Share modal ── */}
      {showShare && (
        <ModalOverlay onClose={() => setShowShare(false)}>
          <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full max-w-xl shadow-2xl max-h-[92dvh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
              <div>
                <h2 className="font-bold text-base flex items-center gap-2"><Share2 className="w-4 h-4 text-violet-400" /> Share Status</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Download a PNG of a client&rsquo;s pending &amp; ongoing works.</p>
              </div>
              <button onClick={() => setShowShare(false)} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground"><X className="w-4 h-4" /></button>
            </div>
            <div className="overflow-y-auto flex-1 p-5 space-y-4">
              <div className="flex flex-wrap gap-3 items-end">
                <div className="flex-1 min-w-40">
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Client</label>
                  <select value={shareClientId} onChange={e => setShareClientId(e.target.value)}
                    className="mt-1 w-full bg-secondary border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50">
                    <option value="">Select client…</option>
                    {filterClients.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                  </select>
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none pb-2">
                  <input type="checkbox" checked={shareIncludeCompleted}
                    onChange={e => setShareIncludeCompleted(e.target.checked)}
                    className="w-3.5 h-3.5 rounded accent-violet-500" />
                  Include completed
                </label>
              </div>

              {shareClientId && shareRequests.length === 0 && (
                <p className="text-xs text-muted-foreground/60 text-center py-4">No pending or ongoing requests for this client.</p>
              )}

              {shareClientId && shareRequests.length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-2">Preview</p>
                  <div
                    ref={shareCardRef}
                    style={{ background: '#111827', padding: '24px', borderRadius: '16px', fontFamily: 'system-ui, -apple-system, sans-serif', color: '#f9fafb' }}
                  >
                    <div style={{ marginBottom: '16px', paddingBottom: '12px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                      <div style={{ fontSize: '15px', fontWeight: 700, letterSpacing: '-0.01em' }}>Cirqle Design</div>
                      <div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '3px' }}>Works in Progress — {shareClientName}</div>
                      <div style={{ fontSize: '10px', color: '#6b7280', marginTop: '3px' }}>
                        {new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}
                      </div>
                    </div>
                    {shareRequests.map((r, i) => (
                      <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px', padding: '10px 12px', background: '#1f2937', borderRadius: '10px' }}>
                        <span style={{ fontSize: '10px', fontWeight: 700, color: '#8b5cf6', minWidth: '18px', textAlign: 'right' }}>#{i + 1}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</div>
                          {r.due_date && <div style={{ fontSize: '10px', color: '#9ca3af', marginTop: '2px' }}>due {fmtDate(r.due_date)}</div>}
                        </div>
                        <span style={{ fontSize: '10px', padding: '3px 8px', borderRadius: '20px', border: '1px solid', whiteSpace: 'nowrap', flexShrink: 0, ...getShareStatusStyle(r.status) }}>
                          {CLIENT_STATUS_LABEL[r.client_status] || STATUS_LABEL[r.status] || r.status}
                        </span>
                      </div>
                    ))}
                    <div style={{ marginTop: '14px', fontSize: '10px', color: '#4b5563', textAlign: 'center', letterSpacing: '0.05em' }}>
                      CIRQLE DESIGN · cirqle.work
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="px-5 py-4 border-t border-border flex justify-end gap-2 shrink-0">
              <button onClick={() => setShowShare(false)}
                className="px-4 py-2 text-sm rounded-xl bg-secondary border border-border hover:bg-secondary/70 transition-colors">Cancel</button>
              <button
                onClick={downloadShareImage}
                disabled={!shareClientId || shareRequests.length === 0 || shareGenerating}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-xl gradient-bg text-white hover:opacity-90 disabled:opacity-50 transition-opacity">
                {shareGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" />}
                Download PNG
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}

      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}

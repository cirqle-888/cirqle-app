'use client'

/**
 * ActivityPanel — reusable Odoo-style "chatter" for any entity.
 *
 * Shows the entity's activity-log timeline (auto-logged system events) and lets
 * an authorised user post free-text log notes. Generalises the employee-only
 * `payroll/_activity-timeline.tsx`; backed by the generic server actions in
 * `src/lib/activity/actions.ts`.
 *
 * Lazy by nature — fetches only when mounted (e.g. when a detail modal/tab opens).
 */

import { useEffect, useState, useTransition } from 'react'
import {
  MessageSquarePlus, RefreshCw, Clock, CheckCircle2, Trash2, RotateCcw,
  User, FileText, DollarSign, StickyNote, Info, BarChart2, Users,
} from 'lucide-react'
import { fetchEntityActivity, postEntityNote } from '@/lib/activity/actions'
import type { ActivityLogRow } from '@/lib/activity/actions'
import type { EntityType } from '@/lib/activity/log'
import { usePermissions } from '@/contexts/permission-context'

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins  = Math.floor(diff / 60_000)
  const hrs   = Math.floor(diff / 3_600_000)
  const days  = Math.floor(diff / 86_400_000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (hrs  < 24) return `${hrs}h ago`
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })
}

function actionLabel(action: string, entityType: string): string {
  const map: Record<string, string> = {
    created:              entityType === 'employee' ? 'Employee created' : 'Task created',
    edited:               entityType === 'employee' ? 'Profile updated'  : 'Task edited',
    updated:              'Task edited',
    deleted:              'Moved to Trash',
    restored:             'Restored from Trash',
    status_changed:       'Status changed',
    assigned:             'Team assigned',
    employee_created:     'Employee added',
    employee_archived:    'Archived',
    designation_changed:  'Designation changed',
    payroll_generated:    'Payroll generated',
    marked_paid:          'Payroll marked paid',
    advance_added:        'Advance added',
    credit_added:         'Credit added',
    contribution_saved:   'Contribution saved',
    scored:               'Score calculated',
    score_recalculated:   'Score recalculated',
    note:                 'Note',
  }
  return map[action] ?? action.replace(/_/g, ' ')
}

function ActionIcon({ action, entityType }: { action: string; entityType: string }) {
  const cls = 'w-3.5 h-3.5'
  if (action === 'note')                   return <StickyNote     className={cls} />
  if (action === 'deleted')                return <Trash2         className={cls} />
  if (action === 'restored')               return <RotateCcw      className={cls} />
  if (action === 'status_changed')         return <CheckCircle2   className={cls} />
  if (action === 'assigned')               return <Users          className={cls} />
  if (action === 'marked_paid')            return <DollarSign     className={cls} />
  if (action.startsWith('contribution') || action === 'scored' || action === 'score_recalculated')
                                           return <BarChart2      className={cls} />
  if (action.startsWith('employee'))       return <User           className={cls} />
  if (action === 'designation_changed')    return <User           className={cls} />
  if (entityType === 'task')               return <FileText       className={cls} />
  if (entityType === 'payroll')            return <DollarSign     className={cls} />
  return <Info className={cls} />
}

function actionColor(action: string): string {
  if (action === 'note')                 return 'text-amber-500   bg-amber-400/10  border-amber-400/20 dark:text-amber-400'
  if (action === 'deleted')              return 'text-red-500     bg-red-400/10    border-red-400/20   dark:text-red-400'
  if (action === 'restored')             return 'text-green-600   bg-green-400/10  border-green-400/20 dark:text-green-400'
  if (action === 'marked_paid')          return 'text-green-600   bg-green-400/10  border-green-400/20 dark:text-green-400'
  if (action === 'employee_archived')    return 'text-red-500     bg-red-400/10    border-red-400/20   dark:text-red-400'
  if (action === 'status_changed')       return 'text-blue-600    bg-blue-400/10   border-blue-400/20  dark:text-blue-400'
  if (action === 'assigned')             return 'text-violet-600  bg-violet-400/10 border-violet-400/20 dark:text-violet-400'
  if (action === 'contribution_saved' || action === 'scored' || action === 'score_recalculated')
                                         return 'text-purple-600  bg-purple-400/10 border-purple-400/20 dark:text-purple-400'
  return 'text-muted-foreground bg-secondary border-border'
}

function DetailLine({ detail, action }: { detail: Record<string, unknown> | null; action: string }) {
  if (!detail) return null

  // Status changed — show "pending → done"
  if (action === 'status_changed' && (detail.from || detail.to)) {
    return (
      <span className="text-[11px] text-muted-foreground">
        {String(detail.from ?? '—')} → <span className="text-foreground">{String(detail.to ?? '—')}</span>
        {detail.title ? ` · ${String(detail.title)}` : ''}
      </span>
    )
  }

  // Contribution saved — show how many employees were scored
  if (action === 'contribution_saved' && detail.employees != null) {
    const n = Number(detail.employees)
    return (
      <span className="text-[11px] text-muted-foreground">
        {n} {n === 1 ? 'employee' : 'employees'} scored{detail.title ? ` · ${String(detail.title)}` : ''}
      </span>
    )
  }

  // Team assigned — list employee labels if present
  if (action === 'assigned' && Array.isArray(detail.employees)) {
    const names = (detail.employees as unknown[]).map(String).filter(Boolean)
    return (
      <span className="text-[11px] text-muted-foreground truncate">
        {names.length ? names.join(', ') : 'Assignment updated'}
      </span>
    )
  }

  // Payroll paid
  if (action === 'marked_paid' && detail.net) {
    return (
      <span className="text-[11px] text-muted-foreground">
        ₹{Number(detail.net).toLocaleString('en-IN')}
        {detail.month && detail.year ? ` · ${detail.month}/${detail.year}` : ''}
      </span>
    )
  }

  // Generic: show a title if present
  if (detail.title) {
    return <span className="text-[11px] text-muted-foreground truncate">{String(detail.title)}</span>
  }

  return null
}

// ── Main component ─────────────────────────────────────────────────────────────

interface Props {
  entityType: EntityType
  entityId: string
  /** Show the "Add note" affordance. Defaults to admin-only (matches payroll). */
  canNote?: boolean
  /** Optional heading override. */
  title?: string
}

// Which permission lets a user post a note on each entity's feed.
const NOTE_PERM: Partial<Record<EntityType, string>> = {
  task:         'tasks.edit',
  contribution: 'contributions.edit',
}

export default function ActivityPanel({ entityType, entityId, canNote, title = 'Activity Log' }: Props) {
  const { user, can } = usePermissions()
  const permKey = NOTE_PERM[entityType]
  const allowNote = canNote ?? (permKey ? can(permKey) : user.isAdmin)

  const [rows, setRows]            = useState<ActivityLogRow[]>([])
  const [loading, setLoading]      = useState(true)
  const [setupNeeded, setSetup]    = useState(false)
  const [noteText, setNoteText]    = useState('')
  const [showNote, setShowNote]    = useState(false)
  const [pending, startTransition] = useTransition()

  async function load() {
    setLoading(true)
    const res = await fetchEntityActivity(entityType, entityId, 50)
    if (res.ok) { setRows(res.rows); setSetup(!!res.setupNeeded) }
    setLoading(false)
  }

  useEffect(() => { if (entityId) load() }, [entityType, entityId])

  function submitNote(e: React.FormEvent) {
    e.preventDefault()
    if (!noteText.trim()) return
    startTransition(async () => {
      const res = await postEntityNote(entityType, entityId, noteText.trim())
      if (res.ok) {
        setNoteText('')
        setShowNote(false)
        await load()
      }
    })
  }

  return (
    <div>
      {/* Header row */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5" /> {title}
        </h3>
        <div className="flex items-center gap-1.5">
          {allowNote && (
            <button
              type="button"
              onClick={() => setShowNote(o => !o)}
              className="inline-flex items-center gap-1 text-[11px] text-violet-600 dark:text-violet-400 hover:text-violet-500 dark:hover:text-violet-300 border border-violet-500/30 rounded-lg px-2 py-1 bg-violet-500/5 hover:bg-violet-500/10 transition-colors"
            >
              <MessageSquarePlus className="w-3 h-3" /> Log note
            </button>
          )}
          <button
            type="button"
            onClick={load}
            disabled={loading}
            title="Refresh"
            className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-40"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Add note form */}
      {showNote && allowNote && (
        <form onSubmit={submitNote} className="mb-3 bg-amber-500/5 border border-amber-500/20 rounded-xl p-3 space-y-2">
          <textarea
            value={noteText}
            onChange={e => setNoteText(e.target.value)}
            placeholder="Add a log note…"
            rows={2}
            autoFocus
            className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => { setShowNote(false); setNoteText('') }}
              className="text-xs text-muted-foreground hover:text-foreground px-2 py-1"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending || !noteText.trim()}
              className="text-xs gradient-bg text-white rounded-lg px-3 py-1 hover:opacity-90 disabled:opacity-50"
            >
              {pending ? 'Saving…' : 'Save note'}
            </button>
          </div>
        </form>
      )}

      {/* Timeline */}
      {loading ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground text-xs gap-2">
          <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Loading activity…
        </div>
      ) : setupNeeded ? (
        <div className="text-center py-6 text-muted-foreground text-xs">
          Activity history isn’t enabled yet.
          <p className="mt-1 opacity-60">Run migration <code>010_activity_logs.sql</code> in Supabase to turn it on.</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center py-6 text-muted-foreground text-xs">
          No activity recorded yet.
          <p className="mt-1 opacity-60">Events will appear here as actions are taken.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map(row => {
            const actor = Array.isArray(row.actor) ? row.actor[0] : row.actor
            return (
              <div key={row.id} className="flex items-start gap-2.5">
                {/* Icon */}
                <div className={`shrink-0 w-6 h-6 rounded-full border flex items-center justify-center mt-0.5 ${actionColor(row.action)}`}>
                  <ActionIcon action={row.action} entityType={row.entity_type} />
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[12px] font-medium text-foreground">
                      {actionLabel(row.action, row.entity_type)}
                    </span>
                    {actor?.cqid && (
                      <span className="text-[10px] text-muted-foreground">
                        by {actor.name || actor.cqid}
                      </span>
                    )}
                    <span className="text-[10px] text-muted-foreground/50 ml-auto shrink-0">
                      {formatRelative(row.created_at)}
                    </span>
                  </div>

                  {/* Note text */}
                  {row.note && (
                    <p className="text-[12px] text-amber-600 dark:text-amber-300 mt-0.5 italic">“{row.note}”</p>
                  )}

                  {/* Detail line */}
                  {!row.note && row.detail && (
                    <DetailLine detail={row.detail as Record<string, unknown>} action={row.action} />
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

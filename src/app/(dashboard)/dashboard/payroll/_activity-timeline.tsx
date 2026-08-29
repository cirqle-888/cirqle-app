'use client'

/**
 * EmployeeActivityTimeline — Odoo-style chatter for an employee.
 * Shows recent activity log rows + allows admin to add manual notes.
 * Lazy-loaded so it only fetches data when the employee detail modal opens.
 */

import { useEffect, useState, useTransition } from 'react'
import { MessageSquarePlus, RefreshCw, Clock, CheckCircle2, Trash2, RotateCcw, User, FileText, DollarSign, StickyNote, Info } from 'lucide-react'
import { fetchEmployeeActivity, addEmployeeNote } from './activity-actions'
import type { ActivityLogRow } from './activity-actions'
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
  if (action === 'marked_paid')            return <DollarSign     className={cls} />
  if (action.startsWith('employee'))       return <User           className={cls} />
  if (action === 'designation_changed')    return <User           className={cls} />
  if (entityType === 'task')               return <FileText       className={cls} />
  if (entityType === 'payroll')            return <DollarSign     className={cls} />
  return <Info className={cls} />
}

function actionColor(action: string): string {
  if (action === 'note')                 return 'text-amber-400  bg-amber-400/10  border-amber-400/20'
  if (action === 'deleted')              return 'text-red-400    bg-red-400/10    border-red-400/20'
  if (action === 'restored')             return 'text-green-400  bg-green-400/10  border-green-400/20'
  if (action === 'marked_paid')          return 'text-green-400  bg-green-400/10  border-green-400/20'
  if (action === 'employee_archived')    return 'text-red-400    bg-red-400/10    border-red-400/20'
  if (action === 'status_changed')       return 'text-blue-400   bg-blue-400/10   border-blue-400/20'
  return 'text-muted-foreground bg-secondary border-border'
}

function DetailLine({ detail, action }: { detail: Record<string, unknown> | null; action: string }) {
  if (!detail) return null

  // Status changed — show "Pending → Done"
  if (action === 'status_changed' && detail.from && detail.to) {
    return (
      <span className="text-[11px] text-muted-foreground">
        {String(detail.from)} → <span className="text-foreground">{String(detail.to)}</span>
        {detail.title ? ` · ${String(detail.title)}` : ''}
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

  // Designation changed
  if (action === 'designation_changed') {
    return (
      <span className="text-[11px] text-muted-foreground">
        Designation updated
      </span>
    )
  }

  // Generic: show task title if present
  if (detail.title) {
    return <span className="text-[11px] text-muted-foreground truncate">{String(detail.title)}</span>
  }

  return null
}

// ── Main component ─────────────────────────────────────────────────────────────

interface Props {
  employeeId: string
}

export function EmployeeActivityTimeline({ employeeId }: Props) {
  const { user } = usePermissions()
  const [rows, setRows]           = useState<ActivityLogRow[]>([])
  const [loading, setLoading]     = useState(true)
  const [noteText, setNoteText]   = useState('')
  const [showNote, setShowNote]   = useState(false)
  const [pending, startTransition] = useTransition()

  async function load() {
    setLoading(true)
    const res = await fetchEmployeeActivity(employeeId, 40)
    if (res.ok) setRows(res.rows)
    setLoading(false)
  }

  useEffect(() => { load() }, [employeeId])

  async function submitNote(e: React.FormEvent) {
    e.preventDefault()
    if (!noteText.trim()) return
    startTransition(async () => {
      const res = await addEmployeeNote(employeeId, noteText.trim())
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
          <Clock className="w-3.5 h-3.5" /> Activity Log
        </h3>
        <div className="flex items-center gap-1.5">
          {user.isAdmin && (
            <button
              onClick={() => setShowNote(o => !o)}
              className="inline-flex items-center gap-1 text-[11px] text-violet-400 hover:text-violet-700 dark:text-violet-300 border border-violet-500/30 rounded-lg px-2 py-1 bg-violet-500/5 hover:bg-violet-500/10 transition-colors"
            >
              <MessageSquarePlus className="w-3 h-3" /> Add note
            </button>
          )}
          <button
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
      {showNote && (
        <form onSubmit={submitNote} className="mb-3 bg-amber-500/5 border border-amber-500/20 rounded-xl p-3 space-y-2">
          <textarea
            value={noteText}
            onChange={e => setNoteText(e.target.value)}
            placeholder="Add a note about this employee…"
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
                        by {actor.cqid}
                      </span>
                    )}
                    <span className="text-[10px] text-muted-foreground/50 ml-auto shrink-0">
                      {formatRelative(row.created_at)}
                    </span>
                  </div>

                  {/* Note text */}
                  {row.note && (
                    <p className="text-[12px] text-amber-700 dark:text-amber-300 mt-0.5 italic">&quot;{row.note}&quot;</p>
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

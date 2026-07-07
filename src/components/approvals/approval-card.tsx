'use client'

/**
 * <ApprovalCard> — the approval request card (chat + inbox).
 *
 * Chat usage: a kind='approval' message carries metadata.approvalId; the card
 * loads full state on mount and re-loads when the message metadata changes
 * (the decide action bumps metadata → realtime UPDATE → parent re-renders us
 * with a new statusHint). Buttons show only for eligible approvers.
 */

import { useEffect, useState, useTransition } from 'react'
import { usePermissions } from '@/contexts/permission-context'
import { displayEmployee } from '@/lib/utils/employee-display'
import { CheckCircle2, XCircle, PencilLine, MessageSquarePlus, History, Ban, Clock } from 'lucide-react'
import {
  getApproval, decideApproval, commentOnApproval, cancelApproval,
  type ApprovalSummary, type ApprovalEvent,
} from '@/lib/approvals/actions'

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  pending:            { label: 'Pending',           cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  approved:           { label: 'Approved',          cls: 'bg-green-500/15 text-green-600 dark:text-green-400' },
  rejected:           { label: 'Rejected',          cls: 'bg-red-500/15 text-red-600 dark:text-red-400' },
  changes_requested:  { label: 'Changes requested', cls: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
  cancelled:          { label: 'Cancelled',         cls: 'bg-muted text-muted-foreground' },
}

const EVENT_LABEL: Record<string, string> = {
  requested: 'requested this approval',
  approved: 'approved',
  rejected: 'rejected',
  changes_requested: 'requested changes',
  commented: 'commented',
  version_added: 'added a version',
  cancelled: 'cancelled the request',
  reopened: 'reopened',
}

export function ApprovalCard({ approvalId, statusHint, meId, compact = false }: {
  approvalId: string
  /** From message metadata — a change re-triggers the fetch. */
  statusHint?: string
  meId: string
  compact?: boolean
}) {
  const [approval, setApproval] = useState<ApprovalSummary | null>(null)
  const [events, setEvents] = useState<ApprovalEvent[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [comment, setComment] = useState('')
  const [showComment, setShowComment] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // Privacy: CQID-first (approverLabel for a named person arrives as "CQID||Name")
  const { revealNames } = usePermissions()
  const mask = (name?: string | null, cqid?: string | null) =>
    displayEmployee({ name: name ?? '', cqid: cqid ?? '' }, { revealNames, canReveal: true })
  const maskLabel = (label: string) =>
    label.includes('||') ? mask(label.split('||')[1], label.split('||')[0]) : label

  useEffect(() => {
    const t = setTimeout(() => {
      startTransition(async () => {
        const res = await getApproval(approvalId)
        if (res.ok) { setApproval(res.data.approval); setEvents(res.data.events) }
        else setError(res.error)
      })
    }, 0)
    return () => clearTimeout(t)
  }, [approvalId, statusHint])

  if (error) return <p className="mt-1 text-xs text-destructive">{error}</p>
  if (!approval) {
    return <div className="mt-1 h-20 w-full max-w-md animate-pulse rounded-xl border border-border bg-muted/40" />
  }

  const style = STATUS_STYLE[approval.status] ?? STATUS_STYLE.pending
  const isRequester = approval.requestedBy.id === meId

  const decide = (decision: 'approved' | 'rejected' | 'changes_requested') => {
    startTransition(async () => {
      const res = await decideApproval({ approvalId, decision, comment: comment.trim() || undefined })
      if (res.ok) {
        setApproval(a => (a ? { ...a, status: res.data.status, canDecide: false } : a))
        setComment(''); setShowComment(false)
        const refreshed = await getApproval(approvalId)
        if (refreshed.ok) { setApproval(refreshed.data.approval); setEvents(refreshed.data.events) }
      } else setError(res.error)
    })
  }

  return (
    <div className={`mt-1 w-full ${compact ? '' : 'max-w-md'} rounded-xl border border-border bg-muted/30 p-3`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-snug">{approval.title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {approval.entityType !== 'other' && <span className="capitalize">{approval.entityType.replace('_', ' ')} · </span>}
            by {mask(approval.requestedBy.name, approval.requestedBy.cqid)} · approver: {maskLabel(approval.approverLabel)}
            {approval.dueAt && (
              <span className="ml-1 inline-flex items-center gap-0.5">
                <Clock className="h-3 w-3" /> due {new Date(approval.dueAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${style.cls}`}>{style.label}</span>
          {approval.totalSteps > 1 && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              Step {approval.step} / {approval.totalSteps}
            </span>
          )}
        </div>
      </div>

      {approval.description && (
        <p className="mt-2 whitespace-pre-wrap text-sm text-foreground/90">{approval.description}</p>
      )}

      {approval.status !== 'pending' && approval.decidedBy && (
        <p className="mt-2 text-xs text-muted-foreground">
          {style.label} by <span className="font-medium">{mask(approval.decidedBy.name, approval.decidedBy.cqid)}</span>
          {approval.decidedAt && ` · ${new Date(approval.decidedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`}
        </p>
      )}

      {/* Decision buttons — eligible approvers only */}
      {approval.status === 'pending' && approval.canDecide && (
        <>
          {showComment && (
            <textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder="Optional comment…"
              rows={2}
              className="mt-2 w-full resize-none rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-foreground/40"
            />
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <button onClick={() => decide('approved')} disabled={pending}
              className="inline-flex items-center gap-1 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50">
              <CheckCircle2 className="h-3.5 w-3.5" /> Approve
            </button>
            <button onClick={() => decide('rejected')} disabled={pending}
              className="inline-flex items-center gap-1 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50">
              <XCircle className="h-3.5 w-3.5" /> Reject
            </button>
            <button onClick={() => decide('changes_requested')} disabled={pending}
              className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50">
              <PencilLine className="h-3.5 w-3.5" /> Request changes
            </button>
            <button onClick={() => setShowComment(v => !v)}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground">
              <MessageSquarePlus className="h-3.5 w-3.5" /> {showComment ? 'Hide comment' : 'Comment'}
            </button>
          </div>
        </>
      )}

      {/* Requester: cancel while pending */}
      {approval.status === 'pending' && isRequester && (
        <button onClick={() => startTransition(async () => {
            const res = await cancelApproval(approvalId)
            if (res.ok) setApproval(a => (a ? { ...a, status: 'cancelled', canDecide: false } : a))
            else setError(res.error)
          })}
          disabled={pending}
          className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive disabled:opacity-50">
          <Ban className="h-3 w-3" /> Cancel request
        </button>
      )}

      {/* History */}
      <button onClick={() => setShowHistory(v => !v)}
        className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <History className="h-3 w-3" /> {showHistory ? 'Hide history' : `History (${events.length})`}
      </button>
      {showHistory && (
        <div className="mt-1.5 space-y-1 border-l-2 border-border pl-3">
          {events.map(e => (
            <p key={e.id} className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground/80">{e.actor ? mask(e.actor.name, e.actor.cqid) : 'System'}</span>{' '}
              {EVENT_LABEL[e.event] ?? e.event}
              {e.comment && <> — “{e.comment}”</>}
              <span className="ml-1 opacity-70">
                {new Date(e.createdAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
              </span>
            </p>
          ))}
          {/* Post a comment into the history from here */}
          <CommentBox approvalId={approvalId} onPosted={async () => {
            const res = await getApproval(approvalId)
            if (res.ok) setEvents(res.data.events)
          }} />
        </div>
      )}
    </div>
  )
}

function CommentBox({ approvalId, onPosted }: { approvalId: string; onPosted: () => Promise<void> }) {
  const [text, setText] = useState('')
  const [pending, startTransition] = useTransition()
  return (
    <div className="flex items-center gap-1.5 pt-1">
      <input
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && text.trim()) {
            const t = text
            setText('')
            startTransition(async () => { await commentOnApproval(approvalId, t); await onPosted() })
          }
        }}
        placeholder="Add a comment…"
        className="w-full rounded-lg border border-border bg-background px-2 py-1 text-xs outline-none focus:border-foreground/40"
        disabled={pending}
      />
    </div>
  )
}

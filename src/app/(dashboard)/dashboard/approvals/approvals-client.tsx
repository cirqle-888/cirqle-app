'use client'

/**
 * Approvals inbox — two tabs (Awaiting me / My requests), each row expands
 * into the same <ApprovalCard> used in chat (one card implementation).
 */

import { useCallback, useEffect, useState, useTransition } from 'react'
import { RefreshCw, Plus, Inbox } from 'lucide-react'
import { getApprovals, type ApprovalSummary } from '@/lib/approvals/actions'
import { ApprovalCard } from '@/components/approvals/approval-card'
import { RequestApprovalDialog } from '@/components/approvals/request-approval-dialog'

type Tab = 'awaiting_me' | 'my_requests'

const STATUS_DOT: Record<string, string> = {
  pending: 'bg-amber-500', approved: 'bg-green-500', rejected: 'bg-red-500',
  changes_requested: 'bg-blue-500', cancelled: 'bg-muted-foreground/40',
}

export function ApprovalsClient({ meId }: { meId: string }) {
  const [tab, setTab] = useState<Tab>('awaiting_me')
  const [rows, setRows] = useState<ApprovalSummary[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showDialog, setShowDialog] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const load = useCallback((t: Tab) => {
    startTransition(async () => {
      const res = await getApprovals(t)
      if (res.ok) { setRows(res.data); setError(null) }
      else setError(res.error)
    })
  }, [])

  useEffect(() => {
    const t0 = setTimeout(() => load(tab), 0)
    return () => clearTimeout(t0)
  }, [tab, load])

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign-offs for designs, invoices, tasks, expenses and more.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => load(tab)} className="rounded-lg border border-border p-2 text-muted-foreground hover:text-foreground" aria-label="Refresh">
            <RefreshCw className={`h-4 w-4 ${pending ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={() => setShowDialog(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-background">
            <Plus className="h-4 w-4" /> New request
          </button>
        </div>
      </div>

      <div className="mb-4 flex gap-1 rounded-lg bg-muted p-0.5 w-fit">
        {([['awaiting_me', 'Awaiting me'], ['my_requests', 'My requests']] as [Tab, string][]).map(([key, label]) => (
          <button key={key} onClick={() => { setTab(key); setExpanded(null) }}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === key ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {!error && rows.length === 0 && !pending && (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-12 text-muted-foreground">
          <Inbox className="h-7 w-7" />
          <p className="text-sm">{tab === 'awaiting_me' ? 'Nothing waiting on you. 🎉' : 'You have not requested any approvals yet.'}</p>
        </div>
      )}

      <div className="space-y-2">
        {rows.map(r => (
          <div key={r.id} className="rounded-xl border border-border">
            <button onClick={() => setExpanded(e => (e === r.id ? null : r.id))}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40">
              <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[r.status] ?? 'bg-muted-foreground/40'}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{r.title}</span>
                <span className="block text-xs text-muted-foreground">
                  <span className="capitalize">{r.entityType.replace('_', ' ')}</span>
                  {' · '}{tab === 'awaiting_me' ? `from ${r.requestedBy.name}` : `approver: ${r.approverLabel}`}
                  {' · '}{new Date(r.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                  {r.dueAt && ` · due ${new Date(r.dueAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`}
                </span>
              </span>
              <span className="shrink-0 text-xs capitalize text-muted-foreground">{r.status.replace('_', ' ')}</span>
            </button>
            {expanded === r.id && (
              <div className="border-t border-border px-4 py-3">
                <ApprovalCard approvalId={r.id} meId={meId} compact />
              </div>
            )}
          </div>
        ))}
      </div>

      {showDialog && (
        <RequestApprovalDialog
          onClose={() => setShowDialog(false)}
          onCreated={() => { setShowDialog(false); setTab('my_requests'); load('my_requests') }}
        />
      )}
    </div>
  )
}

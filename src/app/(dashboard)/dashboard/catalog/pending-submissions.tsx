'use client'

/**
 * Staff review queue for products clients submitted through their product
 * library link. Sits above the catalog on /dashboard/catalog and renders
 * NOTHING at all when the queue is empty — which is most of the time.
 *
 * LIGHT theme: theme tokens only (text-foreground / text-muted-foreground /
 * bg-card / bg-secondary / border-border). text-white here renders invisible.
 */

import { useState } from 'react'
import { Check, X, Loader2, ImageOff, Inbox, AlertTriangle } from 'lucide-react'
import { approveSubmission, rejectSubmission, type PendingSubmission } from './actions'

function timeAgo(iso: string | null): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const mins = Math.floor((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

function localNames(names: Record<string, string> | null | undefined): string {
  if (!names) return ''
  return Object.entries(names)
    .filter(([, v]) => typeof v === 'string' && v.trim())
    .map(([lang, v]) => `${v} (${lang})`)
    .join(' · ')
}

export default function PendingSubmissions({ items }: { items: PendingSubmission[] }) {
  const [rows, setRows] = useState<PendingSubmission[]>(items)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Usually empty — render nothing rather than an empty-state card.
  if (rows.length === 0) return null

  async function act(id: string, kind: 'approve' | 'reject') {
    setBusyId(id)
    setError(null)
    const res = kind === 'approve' ? await approveSubmission(id) : await rejectSubmission(id)
    setBusyId(null)
    if (!res.ok) {
      setError(res.error || 'Could not update this submission.')
      return
    }
    setRows(prev => prev.filter(r => r.id !== id))
  }

  return (
    <section className="mb-6 rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-center gap-2 mb-4">
        <Inbox className="w-4 h-4 text-violet-500 shrink-0" />
        <h2 className="text-sm font-semibold text-foreground">Pending client submissions</h2>
        <span className="inline-flex items-center justify-center min-w-[1.35rem] h-5 px-1.5 rounded-full bg-violet-500/10 text-violet-600 text-[11px] font-semibold">
          {rows.length}
        </span>
      </div>

      {error && (
        <div className="flex items-start gap-2 mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 text-amber-500 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <ul className="space-y-2">
        {rows.map(row => {
          const busy = busyId === row.id
          const local = localNames(row.names)
          return (
            <li
              key={row.id}
              className="flex items-center gap-3 rounded-xl border border-border bg-secondary px-3 py-2.5"
            >
              {row.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={row.image_url}
                  alt={row.name}
                  className="w-12 h-12 rounded-lg object-cover border border-border shrink-0"
                />
              ) : (
                <div className="w-12 h-12 rounded-lg border border-border bg-card flex items-center justify-center shrink-0">
                  <ImageOff className="w-4 h-4 text-muted-foreground" />
                </div>
              )}

              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground truncate">{row.name}</div>
                {local && (
                  <div className="text-xs text-muted-foreground truncate">{local}</div>
                )}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground mt-0.5">
                  {row.category && (
                    <span className="px-1.5 py-0.5 rounded bg-card border border-border">{row.category}</span>
                  )}
                  <span className="truncate">{row.client_name || 'Unknown client'}</span>
                  {row.submitted_at && <span>· {timeAgo(row.submitted_at)}</span>}
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {busy ? (
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => act(row.id, 'approve')}
                      title="Approve"
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 transition-colors"
                    >
                      <Check className="w-3.5 h-3.5" />
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => act(row.id, 'reject')}
                      title="Reject"
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                    >
                      <X className="w-3.5 h-3.5" />
                      Reject
                    </button>
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

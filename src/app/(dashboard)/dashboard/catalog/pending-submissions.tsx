'use client'

/**
 * Staff triage queue for new products.
 *
 * Most arrive with a client's weekly offer list — that is when new products
 * actually turn up — where the client types only a name, a photo and a price.
 * Everything else is the employee's job, so each row is EDITABLE: fix the
 * title, pick a category, add the Malayalam name, then approve. Approving
 * saves those edits and lets the product join the shared catalog.
 *
 * Sits above the catalog on /dashboard/catalog and renders NOTHING at all when
 * the queue is empty — which is most of the time.
 *
 * LIGHT theme: theme tokens only (text-foreground / text-muted-foreground /
 * bg-card / bg-secondary / border-border). text-white here renders invisible.
 */

import { useState } from 'react'
import { Check, X, Loader2, ImageOff, Inbox, AlertTriangle } from 'lucide-react'
import { approveSubmission, rejectSubmission, updateSubmission, type PendingSubmission } from './actions'

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

/** Staff-facing buckets. Kept short on purpose — a long list slows triage. */
const CATEGORIES = ['Vegetables', 'Fruits', 'Groceries', 'Dairy', 'Meat & Fish', 'Other']

type Draft = { name: string; category: string; localName: string }

export default function PendingSubmissions({ items }: { items: PendingSubmission[] }) {
  // Rows are DERIVED from props rather than copied into state, so a submission
  // that lands after first paint shows up on the next server render instead of
  // waiting for a hard reload. State holds only what the server cannot know:
  // which rows this session has already dealt with, and any in-progress edits.
  const [handled, setHandled] = useState<Set<string>>(() => new Set())
  const [drafts, setDrafts] = useState<Record<string, Partial<Draft>>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const rows = items.filter(i => !handled.has(i.id))

  // Usually empty — render nothing rather than an empty-state card.
  if (rows.length === 0) return null

  function edit(id: string, patch: Partial<Draft>) {
    setDrafts(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }))
  }

  /** The row's server values, with any unsaved edit laid over the top. */
  function draftFor(row: PendingSubmission): Draft {
    const d = drafts[row.id] || {}
    return {
      name: d.name ?? row.name,
      category: d.category ?? (row.category || ''),
      localName: d.localName ?? (row.names?.ml || ''),
    }
  }

  async function act(id: string, kind: 'approve' | 'reject') {
    setBusyId(id)
    setError(null)

    // Approving saves the employee's edits first: the whole point of the queue
    // is that the client's raw name and missing category get fixed on the way
    // in. Rejecting skips the save — there is no reason to tidy a row that is
    // about to be turned away.
    if (kind === 'approve') {
      const row = rows.find(r => r.id === id)
      const d = row ? draftFor(row) : null
      const changed = d && row && (
        d.name.trim() !== row.name ||
        (d.category || null) !== (row.category || null) ||
        d.localName.trim() !== (row.names?.ml || '')
      )
      if (changed) {
        const saved = await updateSubmission(id, {
          name: d.name,
          category: d.category || null,
          localName: d.localName,
        })
        if (!saved.ok) {
          setBusyId(null)
          setError(saved.error || 'Could not save your changes.')
          return
        }
      }
    }

    const res = kind === 'approve' ? await approveSubmission(id) : await rejectSubmission(id)
    setBusyId(null)
    if (!res.ok) {
      setError(res.error || 'Could not update this submission.')
      return
    }
    setHandled(prev => new Set(prev).add(id))
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
          const draft = draftFor(row)
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

              {/* Editable, because the client only types a name and a photo —
                  the title, category and local name are the employee's job. */}
              <div className="min-w-0 flex-1 space-y-1.5">
                <input
                  value={draft.name}
                  onChange={e => edit(row.id, { name: e.target.value })}
                  placeholder="Product name"
                  aria-label="Product name"
                  className="w-full bg-card border border-border rounded-lg px-2 py-1 text-sm font-medium text-foreground focus:outline-none focus:border-violet-500/50"
                />
                <div className="flex flex-wrap gap-1.5">
                  <input
                    value={draft.localName}
                    onChange={e => edit(row.id, { localName: e.target.value })}
                    placeholder="Malayalam / local name"
                    aria-label="Local name"
                    className="flex-1 min-w-[9rem] bg-card border border-border rounded-lg px-2 py-1 text-xs text-foreground focus:outline-none focus:border-violet-500/50"
                  />
                  <select
                    value={draft.category}
                    onChange={e => edit(row.id, { category: e.target.value })}
                    aria-label="Category"
                    className="bg-card border border-border rounded-lg px-2 py-1 text-xs text-foreground focus:outline-none focus:border-violet-500/50"
                  >
                    <option value="">No category</option>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                  <span className="truncate">{row.client_name || 'Unknown client'}</span>
                  {row.submitted_at && <span>· {timeAgo(row.submitted_at)}</span>}
                  {local && !draft.localName && <span>· was {local}</span>}
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

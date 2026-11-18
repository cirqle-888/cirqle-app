'use client'

/**
 * "Add to Social Calendar" — paste the answer an outside AI gave (a monthly
 * calendar, fresh ideas or today's trends) and create every item in the
 * client's plan in one go. The table is read in the browser as you paste, so
 * you see exactly what will be added before anything is saved. Items land as
 * PLANNED (undated ones on the Idea Board); nothing is sent to Requests.
 */

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ClipboardPaste } from 'lucide-react'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { usePermissions } from '@/contexts/permission-context'
import { parsePlan, planMonthIn } from '@/lib/social/plan-import'
import { importPlanItems } from '@/app/(dashboard)/dashboard/social-calendar/actions'

const refCount = (it: { links?: unknown[] | null; images?: unknown[] | null }) => (it.links?.length ?? 0) + (it.images?.length ?? 0)

const KIND_LABEL = { detailed: 'full briefs', calendar: 'calendar', ideas: 'ideas', trends: 'trends', unknown: '' } as const

/** This month, or the next once this one is nearly over: 'YYYY-MM'. */
function planMonthNow(): string {
  const t = new Date()
  const d = new Date(t.getFullYear(), t.getMonth() + (t.getDate() >= 20 ? 1 : 0), 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function ImportPlanButton({
  clientId,
  clientName,
  month,
  text = '',
  label = 'Import from AI',
  onDone,
  className = '',
}: {
  clientId: string
  clientName?: string | null
  /** 'YYYY-MM' of the plan to add to; defaults to the month being planned now. */
  month?: string
  /** Start with this text in the box (the Answer in Prompt Studio). */
  text?: string
  label?: string
  /** Called after items are added, e.g. to refresh the calendar behind. */
  onDone?: () => void
  className?: string
}) {
  const { can } = usePermissions()
  const [open, setOpen] = useState(false)
  if (!clientId || !can('social.manage')) return null
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Paste a calendar, ideas or trends from an AI and add them all to this client's plan"
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium transition-colors hover:border-primary/40 ${className}`}
      >
        <ClipboardPaste className="h-4 w-4 text-violet-500" /> {label}
      </button>
      {open && (
        <ImportPlanDialog
          clientId={clientId}
          clientName={clientName}
          month={month}
          text={text}
          onClose={() => setOpen(false)}
          onDone={onDone}
        />
      )}
    </>
  )
}

function ImportPlanDialog({
  clientId, clientName, month: givenMonth, text: givenText, onClose, onDone,
}: {
  clientId: string
  clientName?: string | null
  month?: string
  text: string
  onClose: () => void
  onDone?: () => void
}) {
  const [text, setText] = useState(givenText)
  // The month follows the dates in the pasted answer until the planner picks one herself.
  const [picked, setPicked] = useState('')
  const month = picked || planMonthIn(text) || givenMonth || planMonthNow()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<{ added: number; skipped: number; calendarId: string } | null>(null)
  const parsed = useMemo(() => parsePlan(text, month), [text, month])
  const n = parsed.items.length
  const undated = parsed.items.filter(it => !it.date).length

  async function add() {
    if (!n || busy) return
    setBusy(true)
    setError('')
    try {
      const r = await importPlanItems(clientId, month, parsed.items)
      if (!r.ok || !r.data) { setError(r.error || 'Could not add the items.'); return }
      setDone({ added: r.data.added, skipped: r.data.skipped.length, calendarId: r.data.calendarId })
      onDone?.()
    } catch {
      setError('Could not add the items. Check the connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-3 overflow-hidden rounded-t-2xl border border-border bg-card p-5 sm:rounded-2xl">
        <h2 className="text-lg font-semibold">Add to {clientName ? `${clientName}’s` : 'the'} calendar</h2>

        {done ? (
          <>
            <p className="text-sm">
              Added {done.added} item{done.added === 1 ? '' : 's'}
              {done.skipped ? `. ${done.skipped} already in the plan, left as they are` : ''}.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Link
                href={`/dashboard/social-calendar?calendar=${done.calendarId}`}
                className="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-secondary"
                onClick={onClose}
              >
                Open the calendar
              </Link>
              <button type="button" className="rounded-lg gradient-bg px-3 py-2 text-sm font-medium text-white" onClick={onClose}>Done</button>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="mb-1 block text-xs text-muted-foreground">Plan month</span>
                <input type="month" className="field" value={month} onChange={e => e.target.value && setPicked(e.target.value)} />
              </label>
              <p className="flex-1 text-xs text-muted-foreground">
                Paste the whole answer. Only the plan is read.
              </p>
            </div>
            <textarea
              aria-label="The AI's answer"
              className="field min-h-32 w-full flex-none font-mono text-xs"
              style={{ minHeight: 128 }}
              placeholder="Paste the calendar, ideas or trends table here…"
              value={text}
              onChange={e => setText(e.target.value)}
            />

            {text.trim() && !n && (
              <p className="text-sm text-amber-700 dark:text-amber-300">
                {parsed.skipped.length
                  ? 'The plan was found, but no post could be added. Check the plan month above.'
                  : 'No plan found. Ask the AI to answer in the format the prompt gives, and paste it again.'}
              </p>
            )}
            {n > 0 && (
              <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border">
                <p className="sticky top-0 border-b border-border bg-card px-3 py-2 text-sm font-medium">
                  {n} item{n === 1 ? '' : 's'} found ({KIND_LABEL[parsed.kind]})
                  {undated > 0 && (
                    <span className="font-normal text-muted-foreground">
                      {' · '}{undated === n ? 'no dates, so they go' : `${undated} without a date go`} to the Idea Board
                    </span>
                  )}
                </p>
                <ul className="divide-y divide-border text-sm">
                  {parsed.items.map((it, i) => (
                    <li key={i} className="flex gap-3 px-3 py-1.5">
                      <span className="w-20 shrink-0 tabular-nums text-muted-foreground">{it.date ? it.date.slice(5) : 'Idea'}</span>
                      <span className="w-16 shrink-0 capitalize text-muted-foreground">{it.content_type}</span>
                      <span className="min-w-0 flex-1 truncate" title={it.title}>{it.title}</span>
                      {(it.notes || it.links?.length || it.images?.length) ? (
                        <span className="shrink-0 text-xs text-muted-foreground" title={it.notes ?? ''}>
                          brief{refCount(it) ? ` · ${refCount(it)} ref${refCount(it) === 1 ? '' : 's'}` : ''}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {parsed.skipped.length > 0 && (
              <details className="text-xs text-amber-700 dark:text-amber-300">
                <summary className="cursor-pointer">{parsed.skipped.length} row{parsed.skipped.length === 1 ? '' : 's'} left out</summary>
                <ul className="mt-1 space-y-1">
                  {parsed.skipped.map((s, i) => (
                    <li key={i}><span className="font-medium">{s.reason}</span> {s.row.slice(0, 120)}</li>
                  ))}
                </ul>
              </details>
            )}
            {error && <p className="text-sm text-red-500" role="alert">{error}</p>}

            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-secondary" onClick={onClose}>Cancel</button>
              <button
                type="button"
                disabled={!n || busy}
                onClick={() => void add()}
                className="rounded-lg gradient-bg px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? 'Adding…' : n ? `Add ${n} item${n === 1 ? '' : 's'}` : 'Add items'}
              </button>
            </div>
          </>
        )}
      </div>
    </ModalOverlay>
  )
}

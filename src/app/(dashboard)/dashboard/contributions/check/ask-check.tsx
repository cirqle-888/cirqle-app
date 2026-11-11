'use client'

/**
 * "Ask to check" on the Contributions page: send the jobs currently in the
 * filtered list to one person, who confirms their credit on each. The answers
 * come back as a notification. See ./actions.ts.
 */

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Check, ClipboardCheck, Inbox, Link2, Loader2, Send } from 'lucide-react'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import AppSelect from '@/components/ui/app-select'
import { copyToClipboard } from '@/lib/clipboard'
import { MAX_CHECK_JOBS, MAX_CHECK_NOTE } from '@/lib/contributions/check'
import { createContributionCheck } from './actions'

const PILL = 'inline-flex items-center justify-center h-[30px] gap-1 rounded-full border text-[11px] font-medium transition-colors cursor-pointer px-2.5 bg-secondary text-muted-foreground border-foreground/15 hover:text-foreground'

const DEFAULT_NOTE = 'Please go through these jobs and tell me if your credit is right. Tap "I worked on this" on any job you should have a share in.'

export function AskCheckBar({ canAsk, employees, defaultEmployeeId, taskIds, myEmployeeId }: {
  /** Admin / contributions.view_all — only they can send. Everyone gets the inbox link. */
  canAsk: boolean
  employees: { id: string; cqid: string }[]
  defaultEmployeeId: string
  taskIds: string[]
  myEmployeeId: string | null
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      {canAsk && (
        <button type="button" onClick={() => setOpen(true)} disabled={taskIds.length === 0}
          title="Send the jobs in this list to someone to confirm their credit"
          className={`${PILL} disabled:opacity-50 disabled:cursor-not-allowed`}>
          <ClipboardCheck className="w-3.5 h-3.5 shrink-0" /> Ask to check
        </button>
      )}
      <Link href="/dashboard/contributions/check" title="Contribution checks sent to you or by you" className={PILL}>
        <Inbox className="w-3.5 h-3.5 shrink-0" /> Checks
      </Link>
      {open && (
        <AskCheckDialog
          employees={employees.filter(e => e.id !== myEmployeeId)}
          defaultEmployeeId={defaultEmployeeId !== myEmployeeId ? defaultEmployeeId : ''}
          taskIds={taskIds}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function AskCheckDialog({ employees, defaultEmployeeId, taskIds, onClose }: {
  employees: { id: string; cqid: string }[]
  defaultEmployeeId: string
  taskIds: string[]
  onClose: () => void
}) {
  const pathname = usePathname()
  const search = useSearchParams()
  const [employeeId, setEmployeeId] = useState(defaultEmployeeId)
  const [note, setNote] = useState(DEFAULT_NOTE)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState<{ link: string; jobs: number } | null>(null)
  const [copied, setCopied] = useState(false)

  const who = employees.find(e => e.id === employeeId)?.cqid ?? ''
  const jobs = Math.min(taskIds.length, MAX_CHECK_JOBS)

  async function send() {
    setBusy(true); setError('')
    const qs = search.toString()
    const res = await createContributionCheck({ employeeId, taskIds, note, viewHref: qs ? `${pathname}?${qs}` : pathname })
    setBusy(false)
    if (!res.ok || !res.data) { setError(res.error ?? 'Could not send.'); return }
    setSent({ link: res.data.link, jobs: res.data.jobs })
  }

  async function copy() {
    if (!sent) return
    const ok = await copyToClipboard(`${window.location.origin}${sent.link}`)
    if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1800) }
    else setError('Copying is blocked here — open the check and copy the address instead.')
  }

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="w-full sm:max-w-md bg-card border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl">
        <div className="px-5 py-4 border-b border-border">
          <h2 className="font-semibold">{sent ? `Sent to ${who}` : 'Ask someone to check this list'}</h2>
        </div>

        {sent ? (
          <div className="p-5 space-y-4">
            <p className="text-sm text-muted-foreground">
              {who} gets a notification with the {sent.jobs} job{sent.jobs === 1 ? '' : 's'}. They answer each one, and you are notified when the answers are back.
              To nudge them on WhatsApp too, copy the link.
            </p>
            {error && <p className="text-xs text-red-500">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <button onClick={copy} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-secondary">
                {copied ? <Check className="w-3.5 h-3.5" /> : <Link2 className="w-3.5 h-3.5" />} {copied ? 'Copied' : 'Copy link'}
              </button>
              <Link href={sent.link} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-secondary">
                Open the check
              </Link>
              <button onClick={onClose} className="rounded-lg gradient-bg text-white px-3 py-1.5 text-xs font-medium">Done</button>
            </div>
          </div>
        ) : (
          <div className="p-5 space-y-4">
            <div>
              <label className="block text-[11px] font-medium text-muted-foreground mb-1">Who should check</label>
              <AppSelect value={employeeId} onChange={e => setEmployeeId(e.target.value)}>
                <option value="">— select —</option>
                {employees.map(e => <option key={e.id} value={e.id}>{e.cqid}</option>)}
              </AppSelect>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-muted-foreground mb-1">Message</label>
              <textarea value={note} onChange={e => setNote(e.target.value)} rows={3} maxLength={MAX_CHECK_NOTE}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Sends the <b className="text-foreground">{jobs} job{jobs === 1 ? '' : 's'}</b> in this list
              {taskIds.length > MAX_CHECK_JOBS ? ` (the first ${MAX_CHECK_JOBS} of ${taskIds.length} — narrow the filters to send the rest)` : ''}.
              {who ? ` ${who} sees each job with only their own credit, and answers "Credit is right" or "I worked on this".` : ''}
              {' '}Nothing in pay changes until you fix a split.
            </p>
            {error && <p className="text-xs text-red-500">{error}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={onClose} disabled={busy} className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-50">Cancel</button>
              <button onClick={send} disabled={busy || !employeeId || jobs === 0}
                className="inline-flex items-center gap-1.5 rounded-lg gradient-bg text-white px-3 py-1.5 text-xs font-medium disabled:opacity-50">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} Send{who ? ` to ${who}` : ''}
              </button>
            </div>
          </div>
        )}
      </div>
    </ModalOverlay>
  )
}

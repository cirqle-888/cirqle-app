'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Check, Hand, Loader2, Send, ExternalLink, Undo2, Trash2 } from 'lucide-react'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { summarizeCheck, MAX_CHECK_COMMENT, type CheckAnswer, type CheckStatus } from '@/lib/contributions/check'
import { answerCheckItem, answerRestCorrect, sendCheckAnswers, setCheckClosed, deleteCheck } from '../actions'

export interface CheckJob {
  itemId: string
  taskNumber: number | null
  title: string
  date: string | null
  client: string | null
  clientCode: string | null
  service: string | null
  answer: CheckAnswer | null
  comment: string | null
  /** Answering: only their own row. Reviewing: everyone credited. */
  credit: { cqid: string; pct: number; isThem: boolean }[]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const niceDate = (d: string | null) => {
  if (!d) return ''
  const [y, m, day] = d.slice(0, 10).split('-').map(Number)
  return y && m && day ? `${day} ${MONTHS[m - 1]} ${y}` : d
}
const pct = (n: number) => `${Math.round(n * 10) / 10}%`

/** The Contributions page, narrowed to one job by its number. */
const jobHref = (n: number | null) =>
  n == null ? '/dashboard/contributions' : `/dashboard/contributions?sf=${encodeURIComponent(JSON.stringify([{ field: 'task', op: '=', text: String(n) }]))}`

const STATUS_LABEL: Record<CheckStatus, string> = { open: 'Waiting for answers', answered: 'Answered', closed: 'Closed' }
const STATUS_TINT: Record<CheckStatus, string> = {
  open: 'bg-amber-500/12 text-amber-700 border-amber-500/25 dark:text-amber-400',
  answered: 'bg-violet-500/12 text-violet-700 border-violet-500/25 dark:text-violet-300',
  closed: 'bg-green-500/12 text-green-700 border-green-500/25 dark:text-green-400',
}

export default function CheckClient({
  checkId, access, status, employee, requester, note, viewHref, createdAt, answeredAt, jobs: initial,
}: {
  checkId: string
  access: 'answer' | 'review' | 'read'
  status: CheckStatus
  employee: string
  requester: string
  note: string | null
  viewHref: string | null
  createdAt: string
  answeredAt: string | null
  jobs: CheckJob[]
}) {
  const router = useRouter()
  const { toasts, dismiss, success, toastError } = useToast()
  const [jobs, setJobs] = useState(initial)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const s = useMemo(() => summarizeCheck(jobs), [jobs])
  const answering = access === 'answer'

  // Reviewing: the jobs that need a look first.
  const shown = useMemo(
    () => access === 'review' ? [...jobs].sort((a, b) => Number(b.answer === 'worked') - Number(a.answer === 'worked')) : jobs,
    [jobs, access],
  )

  async function answer(job: CheckJob, next: CheckAnswer | null, comment = job.comment) {
    const prev = jobs
    setJobs(js => js.map(j => j.itemId === job.itemId ? { ...j, answer: next, comment: next === 'worked' ? comment : null } : j))
    const res = await answerCheckItem(checkId, job.itemId, next, next === 'worked' ? comment : null)
    if (!res.ok) { setJobs(prev); toastError('Could not save', res.error) }
  }

  async function restCorrect() {
    setBusy('rest')
    const res = await answerRestCorrect(checkId)
    setBusy(null)
    if (!res.ok) { toastError('Could not save', res.error); return }
    setJobs(js => js.map(j => j.answer ? j : { ...j, answer: 'correct', comment: null }))
  }

  async function send() {
    setBusy('send')
    const res = await sendCheckAnswers(checkId)
    setBusy(null)
    if (!res.ok) { toastError('Could not send', res.error); return }
    success(`Sent to ${requester}`, 'Thanks — they will fix anything that needs it.')
    router.refresh()
  }

  async function close(closed: boolean) {
    setBusy('close')
    const res = await setCheckClosed(checkId, closed)
    setBusy(null)
    if (!res.ok) { toastError('Could not update', res.error); return }
    router.refresh()
  }

  async function withdraw() {
    setBusy('delete')
    const res = await deleteCheck(checkId)
    setBusy(null)
    if (!res.ok) { toastError('Could not withdraw', res.error); return }
    router.push('/dashboard/contributions/check')
  }

  return (
    <>
      {/* ── Who, what, where it stands ── */}
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-sm">
            <span className="font-semibold">{requester}</span>
            <span className="text-muted-foreground"> asked </span>
            <span className="font-semibold">{employee}</span>
            <span className="text-muted-foreground"> to check {s.total} job{s.total === 1 ? '' : 's'} · {niceDate(createdAt)}</span>
          </p>
          <span className={`ml-auto px-2 py-0.5 rounded border text-[11px] font-medium ${STATUS_TINT[status]}`}>
            {STATUS_LABEL[status]}{status !== 'open' && answeredAt ? ` · ${niceDate(answeredAt)}` : ''}
          </span>
        </div>
        {note && (
          <p className="text-sm whitespace-pre-wrap rounded-lg bg-secondary/40 border border-border px-3 py-2">{note}</p>
        )}
        <div className="flex flex-wrap gap-2 text-xs tabular-nums">
          <span className="px-2 py-1 rounded-md bg-secondary">{s.correct} credit right</span>
          <span className={`px-2 py-1 rounded-md ${s.worked ? 'bg-rose-500/12 text-rose-700 dark:text-rose-400 font-medium' : 'bg-secondary'}`}>{s.worked} worked on, not credited right</span>
          <span className="px-2 py-1 rounded-md bg-secondary">{s.pending} to answer</span>
        </div>
        {answering && (
          <p className="text-xs text-muted-foreground leading-relaxed">
            For each job, tap <b className="text-foreground">Credit is right</b> if your share shown is correct, or{' '}
            <b className="text-foreground">I worked on this</b> if you should have a share or a different one — say what you did.
            Nothing changes in pay until {requester} fixes it.
          </p>
        )}
        {access === 'review' && (
          <div className="flex flex-wrap items-center gap-2">
            {viewHref && (
              <Link href={viewHref} className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-secondary">
                <ExternalLink className="w-3.5 h-3.5" /> Open the list it was sent from
              </Link>
            )}
            {status === 'answered' && (
              <button onClick={() => close(true)} disabled={busy !== null}
                className="inline-flex items-center gap-1 rounded-lg gradient-bg text-white px-2.5 py-1.5 text-xs font-medium disabled:opacity-50">
                {busy === 'close' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Done — all fixed
              </button>
            )}
            {status === 'closed' && (
              <button onClick={() => close(false)} disabled={busy !== null}
                className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-50">
                <Undo2 className="w-3.5 h-3.5" /> Reopen
              </button>
            )}
            {status === 'open' && (
              <button onClick={() => setConfirmDelete(true)} disabled={busy !== null}
                className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-red-500 hover:bg-red-500/10 disabled:opacity-50">
                <Trash2 className="w-3.5 h-3.5" /> Withdraw
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── The jobs ── */}
      <div className="divide-y divide-border bg-card border border-border rounded-xl">
        {shown.map(j => {
          const mine = j.credit.find(c => c.isThem)
          return (
            <div key={j.itemId} className={`px-4 py-3 space-y-2 ${j.answer === 'worked' && access === 'review' ? 'bg-rose-500/[0.04]' : ''}`}>
              <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {j.taskNumber != null && <span className="mr-1.5 font-mono text-[11px] text-muted-foreground">#{j.taskNumber}</span>}
                    {j.title}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {[j.client && `${j.client}${j.clientCode ? ` ${j.clientCode}` : ''}`, j.service, niceDate(j.date)].filter(Boolean).join(' · ')}
                  </p>
                  <p className="mt-1 text-xs">
                    {access === 'review'
                      ? (j.credit.length
                          ? j.credit.map(c => (
                              <span key={c.cqid} className={`mr-1.5 inline-block rounded px-1.5 py-0.5 ${c.isThem ? 'bg-primary/15 text-primary font-medium' : 'bg-secondary'}`}>{c.cqid} {pct(c.pct)}</span>
                            ))
                          : <span className="text-muted-foreground">Nobody credited yet</span>)
                      : <span className={mine ? 'text-foreground' : 'text-muted-foreground'}>Your credit: <b>{mine ? pct(mine.pct) : 'none'}</b></span>}
                  </p>
                </div>

                {answering ? (
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => answer(j, j.answer === 'correct' ? null : 'correct')}
                      aria-pressed={j.answer === 'correct'}
                      className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${j.answer === 'correct' ? 'bg-green-500 border-green-500 text-white' : 'border-border hover:bg-secondary'}`}>
                      <Check className="w-3.5 h-3.5" /> Credit is right
                    </button>
                    <button
                      onClick={() => answer(j, j.answer === 'worked' ? null : 'worked')}
                      aria-pressed={j.answer === 'worked'}
                      className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${j.answer === 'worked' ? 'bg-rose-500 border-rose-500 text-white' : 'border-border hover:bg-secondary'}`}>
                      <Hand className="w-3.5 h-3.5" /> I worked on this
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${j.answer === 'worked' ? 'bg-rose-500/12 text-rose-700 dark:text-rose-400' : j.answer === 'correct' ? 'bg-green-500/12 text-green-700 dark:text-green-400' : 'bg-secondary text-muted-foreground'}`}>
                      {j.answer === 'worked' ? 'Worked on this' : j.answer === 'correct' ? 'Credit is right' : 'Not answered'}
                    </span>
                    {access === 'review' && (
                      <Link href={jobHref(j.taskNumber)} title="Open this job on the Contributions page"
                        className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
                        <ExternalLink className="w-3.5 h-3.5" />
                      </Link>
                    )}
                  </div>
                )}
              </div>

              {j.answer === 'worked' && (answering ? (
                <textarea
                  defaultValue={j.comment ?? ''}
                  maxLength={MAX_CHECK_COMMENT}
                  rows={2}
                  placeholder="What did you do on it? e.g. I made the layout and the price tags"
                  aria-label={`What you did on ${j.title}`}
                  onBlur={e => { if ((e.target.value.trim() || null) !== (j.comment ?? null)) void answer(j, 'worked', e.target.value) }}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                />
              ) : j.comment ? (
                <p className="text-sm whitespace-pre-wrap rounded-lg bg-rose-500/[0.06] border border-rose-500/20 px-3 py-2">“{j.comment}”</p>
              ) : null)}
            </div>
          )
        })}
        {shown.length === 0 && <p className="px-4 py-6 text-sm text-center text-muted-foreground">No jobs in this check.</p>}
      </div>

      {/* ── Send back ── */}
      {answering && (
        <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-end gap-2 rounded-xl border border-border bg-card/95 backdrop-blur px-3 py-2 shadow-lg">
          <p className="mr-auto text-xs text-muted-foreground tabular-nums">{s.answered} of {s.total} answered</p>
          {s.pending > 0 && (
            <button onClick={restCorrect} disabled={busy !== null}
              className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-50">
              {busy === 'rest' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Mark the other {s.pending} right
            </button>
          )}
          <button onClick={send} disabled={busy !== null || s.pending > 0}
            title={s.pending > 0 ? 'Answer every job first' : undefined}
            className="inline-flex items-center gap-1.5 rounded-lg gradient-bg text-white px-3 py-1.5 text-xs font-medium disabled:opacity-50">
            {busy === 'send' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} Send answers to {requester}
          </button>
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Withdraw this check?"
          body={`${employee} will no longer see it. Any answers already given are deleted.`}
          confirmLabel="Withdraw"
          danger
          onConfirm={() => { setConfirmDelete(false); void withdraw() }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </>
  )
}

'use client'

/**
 * Posting queue — the board.
 *
 * Four lanes in the order the work actually moves: Coming Up (the designer
 * still has it) → To Prepare (artwork done, caption missing) → Ready to Post
 * (caption written, waiting for its date) → Posted.
 *
 * Deliberately NOT drag-and-drop. Every transition here is earned rather than
 * asserted: a card leaves Coming Up when the designer finishes, leaves To
 * Prepare when a caption exists, and leaves Ready only when it is actually
 * posted. Dragging a card into Posted without posting it would be a lie the
 * board happily told, so posting is a button with a date, not a gesture.
 */

import { useMemo, useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import {
  X, Check, Copy, ExternalLink, AlertTriangle, Loader2, Clock,
  CalendarDays, ChevronDown, Sparkles, Undo2,
} from 'lucide-react'
import {
  POST_STAGES, POST_STAGE_LABEL, POST_STAGE_HINT, POST_STAGE_CHIP,
  URGENCY_CHIP, cycleProgress, type PostStage,
} from '@/lib/social-hub/post-queue'
import type { QueueEntry } from '@/lib/social-hub/post-queue-load'
import { savePostContent, markAsPosted, unmarkPosted } from './actions'

interface Props {
  initialRows: QueueEntry[]
  targets: Record<string, number>
  canPublishApi: boolean
  /**
   * 'compact' is the My Work embed: only the two lanes she can act on, no
   * client-progress cards, and a way through to the full page. Same editor,
   * same actions — one implementation, two placements.
   */
  variant?: 'full' | 'compact'
}

export default function PostQueueClient({
  initialRows, targets, canPublishApi, variant = 'full',
}: Props) {
  const compact = variant === 'compact'
  const [rows, setRows] = useState(initialRows)
  const [client, setClient] = useState<string>('all')
  const [open, setOpen] = useState<QueueEntry | null>(null)

  const clients = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of rows) if (r.clientName) m.set(r.clientId, r.clientName)
    return [...m.entries()]
  }, [rows])

  const visible = useMemo(
    () => (client === 'all' ? rows : rows.filter(r => r.clientId === client)),
    [rows, client],
  )

  const attention = visible.filter(r => r.attention)
  const byStage = (s: PostStage) => visible.filter(r => r.stage === s)

  /** Replace one row in place after an action, keeping scroll and filters. */
  const patch = (itemId: string, next: Partial<QueueEntry>) =>
    setRows(rs => rs.map(r => (r.itemId === itemId ? { ...r, ...next } : r)))

  const postedThisCycle = (cid: string) =>
    rows.filter(r => r.clientId === cid && r.stage === 'posted').length

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {compact ? (
            <h2 className="text-base font-semibold">To Post</h2>
          ) : (
            <h1 className="text-xl font-semibold">Posting Queue</h1>
          )}
          <p className="text-sm text-muted-foreground mt-0.5">
            {compact
              ? 'Artwork that is finished and still needs to go out.'
              : 'Finished artwork waiting to go out. Only clients whose social we run.'}
          </p>
        </div>
        {!compact && clients.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <FilterPill active={client === 'all'} onClick={() => setClient('all')}>
              All clients
            </FilterPill>
            {clients.map(([id, name]) => (
              <FilterPill key={id} active={client === id} onClick={() => setClient(id)}>
                {name}
              </FilterPill>
            ))}
          </div>
        )}
      </div>

      {/* ── The alert the request was really about ─────────────────────── */}
      {attention.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 sm:p-4">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-amber-500">
                {attention.length === 1
                  ? '1 post needs you now'
                  : `${attention.length} posts need you now`}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {attention.slice(0, 6).map(r => (
                  <button
                    key={r.itemId}
                    onClick={() => setOpen(r)}
                    className="text-xs px-2 py-1 rounded-lg bg-card border border-border hover:border-amber-500/50 transition-colors text-left"
                  >
                    <span className="font-medium">{truncate(r.title, 28)}</span>
                    <span className="text-muted-foreground"> · {r.urgency.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Per-client progress ────────────────────────────────────────── */}
      {!compact && clients.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {clients
            .filter(([id]) => client === 'all' || client === id)
            .map(([id, name]) => {
              const p = cycleProgress(postedThisCycle(id), targets[id] ?? null)
              const pct = p.target ? Math.min(100, (p.posted / p.target) * 100) : 0
              return (
                <div key={id} className="rounded-xl border border-border bg-card p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium truncate">{name}</span>
                    <span className="text-xs text-muted-foreground shrink-0">{p.label}</span>
                  </div>
                  {p.target ? (
                    <div className="mt-2 h-1.5 rounded-full bg-secondary overflow-hidden">
                      <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                  ) : (
                    <p className="mt-1.5 text-[11px] text-muted-foreground">
                      No package — billed per task, no monthly target
                    </p>
                  )}
                </div>
              )
            })}
        </div>
      )}

      {/* ── Board ──────────────────────────────────────────────────────── */}
      <div className={`grid gap-3 grid-cols-1 md:grid-cols-2 ${compact ? '' : 'xl:grid-cols-4'}`}>
        {(compact ? (['to_prepare', 'ready'] as PostStage[]) : POST_STAGES).map(stage => {
          const cards = byStage(stage)
          return (
            <div key={stage} className="rounded-xl border border-border bg-secondary/30 p-3 min-h-[180px]">
              <div className="flex items-center justify-between mb-0.5">
                <h2 className="text-sm font-semibold">{POST_STAGE_LABEL[stage]}</h2>
                <span className={`text-[11px] px-1.5 py-0.5 rounded-md border ${POST_STAGE_CHIP[stage]}`}>
                  {cards.length}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground mb-3">{POST_STAGE_HINT[stage]}</p>

              <div className="space-y-2">
                {cards.length === 0 && (
                  <p className="text-xs text-muted-foreground/60 text-center py-6">Nothing here</p>
                )}
                {cards.map(r => (
                  <QueueCard key={r.itemId} row={r} onOpen={() => setOpen(r)} />
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {compact && (
        <a
          href="/dashboard/social/queue"
          className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
        >
          Open the full posting queue
          <ExternalLink className="w-3 h-3" />
        </a>
      )}

      {open && (
        <PostEditor
          row={open}
          canPublishApi={canPublishApi}
          onClose={() => setOpen(null)}
          onSaved={next => { patch(open.itemId, next); setOpen(null) }}
        />
      )}
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────── */

function FilterPill({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
        active
          ? 'bg-primary/10 border-primary/30 text-primary font-medium'
          : 'bg-card border-border text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}

function QueueCard({ row, onOpen }: { row: QueueEntry; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="w-full text-left rounded-xl border border-border bg-card p-3 hover:border-primary/40 transition-colors"
    >
      <p className="text-sm font-medium leading-snug">{truncate(row.title, 64)}</p>

      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {row.clientName && (
          <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-secondary text-muted-foreground">
            {row.clientName}
          </span>
        )}
        {row.urgency.level !== 'none' && row.stage !== 'posted' && (
          <span className={`text-[11px] px-1.5 py-0.5 rounded-md border ${URGENCY_CHIP[row.urgency.level]}`}>
            {row.urgency.label}
          </span>
        )}
        {row.stage === 'posted' && row.postedManually && (
          <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-green-500/15 text-green-500 border border-green-500/25">
            Posted by hand
          </span>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground flex items-center gap-1">
          <CalendarDays className="w-3 h-3" />
          {formatDay(row.plannedDate)}
        </span>
        <ChecklistDots checklist={row.checklist} />
      </div>
    </button>
  )
}

/** Five dots — the checklist at a glance, without opening anything. */
function ChecklistDots({ checklist }: { checklist: QueueEntry['checklist'] }) {
  return (
    <span className="flex items-center gap-1" title={checklist.map(c => `${c.done ? '✓' : '○'} ${c.label}`).join('\n')}>
      {checklist.map(c => (
        <span
          key={c.key}
          className={`w-1.5 h-1.5 rounded-full ${
            c.done ? 'bg-green-500' : c.optional ? 'bg-border' : 'bg-amber-500/50'
          }`}
        />
      ))}
    </span>
  )
}

/* ────────────────────────────────────────────────────────────────────── */

function PostEditor({ row, canPublishApi, onClose, onSaved }: {
  row: QueueEntry
  canPublishApi: boolean
  onClose: () => void
  onSaved: (next: Partial<QueueEntry>) => void
}) {
  // Seeded from the plan so nothing is retyped — the planner's caption is the
  // starting point, not a separate thing to copy across by hand.
  const [caption, setCaption] = useState(row.caption ?? row.plannedCaption ?? '')
  const [hashtags, setHashtags] = useState(row.hashtags ?? '')
  const [altText, setAltText] = useState(row.altText ?? '')
  const [firstComment, setFirstComment] = useState(row.firstComment ?? '')
  const [advanced, setAdvanced] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [pending, start] = useTransition()

  const fullText = [caption.trim(), hashtags.trim()].filter(Boolean).join('\n\n')

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(fullText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch { setErr('Could not copy — select the text and copy manually.') }
  }

  const save = (then?: 'posted') => start(async () => {
    setErr(null)
    const res = await savePostContent(row.itemId, {
      caption: caption.trim() || null,
      hashtags: hashtags.trim() || null,
      alt_text: altText.trim() || null,
      first_comment: firstComment.trim() || null,
    })
    if (!res.ok) { setErr(res.error ?? 'Could not save.'); return }

    if (then === 'posted') {
      const p = await markAsPosted(row.itemId)
      if (!p.ok) { setErr(p.error ?? 'Could not mark as posted.'); return }
      onSaved({
        caption: caption.trim() || null, hashtags: hashtags.trim() || null,
        altText: altText.trim() || null, firstComment: firstComment.trim() || null,
        publishedAt: new Date().toISOString(), postedManually: true, stage: 'posted',
        attention: false,
      })
      return
    }

    onSaved({
      caption: caption.trim() || null, hashtags: hashtags.trim() || null,
      altText: altText.trim() || null, firstComment: firstComment.trim() || null,
      stage: caption.trim() ? 'ready' : row.stage,
    })
  })

  const undo = () => start(async () => {
    setErr(null)
    const res = await unmarkPosted(row.itemId)
    if (!res.ok) { setErr(res.error ?? 'Could not undo.'); return }
    onSaved({ publishedAt: null, postedManually: false, stage: caption.trim() ? 'ready' : 'to_prepare' })
  })

  const isPosted = row.stage === 'posted'

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      {/* No height of its own. ModalOverlay's dialog is already
          `flex flex-col max-h-[90dvh]`, so this is a flex CHILD of a capped
          box: it only has to be allowed to shrink. min-h-0 is what allows
          that — a flex item defaults to min-height:auto and otherwise refuses
          to go below its content, pushing the action bar off the bottom of the
          screen. Setting our own max-h in viewport units (the obvious fix)
          makes it worse: 92dvh is TALLER than the parent's 90dvh cap, so the
          overflow lands exactly on the buttons. */}
      <div className="bg-card w-full sm:max-w-xl sm:rounded-2xl rounded-t-2xl flex flex-col min-h-0">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 p-4 border-b border-border shrink-0">
          <div className="min-w-0">
            <h2 className="text-base font-semibold leading-snug">{row.title}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {row.clientName} · planned {formatDay(row.plannedDate)}
              {row.refNo && ` · REQ-${String(row.refNo).padStart(4, '0')}`}
            </p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable body — the action bar below stays put.
            min-h-0 is load-bearing: a flex child defaults to min-height:auto,
            so this refuses to shrink below its content and pushes the footer
            clean off the bottom of the sheet. That is the whole reason modal
            buttons go missing on a phone. */}
        <div className="p-4 space-y-4 overflow-y-auto flex-1 min-h-0">
          {row.urgency.level !== 'none' && !isPosted && (
            <div className={`text-xs px-2.5 py-2 rounded-lg border flex items-center gap-2 ${URGENCY_CHIP[row.urgency.level]}`}>
              <Clock className="w-3.5 h-3.5 shrink-0" />
              {row.urgency.level === 'overdue'
                ? `This was planned for ${formatDay(row.plannedDate)} — ${row.urgency.label}.`
                : `${row.urgency.label} — planned for ${formatDay(row.plannedDate)}.`}
            </div>
          )}

          <Checklist row={row} caption={caption} hashtags={hashtags} altText={altText} />

          {row.driveFolderLink && (
            <a
              href={row.driveFolderLink}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-xs text-primary hover:underline"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Open {row.clientName}&apos;s artwork folder
            </a>
          )}

          <Field label="Caption" hint={row.plannedCaption && !row.caption ? 'Pre-filled from the plan' : undefined}>
            <textarea
              value={caption}
              onChange={e => setCaption(e.target.value)}
              rows={5}
              placeholder="What goes with this post…"
              className="w-full text-sm bg-secondary/50 border border-border rounded-lg p-2.5 resize-y focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </Field>

          <Field label="Hashtags">
            <textarea
              value={hashtags}
              onChange={e => setHashtags(e.target.value)}
              rows={2}
              placeholder="#brand #dubai"
              className="w-full text-sm bg-secondary/50 border border-border rounded-lg p-2.5 resize-y focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </Field>

          <Field label="Alt text" hint="Describes the image for screen readers">
            <input
              value={altText}
              onChange={e => setAltText(e.target.value)}
              placeholder="A gold perfume bottle on a marble surface"
              className="w-full text-sm bg-secondary/50 border border-border rounded-lg p-2.5 focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </Field>

          {/* Everything beyond the daily path is folded away. */}
          <button
            onClick={() => setAdvanced(a => !a)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${advanced ? 'rotate-180' : ''}`} />
            Advanced options
          </button>

          {advanced && (
            <div className="space-y-4 pl-1 border-l-2 border-border ml-1.5 pt-1">
              <Field label="First comment" hint="Posted right after publishing — often where hashtags go">
                <textarea
                  value={firstComment}
                  onChange={e => setFirstComment(e.target.value)}
                  rows={2}
                  className="w-full text-sm bg-secondary/50 border border-border rounded-lg p-2.5 resize-y focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </Field>

              <div className="rounded-lg bg-secondary/50 border border-border p-3">
                <p className="text-xs font-medium flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-primary" />
                  Publish through Cirqle
                </p>
                <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                  {canPublishApi
                    ? 'Scheduling and direct publishing to Instagram/Facebook run from the calendar composer, which handles media upload and Meta’s format rules. Attach the artwork there first.'
                    : 'You can prepare content here. Scheduling and publishing directly to Meta needs the “social.approve” permission.'}
                </p>
                <a
                  href="/dashboard/social/calendar"
                  className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-primary hover:underline"
                >
                  <ExternalLink className="w-3 h-3" />
                  Open the composer
                </a>
              </div>
            </div>
          )}

          {err && (
            <p className="text-xs text-red-500 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />{err}
            </p>
          )}
        </div>

        {/* Action bar — sticky and inside the flex column so it is never
            pushed off a short mobile viewport. */}
        <div className="p-3 border-t border-border bg-card shrink-0 flex gap-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <Button
            type="button"
            variant="outline"
            onClick={copyAll}
            disabled={!fullText}
            className="flex-1 basis-0 min-w-0 px-2"
          >
            {copied ? <Check className="w-4 h-4 mr-1.5 shrink-0" /> : <Copy className="w-4 h-4 mr-1.5 shrink-0" />}
            <span className="truncate">{copied ? 'Copied' : 'Copy text'}</span>
          </Button>

          {isPosted ? (
            <Button type="button" variant="outline" onClick={undo} disabled={pending} className="flex-1 basis-0 min-w-0 px-2">
              {pending ? <Loader2 className="w-4 h-4 mr-1.5 shrink-0 animate-spin" /> : <Undo2 className="w-4 h-4 mr-1.5 shrink-0" />}
              <span className="truncate">Not posted</span>
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => save()} disabled={pending} className="flex-1 basis-0 min-w-0 px-2">
                {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}
              </Button>
              <Button type="button" onClick={() => save('posted')} disabled={pending} className="flex-1 basis-0 min-w-0 px-2">
                <Check className="w-4 h-4 mr-1.5 shrink-0" />
                <span className="truncate">Mark posted</span>
              </Button>
            </>
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}

/** Live checklist — reflects what is typed, before it is even saved. */
function Checklist({ row, caption, hashtags, altText }: {
  row: QueueEntry; caption: string; hashtags: string; altText: string
}) {
  const live = [
    { label: 'Artwork ready', done: row.checklist.find(c => c.key === 'creative')?.done ?? false },
    { label: 'Caption written', done: caption.trim().length > 0 },
    { label: 'Hashtags added', done: hashtags.trim().length > 0 },
    { label: 'Alt text added', done: altText.trim().length > 0 },
    { label: 'Posted', done: row.stage === 'posted' },
  ]
  const done = live.filter(l => l.done).length
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium">Checklist</span>
        <span className="text-[11px] text-muted-foreground">{done} of {live.length}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {live.map(l => (
          <span key={l.label} className="flex items-center gap-1.5 text-[11px]">
            <span className={`w-3.5 h-3.5 rounded-full grid place-items-center shrink-0 ${
              l.done ? 'bg-green-500 text-white' : 'border border-border'
            }`}>
              {l.done && <Check className="w-2.5 h-2.5" strokeWidth={3} />}
            </span>
            <span className={l.done ? 'text-foreground' : 'text-muted-foreground'}>{l.label}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

function Field({ label, hint, children }: {
  label: string; hint?: string; children: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <label className="text-xs font-medium">{label}</label>
        {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────── */

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** "15 Aug" — short, unambiguous, and never a US/UK ordering trap. */
function formatDay(iso: string): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${d} ${MONTHS[m - 1]}${y !== new Date().getFullYear() ? ` ${y}` : ''}`
}

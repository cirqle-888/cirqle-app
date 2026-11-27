'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  DndContext, MouseSensor, TouchSensor, useSensor, useSensors, useDraggable, useDroppable, closestCorners, type DragEndEvent,
} from '@dnd-kit/core'
import {
  LayoutGrid, CalendarDays, List, Loader2, Check, ChevronRight, CircleAlert, X as XIcon, Users,
} from 'lucide-react'
import dynamicImport from 'next/dynamic'
import Header from '@/components/layout/header'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { OverflowMenu } from '@/components/ui/overflow-menu'
import { useToast, ToastContainer } from '@/components/ui/toast'
import {
  WORK_STAGES, STAGE_LABEL, STAGE_HINT, STAGE_CHIP, stageOf, stageOfPlan, canMove,
  isPending, moveRefusalReason, type WorkStage,
} from '@/lib/requests/my-work'
import { moveMyWork, moveTeamWork, type MyWorkRow, type TeamMemberLoad } from './actions'
import { CHECKLIST_LABEL, CHECKLIST_HINT } from '@/lib/requests/kind'
import { todayISO } from '@/lib/utils/local-date'
import { SharePendingButton } from '@/components/my-work/share-pending'

const DiscussButton = dynamicImport(
  () => import('@/components/chat/discuss-button').then(m => m.DiscussButton),
  { ssr: false },
)

/**
 * One stage for a row from either queue. A request carries its own status; a
 * plan item has none and is read through whatever task it has grown (or has
 * not grown yet). Everything downstream — columns, counts, the next-step
 * button — goes through this, so the two sources stay indistinguishable on the
 * board, which is the point of merging them.
 */
function rowStage(r: MyWorkRow): WorkStage {
  return r.source === 'plan' ? stageOfPlan(r.status || null) : stageOf(r.status)
}

interface Props {
  initialRows: MyWorkRow[]
  /** Managers only: who has work on their board (busiest-late first). Empty = no team switch. */
  team?: TeamMemberLoad[]
  /** Whose board this is when a manager opened someone else's; null = my own. */
  viewing?: { employeeId: string; cqid: string } | null
  myEmployeeId?: string
  /** The signed-in person's CQID — what a shared summary is labelled with. */
  myCqid?: string
}


/** The one-click next step for a stage, in the words you would say out loud. */
const NEXT_VERB: Partial<Record<WorkStage, string>> = {
  working: 'Start',
  delivered: 'Send for review',
  done: 'Mark done',
}

/** The stage a card moves to next, or null when it has nowhere left to go. */
function nextStage(stage: WorkStage): WorkStage | null {
  const next = WORK_STAGES[WORK_STAGES.indexOf(stage) + 1]
  return next && canMove(stage, next) ? next : null
}

function dueLabel(due: string | null, stage?: WorkStage): { text: string; tone: string } | null {
  if (!due) return null
  const today = todayISO()
  // "Overdue" is a call to act. Work that is finished, or already with the
  // client, has nothing left for its owner to do — there the date is a date.
  const settled = stage === 'done' || stage === 'delivered'
  if (!settled && due < today) return { text: 'Overdue', tone: 'bg-red-500/15 text-red-400 border-red-500/25' }
  if (!settled && due === today) return { text: 'Due today', tone: 'bg-amber-500/15 text-amber-500 border-amber-500/25' }
  const d = new Date(`${due}T00:00:00`)
  return {
    text: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
    tone: 'bg-secondary text-muted-foreground border-border',
  }
}

function Card({ row, dragging, onNext, busy }: {
  row: MyWorkRow; dragging?: boolean
  /** Moves the card one stage on. Absent = read-only card. */
  onNext?: (to: WorkStage) => void
  busy?: boolean
}) {
  const stage = rowStage(row)
  // A finished card carries no date at all — it is history, not a deadline.
  const due = stage === 'done' ? null : dueLabel(row.due_date, stage)
  const next = nextStage(stage)
  return (
    <div className={`rounded-xl border border-border bg-card p-3 space-y-2 ${dragging ? 'shadow-xl' : 'shadow-sm'}`}>
      <p className="text-sm font-semibold leading-snug break-words">{row.title}</p>
      {/* The card says only what you need to pick it up: whose it is and when
          it is wanted. The service, the reference number and where it came
          from are one tap away in the brief — on the card they were five
          things to read before the one that mattered. */}
      <div className="flex items-center gap-1.5 text-[11px]">
        {row.client_name && <span className="min-w-0 truncate text-muted-foreground">{row.client_name}</span>}
        {row.checklist && (
          <span title={CHECKLIST_HINT}
            className="shrink-0 px-1.5 py-0.5 rounded font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-300">
            {CHECKLIST_LABEL}
          </span>
        )}
        {due && <span className={`shrink-0 px-1.5 py-0.5 rounded-full border ${due.tone}`}>{due.text}</span>}
        {/* One click instead of a drag. The drag still works; this is for
            everyone who never found it, and for every phone. */}
        {onNext && next && (
          <button
            type="button" disabled={busy}
            onMouseDown={e => e.stopPropagation()} onTouchStart={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); onNext(next) }}
            title={`Move to ${STAGE_LABEL[next]}`}
            className="ml-auto shrink-0 inline-flex items-center gap-0.5 rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
          >
            {NEXT_VERB[next]} <ChevronRight className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * What a designer actually needs from a card: the brief, and the references.
 *
 * Deliberately read-only and deliberately small. Everything a manager would
 * want here — reassigning, re-pricing, changing dates, editing the brief — is
 * absent, because a designer opening their own work should be reading it, not
 * navigating around edit controls that would refuse them anyway. The one thing
 * they CAN do is say something, via Discuss.
 */
function CardDetail({ row, onClose }: { row: MyWorkRow; onClose: () => void }) {
  const due = dueLabel(row.due_date, rowStage(row))
  // Any http(s) URL in the brief is a reference worth showing as a link rather
  // than as raw text buried in a paragraph.
  const links = useMemo(() => {
    const out = (row.description || '').match(/https?:\/\/[^\s<>"')]+/g) ?? []
    return [...new Set(out)]
  }, [row.description])
  const images = useMemo(
    () => links.filter(u => /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(u)),
    [links],
  )

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col min-h-0">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border shrink-0">
          <div className="min-w-0">
            <h2 className="font-semibold leading-snug break-words">{row.title}</h2>
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] mt-1.5">
              <span className={`px-1.5 py-0.5 rounded-full border ${STAGE_CHIP[rowStage(row)]}`}>
                {STAGE_LABEL[rowStage(row)]}
              </span>
              {row.client_name && <span className="text-muted-foreground">{row.client_name}</span>}
              {row.service_name && <span className="text-muted-foreground/70">{row.service_name}</span>}
              {due && <span className={`px-1.5 py-0.5 rounded-full border ${due.tone}`}>{due.text}</span>}
              <span className="font-medium text-muted-foreground/70 tabular-nums">
                {row.source === 'plan' ? 'Plan' : row.ref_no ? `REQ-${String(row.ref_no).padStart(4, '0')}` : 'Request'}
              </span>
            </div>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground shrink-0">
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1 min-h-0">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5">What to make</p>
            {row.description?.trim()
              ? <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">{row.description}</p>
              : <p className="text-sm text-muted-foreground">No brief was written for this one.</p>}
          </div>

          {images.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5">References</p>
              <div className="grid grid-cols-2 gap-2">
                {images.map(u => (
                   
                  <a key={u} href={u} target="_blank" rel="noopener noreferrer" className="block rounded-lg overflow-hidden border border-border">
                    <img src={u} alt="Reference" className="w-full h-28 object-cover" loading="lazy" />
                  </a>
                ))}
              </div>
            </div>
          )}

          {links.length > images.length && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5">Links</p>
              <div className="space-y-1">
                {links.filter(u => !images.includes(u)).map(u => (
                  <a key={u} href={u} target="_blank" rel="noopener noreferrer"
                     className="block text-xs text-primary hover:underline truncate">{u}</a>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 py-4 border-t border-border shrink-0">
          {/* The only write a designer gets here — and it is a conversation,
              not an edit. Suggestions belong beside the work, not in a form. */}
          {row.source === 'request' && (
            <DiscussButton entityType="request" entityId={row.id} label="Ask / suggest" panelTitle={row.title} />
          )}
          {row.source === 'plan' && (
            <DiscussButton entityType="plan_item" entityId={row.id} label="Ask / suggest" panelTitle={row.title} />
          )}
          <span className="flex-1" />
          <button onClick={onClose} className="bg-secondary text-sm font-medium px-4 py-2 rounded-lg hover:bg-secondary/80">Close</button>
        </div>
      </div>
    </ModalOverlay>
  )
}

function DraggableCard({ row, disabled, onOpen, onMove }: {
  row: MyWorkRow; disabled?: boolean; onOpen: (r: MyWorkRow) => void
  onMove: (id: string, to: WorkStage) => void
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: row.id, disabled })
  return (
    <div
      ref={setNodeRef} {...attributes} {...listeners}
      // onClick, not onPointerUp: a drag only starts after a 6px mouse move or
      // a touch press-and-hold, so a real drag never fires a click and this
      // cannot open the brief every time a card is moved.
      onClick={() => { if (!isDragging) onOpen(row) }}
      style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 60, position: 'relative' } : undefined}
      className={`${isDragging ? 'opacity-90 cursor-grabbing' : disabled ? '' : 'cursor-grab'} touch-manipulation`}
    >
      <Card row={row} dragging={isDragging} busy={disabled} onNext={to => onMove(row.id, to)} />
    </div>
  )
}

function Column({ stage, rows, busyId, totalCount, footer, onOpen, onMove }: {
  stage: WorkStage
  rows: MyWorkRow[]
  busyId: string | null
  onOpen: (r: MyWorkRow) => void
  onMove: (id: string, to: WorkStage) => void
  /** Set when `rows` is a capped preview — the badge must show the real total. */
  totalCount?: number
  footer?: React.ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage })
  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col rounded-2xl border p-3 min-w-[240px] flex-1 transition-colors
        ${isOver ? 'border-primary bg-primary/5' : 'border-border bg-secondary/30'}`}
    >
      {/* What the column means is in its tooltip — four sentences across the
          top of the board were read once and then scrolled past forever. */}
      <div className="flex items-center justify-between mb-2.5" title={STAGE_HINT[stage]}>
        <span className="text-sm font-semibold">{STAGE_LABEL[stage]}</span>
        <span className={`text-[11px] px-1.5 py-0.5 rounded-full border ${STAGE_CHIP[stage]}`}>{totalCount ?? rows.length}</span>
      </div>
      <div className="space-y-2 flex-1">
        {rows.map(r => (
          <div key={r.id} className="relative">
            <DraggableCard row={r} disabled={busyId === r.id} onOpen={onOpen} onMove={onMove} />
            {busyId === r.id && (
              <div className="absolute inset-0 grid place-items-center rounded-xl bg-card/70">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
              </div>
            )}
          </div>
        ))}
        {rows.length === 0 && (
          <p className="text-[11px] text-muted-foreground/50 py-4 text-center">—</p>
        )}
      </div>
      {footer}
    </div>
  )
}

export default function MyWorkClient({ initialRows, team = [], viewing = null, myEmployeeId, myCqid }: Props) {
  const router = useRouter()
  const toast = useToast()
  const [rows, setRows] = useState(initialRows)
  const [view, setView] = useState<'board' | 'calendar' | 'list'>('board')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [openRow, setOpenRow] = useState<MyWorkRow | null>(null)

  // A touch sensor with a hold delay, not a raw pointer sensor: on a phone the
  // board scrolls, and without the delay every attempt to scroll a column
  // picks a card up instead.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
  )

  // ── The only two controls this page gets ───────────────────────────────────
  // Deliberately not a filter/sort system. The server already returns
  // soonest-due-first, which is the one order that matters to whoever has to
  // do the work, and a designer holding ten or twenty cards does not need
  // facets to find one. These two exist because each solves a real problem:
  //   client  — batching. Five posters for one client are done in one sitting.
  //   done    — the Done column otherwise grows forever (requests stay
  //             assigned after completion), and a board with two hundred
  //             finished cards in the last column is unusable within a year.
  const [clientFilter, setClientFilter] = useState<string | null>(null)
  const [showAllDone, setShowAllDone] = useState(false)

  const clients = useMemo(() => {
    const names = new Set<string>()
    for (const r of rows) if (r.client_name) names.add(r.client_name)
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [rows])

  const visibleRows = useMemo(
    () => clientFilter ? rows.filter(r => r.client_name === clientFilter) : rows,
    [rows, clientFilter],
  )

  const byStage = useMemo(() => {
    const out: Record<WorkStage, MyWorkRow[]> = { todo: [], working: [], delivered: [], done: [] }
    for (const r of visibleRows) out[rowStage(r)].push(r)
    // Newest-finished first, so the cards a designer might still want to look
    // at sit at the top rather than being buried under months of history.
    out.done.sort((a, b) => (b.due_date ?? b.created_at).localeCompare(a.due_date ?? a.created_at))
    return out
  }, [visibleRows])

  const DONE_PREVIEW = 8
  const doneShown = showAllDone ? byStage.done : byStage.done.slice(0, DONE_PREVIEW)
  const doneHidden = byStage.done.length - doneShown.length

  // Counts always reflect the FULL queue, never the client filter — "how much
  // is on me" must not change because you narrowed the board to one client.
  const pendingCount = useMemo(
    () => rows.filter(r => isPending(rowStage(r))).length,
    [rows],
  )
  const overdueCount = useMemo(
    () => rows.filter(r => isPending(rowStage(r)) && r.due_date && r.due_date < todayISO()).length,
    [rows],
  )

  async function apply(id: string, to: WorkStage) {
    const row = rows.find(r => r.id === id)
    if (!row) return
    const from = rowStage(row)
    if (from === to) return
    if (!canMove(from, to)) { toast.toastError('Cannot move that way', moveRefusalReason(from, to)); return }

    setBusyId(id)
    // A manager on a team member's board moves the card FOR them.
    const res = viewing
      ? await moveTeamWork(viewing.employeeId, id, to, row.source)
      : await moveMyWork(id, to, row.source)
    setBusyId(null)
    if (!res.ok || !res.data) { toast.toastError('Could not update', res.error); return }
    // Trust the status the server actually wrote rather than assuming the
    // stage's default — they agree today, and if they ever stop, the board
    // should show the truth.
    setRows(prev => prev.map(r => r.id === id ? { ...r, status: res.data!.status } : r))
    // Say when a task appeared. Starting work silently creating a billable
    // record is exactly the kind of thing people should be told about, not
    // discover later on the Tasks page.
    if (res.data.warning) toast.toastError('Moved, but needs attention', res.data.warning)
    else if (res.data.taskCreated) toast.success(`Moved to ${STAGE_LABEL[to]}`, 'A task was created for this work.')
    else toast.success(`Moved to ${STAGE_LABEL[to]}`)
    router.refresh()
  }

  function onDragEnd(e: DragEndEvent) {
    const to = e.over?.id as WorkStage | undefined
    if (!to || !WORK_STAGES.includes(to)) return
    void apply(String(e.active.id), to)
  }

  const VIEWS = [
    { key: 'board' as const, label: 'Board', Icon: LayoutGrid },
    { key: 'calendar' as const, label: 'Calendar', Icon: CalendarDays },
    { key: 'list' as const, label: 'List', Icon: List },
  ]

  return (
    <div className="space-y-5 pb-10">
      <Header
        title={viewing ? `${viewing.cqid} — Work` : 'My Work'}
        subtitle={viewing ? `Moving a card here updates it for ${viewing.cqid}` : undefined}
      />

      {/* One row: how to look at it, how much is on the plate, and is any of it
          late. The four counts used to be four large tiles — a quarter of the
          screen spent on four numbers, before a single card. */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Whose board — for whoever runs the work. It used to be a row of its
            own above everything, on a page called My Work; it is one control
            now, sitting with the others. Pick a person to see their board and
            move their cards when they have not. The button says how many
            cards across the team are late, so that is visible without opening it. */}
        {team.length > 0 && (() => {
          const others = team.filter(t => t.employeeId !== myEmployeeId)
          const teamLate = others.reduce((n, t) => n + t.overdue, 0)
          const ordered = [...team.filter(t => t.employeeId === myEmployeeId), ...others]
          return (
            <div className="flex items-center gap-1.5">
              <OverflowMenu
                icon={Users}
                text={viewing ? viewing.cqid : 'Me'}
                label="Whose work to show"
                align="left"
                items={ordered.map(t => {
                  const mine = t.employeeId === myEmployeeId
                  return {
                    label: mine ? 'Me' : t.cqid,
                    badge: t.overdue > 0 ? `${t.open} · ${t.overdue} late` : (t.open || undefined),
                    onClick: () => router.push(mine ? '/dashboard/my-work' : `/dashboard/my-work?for=${t.employeeId}`),
                  }
                })}
              />
              {teamLate > 0 && (
                <span title={`${teamLate} late across the team`}
                  className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-red-600 dark:text-red-400">
                  <Users className="w-3 h-3" /> <b className="font-semibold tabular-nums">{teamLate}</b> late
                </span>
              )}
            </div>
          )
        })()}
        <div className="flex items-center gap-1 rounded-lg border border-border bg-secondary p-0.5 w-fit">
          {VIEWS.map(({ key, label, Icon }) => (
            <button
              key={key} onClick={() => setView(key)} title={label} aria-pressed={view === key}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm transition-colors
                ${view === key ? 'bg-card font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <Icon className="w-4 h-4" /> <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5 text-xs">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1">
            <b className="font-semibold tabular-nums">{pendingCount}</b> to do
          </span>
          {overdueCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-red-600 dark:text-red-400">
              <CircleAlert className="w-3 h-3" /> <b className="font-semibold tabular-nums">{overdueCount}</b> overdue
            </span>
          )}
          {byStage.delivered.length > 0 && (
            <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-muted-foreground">
              <b className="font-semibold tabular-nums text-foreground">{byStage.delivered.length}</b> with client
            </span>
          )}
          <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-muted-foreground">
            <b className="font-semibold tabular-nums text-foreground">{byStage.done.length}</b> done
          </span>
        </div>

        {/* Send this board's pending work to WhatsApp — as an image card or a
            list, to a group or to the person themself. */}
        <div className="ml-auto">
          <SharePendingButton
            rows={rows}
            owner={viewing ? viewing.cqid : (myCqid || 'My work')}
            employeeId={viewing ? viewing.employeeId : myEmployeeId}
            recipientLabel={viewing ? viewing.cqid : null}
          />
        </div>
      </div>

      {/* Client chips — only when there is actually a choice to make. One
          client means one chip that does nothing, which is worse than none.
          One line that scrolls, so ten clients cost no more room than two. */}
      {clients.length > 1 && (
        <div className="-mt-2 flex items-center gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:thin]">
          {[null, ...clients].map(c => (
            <button
              key={c ?? 'all'} onClick={() => setClientFilter(c === clientFilter ? null : c)}
              className={`shrink-0 px-2.5 py-1 rounded-lg text-xs border transition-colors
                ${clientFilter === c ? 'bg-primary/15 text-primary border-primary/30' : 'bg-secondary text-muted-foreground border-border hover:text-foreground'}`}
            >
              {c ?? 'All'}
            </button>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card px-5 py-12 text-center">
          <Check className="w-8 h-8 text-green-500 mx-auto mb-3" />
          <p className="font-medium">{viewing ? `Nothing assigned to ${viewing.cqid}` : 'Nothing assigned to you yet'}</p>
        </div>
      ) : view === 'board' ? (
        <>
          <DndContext id="my-work-dnd" sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
            <div className="flex gap-3 overflow-x-auto pb-2 items-stretch">
              {WORK_STAGES.map(s => (
                <Column
                  key={s} stage={s}
                  onOpen={setOpenRow}
                  onMove={(id, to) => void apply(id, to)}
                  rows={s === 'done' ? doneShown : byStage[s]}
                  totalCount={s === 'done' ? byStage.done.length : undefined}
                  busyId={busyId}
                  footer={s === 'done' && (doneHidden > 0 || showAllDone) ? (
                    <button
                      onClick={() => setShowAllDone(v => !v)}
                      className="w-full text-[11px] text-muted-foreground hover:text-foreground py-1.5"
                    >
                      {showAllDone ? 'Show less' : `Show all ${byStage.done.length}`}
                    </button>
                  ) : null}
                />
              ))}
            </div>
          </DndContext>
        </>
      ) : view === 'calendar' ? (
        <CalendarView rows={visibleRows} />
      ) : (
        <ListView rows={visibleRows} onMove={apply} busyId={busyId} onOpen={setOpenRow} />
      )}

      {openRow && <CardDetail row={openRow} onClose={() => setOpenRow(null)} />}

      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
    </div>
  )
}

/** Month grid of due dates — "when is this wanted", not "what stage is it". */
function CalendarView({ rows }: { rows: MyWorkRow[] }) {
  const [month, setMonth] = useState(() => todayISO().slice(0, 7))
  const [y, m] = month.split('-').map(Number)
  const first = new Date(y, m - 1, 1)
  const start = new Date(first)
  start.setDate(1 - first.getDay())

  const byDate = useMemo(() => {
    const out: Record<string, MyWorkRow[]> = {}
    for (const r of rows) {
      if (!r.due_date) continue
      ;(out[r.due_date] ||= []).push(r)
    }
    return out
  }, [rows])

  const undated = rows.filter(r => !r.due_date)
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start); d.setDate(start.getDate() + i)
    return { iso: d.toLocaleDateString('en-CA'), day: d.getDate(), inMonth: d.getMonth() === m - 1 }
  })

  const shift = (by: number) => {
    const d = new Date(y, m - 1 + by, 1)
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button onClick={() => shift(-1)} className="px-2.5 py-1.5 rounded-lg border border-border text-sm hover:bg-secondary">‹</button>
        <span className="text-sm font-medium">
          {first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}
        </span>
        <button onClick={() => shift(1)} className="px-2.5 py-1.5 rounded-lg border border-border text-sm hover:bg-secondary">›</button>
      </div>
      <div className="grid grid-cols-7 gap-px bg-border rounded-xl overflow-hidden border border-border">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
          <div key={i} className="bg-secondary px-2 py-1.5 text-[10px] font-semibold text-muted-foreground text-center">{d}</div>
        ))}
        {cells.map(c => (
          <div key={c.iso} className={`bg-card min-h-[76px] p-1.5 ${c.inMonth ? '' : 'opacity-40'}`}>
            <span className="text-[10px] text-muted-foreground">{c.day}</span>
            <div className="space-y-1 mt-1">
              {(byDate[c.iso] || []).map(r => (
                <div key={r.id} className={`text-[10px] px-1.5 py-1 rounded border truncate ${STAGE_CHIP[rowStage(r)]}`} title={r.title}>
                  {r.title}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {undated.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-3">
          <p className="text-xs font-medium mb-2">No date set ({undated.length})</p>
          <div className="flex flex-wrap gap-1.5">
            {undated.map(r => (
              <span key={r.id} className={`text-[11px] px-2 py-1 rounded border ${STAGE_CHIP[rowStage(r)]}`}>{r.title}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** Flat list with an explicit next-step button — the no-dragging path. */
function ListView({ rows, onMove, busyId, onOpen }: {
  rows: MyWorkRow[]
  onMove: (id: string, to: WorkStage) => void
  busyId: string | null
  onOpen: (r: MyWorkRow) => void
}) {
  // Stage first, due date second. The incoming order is purely by date, which
  // interleaves finished work through the list — so the thing you have to do
  // next could sit below twenty completed cards. Actionable work leads; Done
  // sinks to the bottom on its own, no filter needed.
  const ordered = useMemo(() => [...rows].sort((a, b) => {
    const d = WORK_STAGES.indexOf(stageOf(a.status)) - WORK_STAGES.indexOf(stageOf(b.status))
    if (d !== 0) return d
    return (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999')
  }), [rows])

  return (
    <div className="space-y-2">
      {ordered.map(r => {
        const stage = rowStage(r)
        const next = WORK_STAGES[WORK_STAGES.indexOf(stage) + 1]
        const due = dueLabel(r.due_date, stage)
        return (
          <div key={r.id} className="rounded-xl border border-border bg-card p-3 flex items-center gap-3 flex-wrap">
            <div className="min-w-0 flex-1 cursor-pointer" onClick={() => onOpen(r)}>
              <p className="text-sm font-medium break-words">{r.title}</p>
              <div className="flex flex-wrap items-center gap-1.5 text-[11px] mt-1">
                <span className={`px-1.5 py-0.5 rounded-full border ${STAGE_CHIP[stage]}`}>{STAGE_LABEL[stage]}</span>
                {r.client_name && <span className="text-muted-foreground">{r.client_name}</span>}
                {due && <span className={`px-1.5 py-0.5 rounded-full border ${due.tone}`}>{due.text}</span>}
              </div>
            </div>
            {next && canMove(stage, next) && (
              <button
                onClick={() => onMove(r.id, next)}
                disabled={busyId === r.id}
                className="inline-flex items-center gap-1.5 rounded-lg gradient-bg text-white px-3 py-2 text-xs font-medium disabled:opacity-50 shrink-0"
              >
                {busyId === r.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ChevronRight className="w-3.5 h-3.5" />}
                {NEXT_VERB[next] ?? STAGE_LABEL[next]}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

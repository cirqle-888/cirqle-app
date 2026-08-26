'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  DndContext, PointerSensor, TouchSensor, useSensor, useSensors,
  useDraggable, useDroppable, closestCorners, type DragEndEvent,
} from '@dnd-kit/core'
import {
  LayoutGrid, CalendarDays, List, Loader2, Check, ChevronRight, CircleAlert,
} from 'lucide-react'
import Header from '@/components/layout/header'
import { useToast, ToastContainer } from '@/components/ui/toast'
import {
  WORK_STAGES, STAGE_LABEL, STAGE_HINT, STAGE_CHIP, stageOf, stageOfPlan, canMove,
  isPending, moveRefusalReason, type WorkStage,
} from '@/lib/requests/my-work'
import { moveMyWork, type MyWorkRow } from './actions'

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
  firstName: string
}

const todayISO = () => new Date().toLocaleDateString('en-CA')

function dueLabel(due: string | null): { text: string; tone: string } | null {
  if (!due) return null
  const today = todayISO()
  if (due < today) return { text: 'Overdue', tone: 'bg-red-500/15 text-red-400 border-red-500/25' }
  if (due === today) return { text: 'Due today', tone: 'bg-amber-500/15 text-amber-500 border-amber-500/25' }
  const d = new Date(`${due}T00:00:00`)
  return {
    text: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
    tone: 'bg-secondary text-muted-foreground border-border',
  }
}

function Card({ row, dragging }: { row: MyWorkRow; dragging?: boolean }) {
  const due = dueLabel(row.due_date)
  return (
    <div className={`rounded-xl border border-border bg-card p-3 space-y-2 ${dragging ? 'shadow-xl' : 'shadow-sm'}`}>
      <p className="text-sm font-medium leading-snug break-words">{row.title}</p>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {/* Where it came from. Not needed to DO the work — the board treats
            both identically — but a designer glancing at a card should be able
            to tell a client request from something planned on the calendar. */}
        <span className={`px-1.5 py-0.5 rounded font-medium ${
          row.source === 'plan'
            ? 'bg-violet-500/15 text-violet-400'
            : 'bg-blue-500/15 text-blue-400'
        }`}>
          {row.source === 'plan' ? 'Plan' : row.ref_no ? `REQ-${String(row.ref_no).padStart(4, '0')}` : 'Request'}
        </span>
        {row.client_name && (
          <span className="px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">{row.client_name}</span>
        )}
        {row.service_name && (
          <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary">{row.service_name}</span>
        )}
        {due && <span className={`px-1.5 py-0.5 rounded-full border ${due.tone}`}>{due.text}</span>}
      </div>
    </div>
  )
}

function DraggableCard({ row, disabled }: { row: MyWorkRow; disabled?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: row.id, disabled })
  return (
    <div
      ref={setNodeRef} {...attributes} {...listeners}
      style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 60, position: 'relative' } : undefined}
      className={`${isDragging ? 'opacity-90 cursor-grabbing' : disabled ? '' : 'cursor-grab'} touch-none`}
    >
      <Card row={row} dragging={isDragging} />
    </div>
  )
}

function Column({ stage, rows, busyId, totalCount, footer }: {
  stage: WorkStage
  rows: MyWorkRow[]
  busyId: string | null
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
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-semibold">{STAGE_LABEL[stage]}</span>
        <span className={`text-[11px] px-1.5 py-0.5 rounded-full border ${STAGE_CHIP[stage]}`}>{totalCount ?? rows.length}</span>
      </div>
      <p className="text-[11px] text-muted-foreground mb-3">{STAGE_HINT[stage]}</p>
      <div className="space-y-2 flex-1">
        {rows.map(r => (
          <div key={r.id} className="relative">
            <DraggableCard row={r} disabled={busyId === r.id} />
            {busyId === r.id && (
              <div className="absolute inset-0 grid place-items-center rounded-xl bg-card/70">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
              </div>
            )}
          </div>
        ))}
        {rows.length === 0 && (
          <p className="text-[11px] text-muted-foreground/60 py-6 text-center">Nothing here</p>
        )}
      </div>
      {footer}
    </div>
  )
}

export default function MyWorkClient({ initialRows, firstName }: Props) {
  const router = useRouter()
  const toast = useToast()
  const [rows, setRows] = useState(initialRows)
  const [view, setView] = useState<'board' | 'calendar' | 'list'>('board')
  const [busyId, setBusyId] = useState<string | null>(null)

  // A touch sensor with a hold delay, not a raw pointer sensor: on a phone the
  // board scrolls, and without the delay every attempt to scroll a column
  // picks a card up instead.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
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
    const res = await moveMyWork(id, to, row.source)
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
        title="My Work"
        subtitle={pendingCount === 0 ? 'Nothing pending — you are all caught up' : `${pendingCount} still to do`}
      />

      {/* The whole point of the page, answered before anything else: how much
          is on my plate, and is any of it late. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="text-3xl font-bold">{pendingCount}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Still to do</p>
        </div>
        <div className={`rounded-2xl border p-4 ${overdueCount > 0 ? 'border-red-500/30 bg-red-500/5' : 'border-border bg-card'}`}>
          <p className={`text-3xl font-bold ${overdueCount > 0 ? 'text-red-400' : ''}`}>{overdueCount}</p>
          <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
            {overdueCount > 0 && <CircleAlert className="w-3 h-3 text-red-400" />} Overdue
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="text-3xl font-bold text-purple-400">{byStage.delivered.length}</p>
          <p className="text-xs text-muted-foreground mt-0.5">With the client</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="text-3xl font-bold text-green-500">{byStage.done.length}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Done</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 rounded-lg border border-border bg-secondary p-1 w-fit">
          {VIEWS.map(({ key, label, Icon }) => (
            <button
              key={key} onClick={() => setView(key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors
                ${view === key ? 'gradient-bg text-white' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <Icon className="w-4 h-4" /> {label}
            </button>
          ))}
        </div>

        {/* Client chips — only when there is actually a choice to make. One
            client means one chip that does nothing, which is worse than none. */}
        {clients.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => setClientFilter(null)}
              className={`px-2.5 py-1.5 rounded-lg text-xs border transition-colors
                ${clientFilter === null ? 'bg-primary/15 text-primary border-primary/30' : 'bg-secondary text-muted-foreground border-border hover:text-foreground'}`}
            >
              All clients
            </button>
            {clients.map(c => (
              <button
                key={c} onClick={() => setClientFilter(clientFilter === c ? null : c)}
                className={`px-2.5 py-1.5 rounded-lg text-xs border transition-colors
                  ${clientFilter === c ? 'bg-primary/15 text-primary border-primary/30' : 'bg-secondary text-muted-foreground border-border hover:text-foreground'}`}
              >
                {c}
              </button>
            ))}
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card px-5 py-12 text-center">
          <Check className="w-8 h-8 text-green-500 mx-auto mb-3" />
          <p className="font-medium">Nothing assigned to you yet, {firstName}</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
            When someone assigns you a request it appears here. Nothing to do until then.
          </p>
        </div>
      ) : view === 'board' ? (
        <>
          <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
            <div className="flex gap-3 overflow-x-auto pb-2 items-stretch">
              {WORK_STAGES.map(s => (
                <Column
                  key={s} stage={s}
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
          <p className="text-[11px] text-muted-foreground">
            Drag a card to the next column to update it. On a phone, press and hold a card first.
          </p>
        </>
      ) : view === 'calendar' ? (
        <CalendarView rows={visibleRows} />
      ) : (
        <ListView rows={visibleRows} onMove={apply} busyId={busyId} />
      )}

      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
    </div>
  )
}

/** Month grid of due dates — "when is this wanted", not "what stage is it". */
function CalendarView({ rows }: { rows: MyWorkRow[] }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7))
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
function ListView({ rows, onMove, busyId }: {
  rows: MyWorkRow[]
  onMove: (id: string, to: WorkStage) => void
  busyId: string | null
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
        const due = dueLabel(r.due_date)
        return (
          <div key={r.id} className="rounded-xl border border-border bg-card p-3 flex items-center gap-3 flex-wrap">
            <div className="min-w-0 flex-1">
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
                {STAGE_LABEL[next]}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

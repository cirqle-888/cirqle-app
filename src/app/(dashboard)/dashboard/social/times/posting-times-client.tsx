'use client'

/**
 * Posting times.
 *
 * Left: the client's standing weekly slots — the plan, typed in by whoever
 * read their analytics. Right: what the numbers say, kept visibly separate so
 * nobody mistakes evidence for a decision. Below: the bulk planner, which puts
 * a date range of posters into those slots.
 *
 * The planner is two steps on purpose. Scheduling thirty posts is not
 * something anyone should find out the result of afterwards, so it previews
 * every change — including the ones it could NOT make, with the reason — and
 * only writes when you say so.
 */

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { SocialTabs } from '@/components/social-hub/social-tabs'
import {
  Clock, Plus, Trash2, Loader2, CalendarRange, Check, AlertTriangle,
  Sparkles, ChevronRight, Info,
} from 'lucide-react'
import {
  WEEKDAY_LABEL, WEEKDAY_SHORT, formatTime12, normalizeTime,
  type Weekday, type BestTime,
} from '@/lib/social/posting-time'
import {
  listSlots, saveSlot, deleteSlot, listBestTimes,
  planAssignment, applyAssignment,
  type SlotView, type AssignmentPreview,
} from '@/lib/social/posting-actions'
import { todayISO, addDaysISO } from '@/lib/utils/local-date'

const WEEKDAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6]

interface Props {
  clients: Array<{ id: string; name: string }>
  ready: boolean
  canManage: boolean
  canPublish: boolean
}

export default function PostingTimesClient({ clients, ready, canManage, canPublish }: Props) {
  const [clientId, setClientId] = useState(clients[0]?.id ?? '')
  const [slots, setSlots] = useState<SlotView[]>([])
  const [best, setBest] = useState<BestTime[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, startLoad] = useTransition()

  const client = clients.find(c => c.id === clientId)

  const refresh = useCallback((id: string) => {
    if (!id) return
    startLoad(async () => {
      const [s, b] = await Promise.all([listSlots(id), listBestTimes(id)])
      if (s.ok) setSlots(s.data ?? []); else setError(s.error ?? null)
      if (b.ok) setBest(b.data ?? [])
    })
  }, [])

  useEffect(() => { refresh(clientId) }, [clientId, refresh])

  if (!ready) {
    return (
      <div className="p-4 sm:p-6 space-y-5">
        <SocialTabs />
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-500">Posting times are not switched on yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              The database migration <code>20261017090000_social_posting_times</code> has not been
              applied. Everything else keeps working; this page fills in once it runs.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <SocialTabs />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Posting Times</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            The times you&apos;ve decided for each client, and a way to put a month of posts into them.
          </p>
        </div>
        {clients.length > 0 && (
          <select
            value={clientId}
            onChange={e => setClientId(e.target.value)}
            className="h-9 rounded-lg border border-border bg-secondary px-3 text-sm min-w-[200px]"
            aria-label="Client"
          >
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {!clients.length ? (
        <p className="text-sm text-muted-foreground">
          No clients have social posting switched on yet. Plan a month for a client first.
        </p>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-[1.25fr_1fr]">
            <SlotEditor
              clientId={clientId}
              slots={slots}
              loading={loading}
              canManage={canManage}
              onChanged={() => refresh(clientId)}
            />
            <Evidence best={best} slots={slots} />
          </div>

          {canPublish && (
            <BulkPlanner clientId={clientId} clientName={client?.name ?? 'this client'} slotCount={slots.length} />
          )}
        </>
      )}
    </div>
  )
}

// ── Slots ────────────────────────────────────────────────────────────────────

function SlotEditor({ clientId, slots, loading, canManage, onChanged }: {
  clientId: string
  slots: SlotView[]
  loading: boolean
  canManage: boolean
  onChanged: () => void
}) {
  const [weekday, setWeekday] = useState<Weekday>(1)
  const [time, setTime] = useState('19:30')
  const [label, setLabel] = useState('')
  const [busy, start] = useTransition()
  const [err, setErr] = useState<string | null>(null)

  const byDay = useMemo(() => {
    const map = new Map<Weekday, SlotView[]>()
    for (const s of slots) map.set(s.weekday, [...(map.get(s.weekday) ?? []), s])
    return map
  }, [slots])

  function add() {
    if (!normalizeTime(time)) { setErr('Enter a time as HH:MM, for example 19:30.'); return }
    start(async () => {
      const res = await saveSlot({ clientId, weekday, time, label: label || null })
      if (!res.ok) { setErr(res.error ?? 'Could not save.'); return }
      setErr(null); setLabel(''); onChanged()
    })
  }

  function remove(id: string) {
    start(async () => {
      const res = await deleteSlot(id)
      if (!res.ok) { setErr(res.error ?? 'Could not remove.'); return }
      onChanged()
    })
  }

  return (
    <section className="rounded-xl border border-border bg-secondary/30 p-4">
      <div className="flex items-center gap-2 mb-1">
        <Clock className="w-4 h-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Weekly slots</h2>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        The times this client&apos;s posts go out. These are what pre-fill the planner and what the
        bulk assigner fills, in order.
      </p>

      {canManage && (
        <div className="flex flex-wrap items-end gap-2 mb-4">
          <label className="text-xs">
            <span className="block mb-1 text-muted-foreground">Day</span>
            <select
              value={weekday}
              onChange={e => setWeekday(Number(e.target.value) as Weekday)}
              className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
            >
              {WEEKDAYS.map(d => <option key={d} value={d}>{WEEKDAY_LABEL[d]}</option>)}
            </select>
          </label>
          <label className="text-xs">
            <span className="block mb-1 text-muted-foreground">Time</span>
            <input
              type="time"
              value={time}
              onChange={e => setTime(e.target.value)}
              className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
            />
          </label>
          <label className="text-xs flex-1 min-w-[140px]">
            <span className="block mb-1 text-muted-foreground">Label (optional)</span>
            <input
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="Prime evening"
              className="h-9 w-full rounded-lg border border-border bg-background px-2 text-sm"
            />
          </label>
          <Button size="sm" onClick={add} disabled={busy} className="gap-1.5">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            Add
          </Button>
        </div>
      )}

      {err && <p className="text-xs text-red-400 mb-2">{err}</p>}

      {loading ? (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
        </p>
      ) : slots.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No slots yet. Until there are, the planner has nothing to suggest and the bulk assigner
          has nothing to fill.
        </p>
      ) : (
        <div className="space-y-1.5">
          {WEEKDAYS.filter(d => byDay.get(d)?.length).map(d => (
            <div key={d} className="flex items-start gap-3">
              <span className="w-10 shrink-0 text-xs text-muted-foreground pt-1.5">{WEEKDAY_SHORT[d]}</span>
              <div className="flex flex-wrap gap-1.5">
                {(byDay.get(d) ?? []).map(s => (
                  <span
                    key={s.id}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs"
                  >
                    <span className="font-medium">{formatTime12(s.time)}</span>
                    {s.label && <span className="text-muted-foreground">{s.label}</span>}
                    {canManage && (
                      <button
                        onClick={() => remove(s.id)}
                        className="text-muted-foreground hover:text-red-400"
                        aria-label={`Remove ${WEEKDAY_LABEL[d]} ${s.time}`}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// ── Evidence ─────────────────────────────────────────────────────────────────

function Evidence({ best, slots }: { best: BestTime[]; slots: SlotView[] }) {
  const top = useMemo(() => [...best].sort((a, b) => b.score - a.score).slice(0, 8), [best])
  const slotTimes = useMemo(() => new Set(slots.map(s => `${s.weekday}-${s.time.slice(0, 2)}`)), [slots])

  return (
    <section className="rounded-xl border border-border bg-secondary/30 p-4">
      <div className="flex items-center gap-2 mb-1">
        <Sparkles className="w-4 h-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">What the numbers say</h2>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        From the client&apos;s own analytics. These only ever suggest — nothing here changes a slot,
        because a number can&apos;t know the client asked for 7pm.
      </p>

      {top.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Nothing yet. Connect the client&apos;s Instagram for hourly follower data, or import a
          screenshot of their dashboard.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {top.map((b, i) => {
            const covered = slotTimes.has(`${b.weekday}-${String(b.hour).padStart(2, '0')}`)
            return (
              <li key={`${b.weekday}-${b.hour}-${i}`} className="flex items-center gap-2 text-xs">
                <span className="w-10 text-muted-foreground">{WEEKDAY_SHORT[b.weekday]}</span>
                <span className="font-medium w-16">{formatTime12(`${String(b.hour).padStart(2, '0')}:00`)}</span>
                <span className="flex-1 h-1.5 rounded-full bg-border overflow-hidden">
                  <span
                    className="block h-full bg-violet-500/70"
                    style={{ width: `${Math.max(4, Math.min(100, (b.score / (top[0]?.score || 1)) * 100))}%` }}
                  />
                </span>
                {covered
                  ? <Check className="w-3.5 h-3.5 text-green-500 shrink-0" aria-label="You already post around then" />
                  : <span className="text-[10px] text-muted-foreground shrink-0">no slot</span>}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// ── Bulk planner ─────────────────────────────────────────────────────────────

function BulkPlanner({ clientId, clientName, slotCount }: {
  clientId: string
  clientName: string
  slotCount: number
}) {
  const [from, setFrom] = useState(() => todayISO())
  const [to, setTo] = useState(() => addDaysISO(todayISO(), 30))
  const [overwrite, setOverwrite] = useState(false)
  const [preview, setPreview] = useState<AssignmentPreview | null>(null)
  const [done, setDone] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, start] = useTransition()

  function run() {
    setDone(null); setErr(null)
    start(async () => {
      const res = await planAssignment({ clientId, fromISO: from, toISO: to, overwrite })
      if (!res.ok) { setErr(res.error ?? 'Could not plan.'); setPreview(null); return }
      setPreview(res.data ?? null)
    })
  }

  function write() {
    if (!preview?.changes.length) return
    start(async () => {
      const res = await applyAssignment(preview.changes.map(c => ({ itemId: c.itemId, to: c.to })))
      if (!res.ok) { setErr(res.error ?? 'Could not save.'); return }
      setDone(res.data?.written ?? 0); setPreview(null)
    })
  }

  return (
    <section className="rounded-xl border border-border bg-secondary/30 p-4">
      <div className="flex items-center gap-2 mb-1">
        <CalendarRange className="w-4 h-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Plan a stretch at once</h2>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Fills {clientName}&apos;s slots, highest-priority post first. It never moves a post to another
        day — anything that doesn&apos;t fit comes back with the reason.
      </p>

      <div className="flex flex-wrap items-end gap-2 mb-3">
        <label className="text-xs">
          <span className="block mb-1 text-muted-foreground">From</span>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
            className="h-9 rounded-lg border border-border bg-background px-2 text-sm" />
        </label>
        <label className="text-xs">
          <span className="block mb-1 text-muted-foreground">To</span>
          <input type="date" value={to} onChange={e => setTo(e.target.value)}
            className="h-9 rounded-lg border border-border bg-background px-2 text-sm" />
        </label>
        <label className="text-xs flex items-center gap-1.5 h-9">
          <input type="checkbox" checked={overwrite} onChange={e => setOverwrite(e.target.checked)} />
          <span>Re-time posts that already have one</span>
        </label>
        <Button size="sm" variant="outline" onClick={run} disabled={busy || slotCount === 0} className="gap-1.5">
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ChevronRight className="w-3.5 h-3.5" />}
          Preview
        </Button>
      </div>

      {slotCount === 0 && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Info className="w-3.5 h-3.5" /> Add a weekly slot first — there is nothing to fill.
        </p>
      )}
      {err && <p className="text-xs text-red-400">{err}</p>}
      {done !== null && (
        <p className="text-xs text-green-500 flex items-center gap-1.5">
          <Check className="w-3.5 h-3.5" /> {done} post{done === 1 ? '' : 's'} given a time.
        </p>
      )}

      {preview && (
        <div className="mt-3 space-y-3">
          {preview.changes.length > 0 && (
            <div>
              <p className="text-xs font-medium mb-1.5">
                {preview.changes.length} post{preview.changes.length === 1 ? '' : 's'} would be scheduled
              </p>
              <div className="max-h-64 overflow-auto rounded-lg border border-border divide-y divide-border">
                {preview.changes.map(c => (
                  <div key={c.itemId} className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
                    <span className="text-muted-foreground w-20 shrink-0">{c.isoDate}</span>
                    <span className="flex-1 truncate">{c.title}</span>
                    {c.from && <span className="text-muted-foreground line-through">{formatTime12(c.from)}</span>}
                    <span className="font-medium">{formatTime12(c.to)}</span>
                    {c.source !== 'slot' && (
                      <span className="text-[10px] text-violet-400 shrink-0">from analytics</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {preview.unplaced.length > 0 && (
            <div>
              <p className="text-xs font-medium text-amber-500 mb-1.5">
                {preview.unplaced.length} could not be placed
              </p>
              <ul className="space-y-1">
                {preview.unplaced.map(u => (
                  <li key={u.itemId} className="text-xs text-muted-foreground">
                    <span className="text-foreground">{u.title}</span> — {u.isoDate} · {u.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {preview.skipped.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {preview.skipped.length} left alone ({preview.skipped[0].reason.toLowerCase()}
              {preview.skipped.length > 1 ? ', and others' : ''}).
            </p>
          )}

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={write} disabled={busy || !preview.changes.length} className="gap-1.5">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Apply {preview.changes.length || ''}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

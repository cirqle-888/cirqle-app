'use client'

/**
 * Plan picker — the Social Calendar's "which plan am I looking at" control.
 *
 * The generic Combobox listed every plan as "Client — Month" with a line of
 * counts under it, which made the two everyday moves slow: stepping the SAME
 * client to another month, and finding which of this month's plans still need
 * work. This picker is built around those two moves:
 *
 *   • ‹ › beside the trigger step through the current client's months.
 *   • The list is grouped by MONTH, so each row is just a client name with a
 *     plain-words state next to it ("3 to send", "All sent", "Empty").
 *   • "Not planned yet" names the clients who had a plan last time round and
 *     have none for this month or next — one click starts it.
 *
 * Nothing here can clear the selection: a calendar with no plan picked is an
 * empty page, so the old "×" on the trigger only ever led to a dead end.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronLeft, ChevronRight, Plus, Search, X, Archive } from 'lucide-react'

export interface PlanOption {
  id: string
  clientId: string
  clientName: string
  /** YYYY-MM-01 */
  month: string
  title: string | null
  status: 'draft' | 'active' | 'archived'
  /** Items on the plan, cancelled ones left out. */
  total: number
  /** Items already handed on (a request or a task holds them). */
  sent: number
  /** Items whose date has passed unfinished — known for recent months only. */
  late?: number
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

const ym = (month: string) => month.slice(0, 7)
const monthName = (key: string) => {
  const [y, m] = key.split('-').map(Number)
  return `${MONTHS[m - 1]} ${y}`
}
const shiftMonth = (key: string, by: number) => {
  const [y, m] = key.split('-').map(Number)
  const d = new Date(y, m - 1 + by, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** Plain-words state of a plan, and the tone it is drawn in. */
function planState(p: PlanOption): { label: string; tone: 'muted' | 'amber' | 'green' | 'blue' | 'red' } {
  if (p.status === 'archived') return { label: 'Archived', tone: 'muted' }
  // Late outranks every other state: it is the one that is already costing something.
  if (p.late) return { label: `${p.late} late`, tone: 'red' }
  if (p.total === 0) return { label: 'Empty', tone: 'muted' }
  if (p.status === 'draft') return { label: `Draft · ${p.total}`, tone: 'amber' }
  const left = p.total - p.sent
  if (left === 0) return { label: 'All sent', tone: 'green' }
  if (p.sent === 0) return { label: `${p.total} to send`, tone: 'amber' }
  return { label: `${left} to send`, tone: 'amber' }
}

const TONE: Record<'muted' | 'amber' | 'green' | 'blue' | 'red', string> = {
  muted: 'text-muted-foreground',
  amber: 'text-amber-600 dark:text-amber-400',
  green: 'text-emerald-600 dark:text-emerald-400',
  blue: 'text-blue-600 dark:text-blue-400',
  red: 'text-red-600 dark:text-red-400',
}

type Row =
  | { kind: 'header'; key: string; label: string; hint?: string }
  | { kind: 'plan'; key: string; plan: PlanOption; showMonth: boolean }
  | { kind: 'missing'; key: string; clientId: string; clientName: string; month: string }
  | { kind: 'toggle'; key: string; label: string }

const PANEL_MIN_W = 380
const MARGIN = 8

export function PlanPicker({
  plans, selectedId, onSelect, thisMonth, canManage, onNewPlan,
}: {
  plans: PlanOption[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** YYYY-MM for today, passed in so server and client agree on "this month". */
  thisMonth: string
  canManage: boolean
  /** Opens the New Plan form, optionally prefilled for a client and month. */
  onNewPlan: (prefill?: { clientId: string; month: string }) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  // The highlighted row, by key. null = "wherever the open plan is", so the
  // highlight starts on the current plan and Enter is never a surprise.
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxH: number } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const selected = plans.find(p => p.id === selectedId) ?? null

  // ── Same client, neighbouring months (the ‹ › buttons) ────────────────────
  const { prev, next } = useMemo(() => {
    if (!selected) return { prev: null, next: null }
    const same = plans
      .filter(p => p.clientId === selected.clientId && p.status !== 'archived' && p.id !== selected.id)
    const before = same.filter(p => p.month < selected.month).sort((a, b) => b.month.localeCompare(a.month))[0] ?? null
    const after = same.filter(p => p.month > selected.month).sort((a, b) => a.month.localeCompare(b.month))[0] ?? null
    return { prev: before, next: after }
  }, [plans, selected])

  // ── Rows ──────────────────────────────────────────────────────────────────
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    const byClient = (a: PlanOption, b: PlanOption) => a.clientName.localeCompare(b.clientName)

    const q = query.trim().toLowerCase()
    if (q) {
      // Searching is flat: every plan whose client, month or label matches,
      // newest month first, with the month shown on the row.
      const hits = plans
        .filter(p => `${p.clientName} ${monthName(ym(p.month))} ${p.title ?? ''}`.toLowerCase().includes(q))
        .sort((a, b) => b.month.localeCompare(a.month) || byClient(a, b))
      for (const p of hits) out.push({ kind: 'plan', key: p.id, plan: p, showMonth: true })
      return out
    }

    const live = plans.filter(p => p.status !== 'archived')
    const archived = plans.filter(p => p.status === 'archived')
    const nextMonth = shiftMonth(thisMonth, 1)
    const lastMonth = shiftMonth(thisMonth, -1)

    const group = (label: string, list: PlanOption[], hint?: string) => {
      if (!list.length) return
      out.push({ kind: 'header', key: `h-${label}`, label, hint })
      for (const p of [...list].sort(byClient)) out.push({ kind: 'plan', key: p.id, plan: p, showMonth: false })
    }

    group(`This month · ${monthName(thisMonth)}`, live.filter(p => ym(p.month) === thisMonth))
    group(`Next month · ${monthName(nextMonth)}`, live.filter(p => ym(p.month) === nextMonth))

    // Clients who were planned the month before and have nothing for this
    // month / next month yet. Derived from plans alone, so it only ever names
    // clients this calendar already works with.
    if (canManage) {
      const has = (clientId: string, key: string) => live.some(p => p.clientId === clientId && ym(p.month) === key)
      const missing: Extract<Row, { kind: 'missing' }>[] = []
      const seen = new Set<string>()
      const consider = (source: string, target: string) => {
        for (const p of live.filter(x => ym(x.month) === source).sort(byClient)) {
          const k = `${p.clientId}:${target}`
          if (seen.has(k) || has(p.clientId, target)) continue
          seen.add(k)
          missing.push({ kind: 'missing', key: `m-${k}`, clientId: p.clientId, clientName: p.clientName, month: target })
        }
      }
      consider(lastMonth, thisMonth)
      consider(thisMonth, nextMonth)
      if (missing.length) {
        out.push({ kind: 'header', key: 'h-missing', label: 'Not planned yet' })
        out.push(...missing.slice(0, 6))
      }
    }

    // Later months, one header each, soonest first.
    const later = live.filter(p => ym(p.month) > nextMonth)
    for (const key of [...new Set(later.map(p => ym(p.month)))].sort()) {
      group(monthName(key), later.filter(p => ym(p.month) === key))
    }

    // Past months, newest first.
    const past = live.filter(p => ym(p.month) < thisMonth)
    for (const key of [...new Set(past.map(p => ym(p.month)))].sort().reverse()) {
      group(monthName(key), past.filter(p => ym(p.month) === key), key === lastMonth ? 'last month' : undefined)
    }

    if (archived.length) {
      out.push({ kind: 'toggle', key: 'archived-toggle', label: `Archived (${archived.length})` })
      if (showArchived) {
        for (const p of [...archived].sort((a, b) => b.month.localeCompare(a.month) || byClient(a, b))) {
          out.push({ kind: 'plan', key: p.id, plan: p, showMonth: true })
        }
      }
    }
    return out
  }, [plans, query, thisMonth, canManage, showArchived])

  /** Indexes of rows the arrow keys can land on. */
  const stops = useMemo(() => rows.map((r, i) => (r.kind === 'header' ? -1 : i)).filter(i => i >= 0), [rows])
  const active = useMemo(() => {
    const at = activeKey ? rows.findIndex(r => r.key === activeKey) : -1
    if (at >= 0) return at
    const current = rows.findIndex(r => r.kind === 'plan' && r.plan.id === selectedId)
    return current >= 0 ? current : (stops[0] ?? 0)
  }, [activeKey, rows, selectedId, stops])
  const setActive = (i: number) => setActiveKey(rows[i]?.key ?? null)

  // ── Open / close ──────────────────────────────────────────────────────────
  function openPanel() {
    setQuery('')
    setActiveKey(null)
    setOpen(true)
  }
  function close() { setOpen(false); setQuery('') }

  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return
    const place = () => {
      const r = wrapRef.current!.getBoundingClientRect()
      const width = Math.min(Math.max(r.width, PANEL_MIN_W), window.innerWidth - MARGIN * 2)
      setPos({
        top: r.bottom + 6,
        left: Math.max(MARGIN, Math.min(r.left, window.innerWidth - width - MARGIN)),
        width,
        maxH: Math.max(220, window.innerHeight - r.bottom - 6 - MARGIN * 2),
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t) || wrapRef.current?.contains(t)) return
      close()
    }
    document.addEventListener('mousedown', onDown)
    const focus = window.setTimeout(() => inputRef.current?.focus(), 30)
    return () => { document.removeEventListener('mousedown', onDown); window.clearTimeout(focus) }
  }, [open])

  // Keep the highlighted row in view while arrowing.
  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  function activate(row: Row | undefined) {
    if (!row) return
    if (row.kind === 'plan') { close(); if (row.plan.id !== selectedId) onSelect(row.plan.id) }
    else if (row.kind === 'missing') { close(); onNewPlan({ clientId: row.clientId, month: row.month }) }
    else if (row.kind === 'toggle') setShowArchived(v => !v)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return }
    if (e.key === 'Enter') { e.preventDefault(); activate(rows[active]); return }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    if (!stops.length) return
    const at = stops.indexOf(active)
    const step = e.key === 'ArrowDown' ? 1 : -1
    setActive(stops[(Math.max(at, 0) + step + stops.length) % stops.length])
  }

  const stepBtn = 'inline-flex h-10 w-8 items-center justify-center text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground'

  return (
    <div ref={wrapRef} className="flex w-full min-w-0 items-stretch rounded-xl border border-border bg-secondary/50 sm:w-auto">
      <button
        type="button" className={`${stepBtn} rounded-l-xl`}
        disabled={!prev} onClick={() => prev && onSelect(prev.id)}
        aria-label="Previous month for this client"
        title={prev ? `${monthName(ym(prev.month))} — same client` : 'No earlier plan for this client'}
      >
        <ChevronLeft className="h-4 w-4" />
      </button>

      <button
        type="button"
        onClick={() => (open ? close() : openPanel())}
        aria-haspopup="listbox" aria-expanded={open}
        className={`flex min-w-0 flex-1 items-center gap-2 border-x border-border px-3 py-1.5 text-left transition-colors hover:bg-secondary/60 sm:min-w-[260px] ${open ? 'bg-secondary/60' : ''}`}
      >
        <span className="min-w-0 flex-1">
          {selected ? (
            <>
              <span className="block truncate text-sm font-semibold leading-tight">{selected.clientName}</span>
              <span className="block truncate text-[11px] leading-tight text-muted-foreground">
                {monthName(ym(selected.month))}{selected.title ? ` · ${selected.title}` : ''}
              </span>
            </>
          ) : (
            <span className="block truncate text-sm text-muted-foreground">
              {plans.length ? 'Pick a plan…' : 'No plans yet'}
            </span>
          )}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>

      <button
        type="button" className={`${stepBtn} rounded-r-xl`}
        disabled={!next} onClick={() => next && onSelect(next.id)}
        aria-label="Next month for this client"
        title={next ? `${monthName(ym(next.month))} — same client` : 'No later plan for this client'}
      >
        <ChevronRight className="h-4 w-4" />
      </button>

      {open && pos && typeof document !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          onKeyDown={onKeyDown}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, zIndex: 1000 }}
          className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl animate-in fade-in slide-in-from-top-1 duration-100"
        >
          <div className="border-b border-border p-2">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary px-2.5 py-1.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                ref={inputRef}
                value={query}
                onChange={e => { setQuery(e.target.value); setActiveKey(null) }}
                placeholder="Search client or month…"
                aria-label="Search plans"
                className="min-w-0 flex-1 bg-transparent text-sm placeholder:text-muted-foreground/70 focus:outline-none"
              />
              {query && (
                <button type="button" onClick={() => { setQuery(''); setActiveKey(null); inputRef.current?.focus() }}
                  aria-label="Clear search" className="text-muted-foreground hover:text-foreground">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          <div ref={listRef} role="listbox" className="overflow-y-auto overscroll-contain py-1"
            style={{ maxHeight: Math.min(420, pos.maxH - 110) }}>
            {rows.length === 0 && (
              <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                {query ? `No plan matches “${query.trim()}”.` : 'No plans yet.'}
              </p>
            )}
            {rows.map((row, i) => {
              if (row.kind === 'header') {
                return (
                  <div key={row.key} className="flex items-baseline gap-2 px-3 pb-1 pt-2.5">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{row.label}</span>
                    {row.hint && <span className="text-[10px] text-muted-foreground/70">{row.hint}</span>}
                  </div>
                )
              }
              const isActive = i === active
              if (row.kind === 'toggle') {
                return (
                  <button key={row.key} type="button" data-row={i}
                    onMouseEnter={() => setActive(i)} onClick={() => activate(row)}
                    className={`mt-1 flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-xs text-muted-foreground transition-colors ${isActive ? 'bg-secondary text-foreground' : ''}`}>
                    <Archive className="h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1">{row.label}</span>
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showArchived ? 'rotate-180' : ''}`} />
                  </button>
                )
              }
              if (row.kind === 'missing') {
                return (
                  <button key={row.key} type="button" data-row={i}
                    onMouseEnter={() => setActive(i)} onClick={() => activate(row)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${isActive ? 'bg-secondary' : ''}`}>
                    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-dashed border-primary/50 text-primary">
                      <Plus className="h-3 w-3" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm">{row.clientName}</span>
                    <span className="shrink-0 text-[11px] font-medium text-primary">Plan {monthName(row.month).split(' ')[0]}</span>
                  </button>
                )
              }
              const p = row.plan
              const state = planState(p)
              const isSelected = p.id === selectedId
              const pct = p.total > 0 ? Math.round((p.sent / p.total) * 100) : 0
              return (
                <button key={row.key} type="button" role="option" aria-selected={isSelected} data-row={i}
                  onMouseEnter={() => setActive(i)} onClick={() => activate(row)}
                  className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${isActive ? 'bg-secondary' : ''}`}>
                  <span className={`h-6 w-0.5 shrink-0 rounded-full ${isSelected ? 'bg-primary' : 'bg-transparent'}`} />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-sm ${isSelected ? 'font-semibold text-primary' : 'font-medium'}`}>{p.clientName}</span>
                    {(row.showMonth || p.title) && (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {[row.showMonth ? monthName(ym(p.month)) : null, p.title].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <span className={`text-[11px] font-medium tabular-nums ${TONE[state.tone]}`}>{state.label}</span>
                    {p.total > 0 && p.status !== 'archived' && (
                      <span className="flex items-center gap-1.5" title={`${p.sent} of ${p.total} sent on`}>
                        <span className="h-1 w-14 overflow-hidden rounded-full bg-foreground/10">
                          <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
                        </span>
                        <span className="text-[10px] tabular-nums text-muted-foreground">{p.sent}/{p.total}</span>
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>

          {canManage && (
            <button type="button" onClick={() => { close(); onNewPlan() }}
              className="flex items-center gap-2 border-t border-border px-3 py-2.5 text-left text-sm font-medium text-primary transition-colors hover:bg-primary/5">
              <Plus className="h-4 w-4" /> New plan
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}

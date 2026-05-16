'use client'

import { useState, useRef, useEffect } from 'react'
import { Calendar, ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react'

export type DateFilterValue =
  | null
  | { type: 'today' }
  | { type: 'yesterday' }
  | { type: 'last7' }
  | { type: 'last30' }
  | { type: 'thisMonth' }
  | { type: 'lastMonth' }
  | { type: 'month'; year: number; month: number }   // 0-indexed month
  | { type: 'range'; from: string; to: string }       // ISO date strings YYYY-MM-DD
  | { type: 'day'; date: string }                     // specific single day YYYY-MM-DD

const PRESETS = [
  { key: 'today',     label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7',     label: 'Last 7 days' },
  { key: 'last30',    label: 'Last 30 days' },
  { key: 'thisMonth', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' },
] as const

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function getDateFilterLabel(filter: DateFilterValue): string {
  if (!filter) return 'All dates'
  switch (filter.type) {
    case 'today':     return 'Today'
    case 'yesterday': return 'Yesterday'
    case 'last7':     return 'Last 7 days'
    case 'last30':    return 'Last 30 days'
    case 'thisMonth': return 'This month'
    case 'lastMonth': return 'Last month'
    case 'month':     return `${MONTH_NAMES[filter.month]} ${filter.year}`
    case 'range':
      if (filter.from === filter.to) return filter.from
      return `${filter.from} → ${filter.to}`
    case 'day':       return filter.date
  }
}

/** Returns true if taskDate (YYYY-MM-DD string) matches the active date filter */
export function matchesDateFilter(taskDate: string | null | undefined, filter: DateFilterValue): boolean {
  if (!filter || !taskDate) return true

  const today = new Date(); today.setHours(0, 0, 0, 0)
  const d = new Date(taskDate); d.setHours(12, 0, 0, 0) // noon to avoid tz issues

  switch (filter.type) {
    case 'today': {
      const t = new Date(today); t.setHours(12, 0, 0, 0)
      return d.toDateString() === t.toDateString()
    }
    case 'yesterday': {
      const y = new Date(today); y.setDate(y.getDate() - 1); y.setHours(12, 0, 0, 0)
      return d.toDateString() === y.toDateString()
    }
    case 'last7': {
      const from = new Date(today); from.setDate(from.getDate() - 6)
      return d >= from && d <= new Date(today.getTime() + 86400000)
    }
    case 'last30': {
      const from = new Date(today); from.setDate(from.getDate() - 29)
      return d >= from && d <= new Date(today.getTime() + 86400000)
    }
    case 'thisMonth':
      return d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth()
    case 'lastMonth': {
      const lm = new Date(today.getFullYear(), today.getMonth() - 1, 1)
      return d.getFullYear() === lm.getFullYear() && d.getMonth() === lm.getMonth()
    }
    case 'month':
      return d.getFullYear() === filter.year && d.getMonth() === filter.month
    case 'range': {
      const from = new Date(filter.from); from.setHours(0, 0, 0, 0)
      const to   = new Date(filter.to);   to.setHours(23, 59, 59, 999)
      return d >= from && d <= to
    }
    case 'day': {
      const day = new Date(filter.date); day.setHours(12, 0, 0, 0)
      return d.toDateString() === day.toDateString()
    }
  }
}

interface Props {
  value: DateFilterValue
  onChange: (v: DateFilterValue) => void
  className?: string
}

type PanelMode = 'presets' | 'month' | 'range' | 'day'

export function DateFilter({ value, onChange, className = '' }: Props) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<PanelMode>('presets')
  const now = new Date()
  const [monthNav, setMonthNav] = useState({ year: now.getFullYear(), month: now.getMonth() })
  const [range, setRange] = useState({ from: '', to: '' })
  const [singleDay, setSingleDay] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  // Pre-fill inputs from active filter
  useEffect(() => {
    if (value?.type === 'range') setRange({ from: value.from, to: value.to })
    if (value?.type === 'day') setSingleDay(value.date)
  }, [value])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const isActive = value !== null
  const label = getDateFilterLabel(value)

  function selectPreset(type: string) {
    onChange({ type } as DateFilterValue)
    setOpen(false)
  }

  function selectMonth(year: number, month: number) {
    onChange({ type: 'month', year, month })
    setOpen(false)
  }

  function applyRange() {
    if (!range.from || !range.to) return
    const to = range.to < range.from ? range.from : range.to
    onChange({ type: 'range', from: range.from, to })
    setOpen(false)
  }

  function applyDay() {
    if (!singleDay) return
    onChange({ type: 'day', date: singleDay })
    setOpen(false)
  }

  return (
    <div ref={ref} className={`relative ${className}`}>
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-2 h-[34px] px-3 rounded-lg text-sm font-medium transition-all border ${
          isActive
            ? 'bg-primary/10 border-primary/30 text-primary'
            : 'bg-secondary border-transparent text-muted-foreground hover:text-foreground hover:border-border/50'
        }`}
      >
        <Calendar className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate max-w-[110px]">{label}</span>
        {isActive ? (
          <button type="button" onClick={e => { e.stopPropagation(); onChange(null) }}
            className="shrink-0 opacity-50 hover:opacity-100 transition-opacity">
            <X className="w-3 h-3" />
          </button>
        ) : (
          <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
        )}
      </button>

      {/* Panel */}
      {open && (
        <div className="absolute top-full left-0 mt-1.5 z-50 bg-card border border-border rounded-xl shadow-2xl shadow-black/25 w-72 overflow-hidden">

          {/* Mode tabs */}
          <div className="flex items-center gap-1 p-2 border-b border-border">
            {(['presets', 'month', 'range', 'day'] as PanelMode[]).map(m => (
              <button key={m} type="button" onClick={() => setMode(m)}
                className={`flex-1 text-[11px] font-semibold py-1.5 rounded-lg transition-all ${
                  mode === m
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
                }`}>
                {m === 'presets' ? 'Quick pick' : m === 'month' ? 'By month' : m === 'range' ? 'Date range' : 'Pick day'}
              </button>
            ))}
          </div>

          {/* Quick presets */}
          {mode === 'presets' && (
            <div className="p-2.5 grid grid-cols-2 gap-1.5">
              {PRESETS.map(p => {
                const active = value?.type === p.key
                return (
                  <button key={p.key} type="button" onClick={() => selectPreset(p.key)}
                    className={`px-3 py-2.5 rounded-xl text-sm font-medium text-left transition-all border ${
                      active
                        ? 'gradient-bg text-white border-transparent shadow-sm'
                        : 'bg-secondary border-transparent text-muted-foreground hover:text-foreground hover:border-border/50'
                    }`}>
                    {p.label}
                  </button>
                )
              })}
            </div>
          )}

          {/* Month picker */}
          {mode === 'month' && (
            <div className="p-3">
              <div className="flex items-center justify-between mb-3">
                <button type="button" onClick={() => setMonthNav(n => {
                  if (n.month === 0) return { year: n.year - 1, month: 11 }
                  // just decrement year freely
                  return { ...n, year: n.year - 1 }
                })} className="p-1.5 rounded-lg hover:bg-secondary transition-colors">
                  <ChevronLeft className="w-4 h-4 text-muted-foreground" />
                </button>
                <span className="text-sm font-bold">{monthNav.year}</span>
                <button type="button" onClick={() => setMonthNav(n => ({ ...n, year: n.year + 1 }))}
                  className="p-1.5 rounded-lg hover:bg-secondary transition-colors">
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </button>
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {MONTH_NAMES.map((m, i) => {
                  const isSelected = value?.type === 'month' && value.year === monthNav.year && value.month === i
                  const isCurrent  = now.getFullYear() === monthNav.year && now.getMonth() === i
                  return (
                    <button key={m} type="button" onClick={() => selectMonth(monthNav.year, i)}
                      className={`py-2 rounded-xl text-xs font-semibold transition-all ${
                        isSelected
                          ? 'gradient-bg text-white shadow-sm'
                          : isCurrent
                            ? 'bg-primary/10 text-primary border border-primary/20'
                            : 'bg-secondary text-muted-foreground hover:text-foreground'
                      }`}>
                      {m}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Date range */}
          {mode === 'range' && (
            <div className="p-3 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wide mb-1.5 block">From</label>
                  <input type="date" value={range.from}
                    onChange={e => setRange(r => ({ ...r, from: e.target.value }))}
                    className="w-full bg-secondary border border-border rounded-lg px-2 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50" />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wide mb-1.5 block">To</label>
                  <input type="date" value={range.to} min={range.from}
                    onChange={e => setRange(r => ({ ...r, to: e.target.value }))}
                    className="w-full bg-secondary border border-border rounded-lg px-2 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50" />
                </div>
              </div>
              <button type="button" onClick={applyRange} disabled={!range.from || !range.to}
                className="w-full gradient-bg text-white text-sm font-semibold py-2.5 rounded-xl hover:opacity-90 disabled:opacity-40 transition-opacity">
                Apply Range
              </button>
            </div>
          )}

          {/* Specific day */}
          {mode === 'day' && (
            <div className="p-3 space-y-3">
              <div>
                <label className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wide mb-1.5 block">Choose a day</label>
                <input
                  type="date"
                  value={singleDay}
                  onChange={e => setSingleDay(e.target.value)}
                  className="w-full bg-secondary border border-border rounded-lg px-2 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
              {/* Quick shortcuts for nearby days */}
              <div className="grid grid-cols-3 gap-1.5">
                {[-2, -1, 0].map(offset => {
                  const d = new Date(); d.setDate(d.getDate() + offset)
                  const iso = d.toISOString().slice(0, 10)
                  const label = offset === 0 ? 'Today' : offset === -1 ? 'Yesterday' : d.toLocaleDateString('en', { weekday: 'short', day: 'numeric' })
                  return (
                    <button key={offset} type="button" onClick={() => setSingleDay(iso)}
                      className={`text-[11px] font-semibold py-1.5 rounded-lg transition-all ${
                        singleDay === iso
                          ? 'gradient-bg text-white shadow-sm'
                          : 'bg-secondary text-muted-foreground hover:text-foreground'
                      }`}>
                      {label}
                    </button>
                  )
                })}
              </div>
              <button type="button" onClick={applyDay} disabled={!singleDay}
                className="w-full gradient-bg text-white text-sm font-semibold py-2.5 rounded-xl hover:opacity-90 disabled:opacity-40 transition-opacity">
                Show this day
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

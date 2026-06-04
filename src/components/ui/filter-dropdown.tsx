'use client'

import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Search, Clock, TrendingUp, X } from 'lucide-react'
import { readSortData, trackUsage, type SortEntry } from '@/lib/hooks/use-smart-sort'

export interface FilterOption { value: string; label: string }

interface Props {
  options: FilterOption[]
  value: string
  onChange: (value: string) => void
  placeholder: string
  /** smart-sort key — same key used with Combobox sortKey (e.g. "clients", "services") */
  sortKey?: string
  className?: string
  /** max width of the trigger label before truncating */
  maxLabelWidth?: string
  /** Smaller trigger height/padding for compact toolbars */
  compact?: boolean
}

export function FilterDropdown({
  options, value, onChange, placeholder, sortKey, className = '', maxLabelWidth = 'max-w-[140px]', compact = false,
}: Props) {
  const [open,     setOpen]     = useState(false)
  const [search,   setSearch]   = useState('')
  const [sortData, setSortData] = useState<Record<string, SortEntry>>({})
  const [panelPos, setPanelPos] = useState<{ top: number; left: number; openUp: boolean } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const panelRef     = useRef<HTMLDivElement>(null)
  const searchRef    = useRef<HTMLInputElement>(null)

  // Load smart-sort data from localStorage on mount
  useEffect(() => {
    if (sortKey) setSortData(readSortData(sortKey))
  }, [sortKey])

  // Close on outside click — robust check via data attribute on portaled panel
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Element | null
      if (!target) return
      if (containerRef.current && containerRef.current.contains(target as Node)) return
      if (typeof target.closest === 'function' && target.closest('[data-filter-dropdown-panel="true"]')) return
      setOpen(false); setSearch('')
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Compute portal position — auto-flip right when overflowing
  const recomputePos = useCallback(() => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const PANEL_WIDTH = 256 // w-64
    const PANEL_MAX_H = 320
    const spaceRight  = window.innerWidth - rect.left
    const spaceBelow  = window.innerHeight - rect.bottom
    const spaceAbove  = rect.top
    const openUp      = spaceBelow < PANEL_MAX_H && spaceAbove > spaceBelow
    // If panel would overflow right edge, anchor to trigger's right edge instead
    const left = spaceRight < PANEL_WIDTH ? Math.max(8, rect.right - PANEL_WIDTH) : rect.left
    setPanelPos({
      top: openUp ? rect.top - 6 : rect.bottom + 6,
      left,
      openUp,
    })
  }, [])

  useLayoutEffect(() => {
    if (!open) { setPanelPos(null); return }
    recomputePos()
    const handler = () => recomputePos()
    window.addEventListener('scroll', handler, true)
    window.addEventListener('resize', handler)
    return () => {
      window.removeEventListener('scroll', handler, true)
      window.removeEventListener('resize', handler)
    }
  }, [open, recomputePos])

  // Auto-focus search on open
  useEffect(() => {
    if (open) requestAnimationFrame(() => searchRef.current?.focus())
  }, [open])

  const selectedOption = options.find(o => o.value === value)

  // Smart-sorted + filtered list
  const { recent, frequent, rest } = useMemo(() => {
    const q = search.toLowerCase()
    const pool = q
      ? options.filter(o => o.label.toLowerCase().includes(q))
      : options

    if (!sortKey || q) {
      // While searching or no sortKey: plain alphabetical
      return { recent: [] as FilterOption[], frequent: [] as FilterOption[], rest: pool }
    }

    const RECENT_MS = 30 * 24 * 60 * 60 * 1000
    const now = Date.now()
    const rec: FilterOption[]  = []
    const freq: FilterOption[] = []
    const oth: FilterOption[]  = []

    for (const o of pool) {
      const e = sortData[o.value]
      if (!e) { oth.push(o); continue }
      const age = now - new Date(e.lastUsed).getTime()
      if (age <= RECENT_MS) rec.push(o)
      else                  freq.push(o)
    }

    rec.sort((a, b) => (sortData[b.value]?.lastUsed || '').localeCompare(sortData[a.value]?.lastUsed || ''))
    freq.sort((a, b) => (sortData[b.value]?.count || 0) - (sortData[a.value]?.count || 0) || a.label.localeCompare(b.label))
    oth.sort((a, b) => a.label.localeCompare(b.label))

    return { recent: rec, frequent: freq, rest: oth }
  }, [options, search, sortKey, sortData])

  function select(v: string) {
    if (sortKey && v) {
      trackUsage(sortKey, v)
      setSortData(readSortData(sortKey))
    }
    onChange(v)
    setOpen(false); setSearch('')
  }

  const isActive = !!value

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {/* Trigger — matches Combobox / AppSelect style */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1.5 ${compact ? 'h-[30px] px-2 text-xs' : 'h-[34px] px-3 text-sm'} rounded-xl font-medium transition-all border
          ${isActive
            ? 'bg-violet-500/15 border-violet-500/40 text-violet-300'
            : 'bg-secondary border-foreground/15 text-muted-foreground hover:text-foreground hover:border-foreground/20'
          }
          ${open ? 'border-violet-500/50 ring-1 ring-violet-500/20' : ''}`}
      >
        <span className={`truncate ${maxLabelWidth}`}>{selectedOption?.label || placeholder}</span>
        {isActive ? (
          <span
            role="button"
            tabIndex={0}
            onClick={e => { e.stopPropagation(); onChange('') }}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onChange('') } }}
            className="shrink-0 opacity-60 hover:opacity-100 transition-opacity cursor-pointer"
            aria-label="Clear filter"
          >
            <X className="w-3 h-3" />
          </span>
        ) : (
          <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
        )}
      </button>

      {/* Dropdown panel — portaled to body to escape parent overflow clipping & viewport edges */}
      {open && panelPos && typeof document !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          data-filter-dropdown-panel="true"
          onMouseDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: panelPos.openUp ? undefined : panelPos.top,
            bottom: panelPos.openUp ? window.innerHeight - panelPos.top : undefined,
            left: panelPos.left,
            width: 256,
            zIndex: 1000,
          }}
          className="bg-secondary border border-foreground/15 rounded-xl shadow-2xl shadow-black/50 overflow-hidden
          animate-in fade-in slide-in-from-top-1 duration-100">

          {/* Search bar */}
          <div className="p-2 border-b border-foreground/[0.06]">
            <div className="flex items-center gap-2 bg-foreground/[0.04] rounded-lg px-3 py-1.5 border border-foreground/[0.06]">
              <Search className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
              <input ref={searchRef} value={search} onChange={e => setSearch(e.target.value)}
                className="bg-transparent text-sm outline-none flex-1 placeholder:text-muted-foreground/50"
                placeholder="Search…" />
              {search && (
                <button type="button" onClick={() => setSearch('')} className="text-muted-foreground/50 hover:text-foreground">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          <div className="max-h-64 overflow-y-auto py-1 overscroll-contain">
            {/* All / clear option */}
            {!search && (
              <OptionRow opt={{ value: '', label: placeholder }} selected={!value} onSelect={() => select('')} />
            )}

            {/* Recently used */}
            {recent.length > 0 && (
              <>
                <SectionLabel icon={<Clock size={9} />} label="Recently Used" />
                {recent.map(o => <OptionRow key={o.value} opt={o} selected={value === o.value} onSelect={select} />)}
              </>
            )}

            {/* Frequently used */}
            {frequent.length > 0 && (
              <>
                <SectionLabel icon={<TrendingUp size={9} />} label="Frequently Used" />
                {frequent.map(o => <OptionRow key={o.value} opt={o} selected={value === o.value} onSelect={select} />)}
              </>
            )}

            {/* All others / search results */}
            {rest.length > 0 && (
              <>
                {(recent.length > 0 || frequent.length > 0) && !search && (
                  <SectionLabel icon={null} label="All" />
                )}
                {rest.map(o => <OptionRow key={o.value} opt={o} selected={value === o.value} onSelect={select} />)}
              </>
            )}

            {recent.length === 0 && frequent.length === 0 && rest.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-6 opacity-60">No results for "{search}"</p>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

function SectionLabel({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-1.5 px-3 pt-2 pb-1">
      <span className="text-muted-foreground/40">{icon}</span>
      <span className="text-[9px] font-semibold text-muted-foreground/40 uppercase tracking-wider">{label}</span>
      <div className="flex-1 h-px bg-foreground/[0.04]" />
    </div>
  )
}

function OptionRow({ opt, selected, onSelect }: { opt: FilterOption; selected: boolean; onSelect: (v: string) => void }) {
  return (
    <button type="button" onClick={() => onSelect(opt.value)}
      className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors
        ${selected ? 'bg-violet-500/15 text-violet-300' : 'text-foreground hover:bg-foreground/[0.06]'}`}
    >
      <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-all
        ${selected ? 'border-violet-500 bg-violet-500' : 'border-foreground/20'}`}>
        {selected && <Check className="w-2.5 h-2.5 text-white" strokeWidth={3} />}
      </span>
      <span className="truncate">{opt.label}</span>
    </button>
  )
}

'use client'

import { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { Search, X, ChevronDown, Clock, TrendingUp, Plus } from 'lucide-react'
import { readSortData, trackUsage, smartSort, type SortBadge } from '@/lib/hooks/use-smart-sort'

export interface ComboOption {
  id: string
  label: string
  sub?: string
  /** Optional section header — consecutive options sharing a group render
   *  under one divider, pinned to the TOP in the caller's order.
   *
   *  Grouping is per-option, not all-or-nothing: options WITHOUT a group fall
   *  through to the normal smart-sort below the pinned sections, keeping their
   *  Recently/Frequently Used dividers and badges. That is what lets a caller
   *  pin, say, a client's committed services first without giving up usage
   *  ordering for everything else. (Search still filters flat.) */
  group?: string
}

interface Props {
  options:      ComboOption[]
  value:        string
  onChange:     (id: string) => void
  placeholder?: string
  required?:    boolean
  className?:   string
  /** localStorage key for smart-sort (e.g. "clients", "services", "employees") */
  sortKey?:     string
  disabled?:    boolean
  /** When set, a sticky "+ Add new" button shows at the bottom of the panel.
   *  Receives the current search text so the create form can prefill the name. */
  onAddNew?:    (query: string) => void
  /** Label for the add-new button, e.g. "Add new client". */
  addNewLabel?: string
}

// ─── Badge chip ───────────────────────────────────────────────────────────────
function Badge({ badge }: { badge: SortBadge }) {
  if (!badge) return null
  if (badge === 'recent')
    return (
      <span className="inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-400 border border-violet-500/20 shrink-0 font-medium">
        <Clock size={7} />recent
      </span>
    )
  return (
    <span className="inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20 shrink-0 font-medium">
      <TrendingUp size={7} />used
    </span>
  )
}

// ─── Divider between sort sections ───────────────────────────────────────────
function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-foreground/[0.02]">
      <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/50">{label}</span>
      <div className="flex-1 h-px bg-border/30" />
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function Combobox({
  options, value, onChange, placeholder, className, sortKey, disabled, onAddNew, addNewLabel,
}: Props) {
  const [open,      setOpen]      = useState(false)
  const [query,     setQuery]     = useState('')
  const [sortData,  setSortData]  = useState<Record<string, { count: number; lastUsed: string }>>({})
  const [panelPos,  setPanelPos]  = useState<{ top: number; left: number; width: number; openUp: boolean } | null>(null)
  const ref       = useRef<HTMLDivElement>(null)
  const panelRef  = useRef<HTMLDivElement>(null)
  const inputRef  = useRef<HTMLInputElement>(null)

  // Load sort data from localStorage on first open (client-side only)
  useEffect(() => {
    if (sortKey) setSortData(readSortData(sortKey))
  }, [sortKey])

  // Click-outside to close — uses a data-attribute on the portaled panel
  // so we don't depend on ref timing (which can be flaky with portals + state updates)
  useEffect(() => {
    function handler(e: MouseEvent) {
      const target = e.target as Element | null
      if (!target) return
      // If click landed inside the trigger wrapper, keep open
      if (ref.current && ref.current.contains(target as Node)) return
      // If click landed inside ANY combobox panel (this or another instance), keep this one open
      // — we'll only close if it's truly outside
      if (typeof target.closest === 'function' && target.closest('[data-combobox-panel="true"]')) return
      setOpen(false); setQuery('')
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Compute portal panel position relative to the trigger
  const recomputePos = useCallback(() => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const PANEL_MAX_H = 320 // approx max-height of panel
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    const openUp = spaceBelow < PANEL_MAX_H && spaceAbove > spaceBelow
    setPanelPos({
      top: openUp ? rect.top - 6 : rect.bottom + 6,
      left: rect.left,
      width: rect.width,
      openUp,
    })
  }, [])

  // Position panel when opening, reposition on scroll/resize
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

  const selected = options.find(o => o.id === value)

  // When searching: plain filtered list (ignore sort order)
  // When not searching + sortKey: smart-sorted list with badges
  const grouped = options.some(o => o.group)

  const displayItems = (() => {
    if (query) {
      const q = query.toLowerCase()
      return options
        .filter(o => o.label.toLowerCase().includes(q) || o.sub?.toLowerCase().includes(q))
        .map(o => ({ ...o, _badge: undefined as SortBadge, _restStart: false }))
    }
    if (!sortKey) return options.map(o => ({ ...o, _badge: undefined as SortBadge, _restStart: false }))
    if (!grouped) return smartSort(options, sortData).map(o => ({ ...o, _restStart: false }))
    // Mixed list: pinned groups keep the caller's order at the top, everything
    // ungrouped falls through to smart-sort below them. A fully-grouped list
    // leaves `rest` empty, so callers that group every option are unaffected.
    const pinned = options.filter(o => o.group)
      .map(o => ({ ...o, _badge: undefined as SortBadge, _restStart: false }))
    const rest = smartSort(options.filter(o => !o.group), sortData)
      .map((o, i) => ({ ...o, _restStart: i === 0 && pinned.length > 0 }))
    return [...pinned, ...rest]
  })()

  // Section dividers (only when showing sorted, no active search)
  const showDividers = !!sortKey && !query
  const showGroups = grouped && !query

  function select(id: string) {
    if (sortKey && id) {
      trackUsage(sortKey, id)
      setSortData(readSortData(sortKey)) // refresh sort order immediately
    }
    onChange(id)
    setOpen(false)
    setQuery('')
  }

  // Render list rows with dividers between badge groups
  function renderRows() {
    if (displayItems.length === 0)
      return <p className="px-4 py-4 text-xs text-muted-foreground text-center">No results</p>

    const rows: React.ReactNode[] = []
    let lastBadge: SortBadge = 'placeholder' as any // force first divider
    let lastGroup: string | undefined

    displayItems.forEach((o, i) => {
      if (showGroups && o.group && o.group !== lastGroup) {
        rows.push(<Divider key={`g-${o.group}-${i}`} label={o.group} />)
        lastGroup = o.group
      }
      // First unpinned row when it carries no badge: the badge-transition
      // below can't see this boundary (undefined → undefined), so the rest of
      // the list would run straight on from the pinned section with no header.
      if (showDividers && o._restStart && !o._badge) {
        rows.push(<Divider key={`d-rest-${i}`} label="All" />)
        lastBadge = o._badge
      } else if (showDividers && o._badge !== lastBadge) {
        if (o._badge === 'recent')   rows.push(<Divider key={`d-recent-${i}`}   label="Recently Used" />)
        if (o._badge === 'frequent') rows.push(<Divider key={`d-frequent-${i}`} label="Frequently Used" />)
        if (!o._badge && (lastBadge === 'recent' || lastBadge === 'frequent'))
          rows.push(<Divider key={`d-all-${i}`} label="All" />)
        lastBadge = o._badge
      }

      rows.push(
        <button
          key={o.id || i}
          type="button"
          onClick={() => select(o.id)}
          className={`w-full text-left px-3 py-2.5 text-sm transition-colors flex items-center justify-between gap-2
            ${o.id === value
              ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
              : 'text-foreground hover:bg-foreground/[0.06]'
            }`}
        >
          <div className="min-w-0 flex-1">
            <span className="block break-words">{o.label}</span>
            {o.sub && <span className="text-[11px] text-muted-foreground truncate block">{o.sub}</span>}
          </div>
          <Badge badge={o._badge} />
        </button>
      )
    })
    return rows
  }

  return (
    <div ref={ref} className={`relative ${className ?? ''}`}>
      {/* Trigger button — matches AppSelect style */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => { setOpen(v => !v); setTimeout(() => inputRef.current?.focus(), 50) }}
        className={`w-full bg-secondary border border-foreground/15 rounded-xl px-3 py-2 text-sm text-left flex items-center justify-between gap-2
          focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20
          hover:border-foreground/20 transition-colors
          ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
          ${open ? 'border-violet-500/50 ring-1 ring-violet-500/20' : ''}`}
      >
        <span className={`truncate flex-1 ${selected ? 'text-foreground' : 'text-muted-foreground'}`}>
          {selected ? selected.label : (placeholder ?? 'Select…')}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {value && !disabled && (
            <span
              onClick={e => { e.stopPropagation(); select('') }}
              className="text-muted-foreground hover:text-foreground p-0.5 rounded transition-colors"
              title="Clear"
            >
              <X className="w-3 h-3" />
            </span>
          )}
          <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {/* Dropdown panel — portaled to body so it escapes parent overflow clipping */}
      {open && panelPos && typeof document !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          data-combobox-panel="true"
          // CRITICAL: React events bubble through the React tree (not the DOM tree)
          // even when portaled — so clicks here would bubble up to a parent ModalOverlay's
          // onMouseDown and trigger its outside-click close. Stop propagation here.
          onMouseDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: panelPos.openUp ? undefined : panelPos.top,
            bottom: panelPos.openUp ? window.innerHeight - panelPos.top : undefined,
            left: panelPos.left,
            width: panelPos.width,
            minWidth: 220,
            zIndex: 1000,
          }}
          className="bg-secondary border border-foreground/15 rounded-xl shadow-2xl shadow-black/50 overflow-hidden
            animate-in fade-in slide-in-from-top-1 duration-100"
        >
          {/* Search bar */}
          <div className="p-2 border-b border-foreground/[0.06]">
            <div className="flex items-center gap-2 bg-foreground/[0.04] rounded-lg px-3 py-1.5 border border-foreground/[0.06]">
              <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <input
                ref={inputRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search…"
                className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-muted-foreground/60"
              />
              {query && (
                <button type="button" onClick={() => setQuery('')} className="text-muted-foreground hover:text-foreground transition-colors">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          {/* Options list */}
          <div className="max-h-60 overflow-y-auto overscroll-contain">
            {renderRows()}
          </div>

          {/* Sticky "Add new" footer */}
          {onAddNew && (
            <button
              type="button"
              onClick={() => { const q = query; setOpen(false); setQuery(''); onAddNew(q) }}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-sm font-medium text-violet-400
                border-t border-foreground/[0.08] bg-violet-500/[0.04] hover:bg-violet-500/10 transition-colors"
            >
              <span className="inline-flex w-5 h-5 items-center justify-center rounded-full bg-violet-500/15">
                <Plus className="w-3.5 h-3.5" />
              </span>
              {query.trim()
                ? <span className="truncate">{addNewLabel || 'Add'} &ldquo;{query.trim()}&rdquo;</span>
                : (addNewLabel || 'Add new')}
            </button>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}

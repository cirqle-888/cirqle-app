'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, CornerDownLeft, ChevronDown } from 'lucide-react'

export type FacetOp = 'contains' | 'is' | '=' | '!=' | '>' | '<' | '>=' | '<='
/** A committed search facet — "this field <op> this text". */
export interface SearchFacet { field: string; op: FacetOp; text: string }
/** A searchable field offered in the dropdown (besides the generic row). */
export interface SearchField { key: string; label: string; type?: 'text' | 'number' }

const TEXT_OPS: FacetOp[] = ['contains', 'is']
const NUM_OPS: FacetOp[] = ['=', '!=', '>', '<', '>=', '<=']

/** Compact operator label shown on the pill's operator chip. */
export function opLabel(op: FacetOp): string {
  switch (op) {
    case 'contains': return 'contains'
    case 'is':       return 'is'
    case '!=':       return '≠'
    case '>=':       return '≥'
    case '<=':       return '≤'
    default:         return op   // = > <
  }
}

const isNumeric = (s: string) => s.trim() !== '' && Number.isFinite(Number(s.trim()))
const defaultOp = (type?: string): FacetOp => (type === 'number' ? '=' : 'contains')
const opsForType = (type?: string): FacetOp[] => (type === 'number' ? NUM_OPS : TEXT_OPS)
const pluralize = (n: number, noun: string) =>
  n === 1 ? noun : noun.endsWith('y') ? noun.slice(0, -1) + 'ies' : noun + 's'

/**
 * Odoo-style tokenized search bar with field-scoped facets + operators.
 *
 * The dropdown stays compact: ONE row per field using a default operator
 * (text → contains, number → =). After a facet is committed, its operator is
 * changeable inline via a chip on the pill — so all operators stay available
 * without cluttering the suggestion list.
 *
 * Combination is the consumer's job; Cirqle convention:
 *   generic 'any' → AND (narrow) · same field → OR · across fields → AND.
 *
 * Controlled: parent owns committed `facets` + live `draft` (treat the trimmed
 * draft as a generic contains facet for live filtering).
 */
export function TokenizedSearch({
  facets, onFacetsChange, draft, onDraftChange,
  placeholder = 'Search…', className = '', fields = [],
  resultCount, resultNoun = 'result',
}: {
  facets: SearchFacet[]
  onFacetsChange: (facets: SearchFacet[]) => void
  draft: string
  onDraftChange: (draft: string) => void
  placeholder?: string
  className?: string
  fields?: SearchField[]
  /** Live count of records matching the current draft+facets — shows a
   *  "N matching <noun>s" header in the dropdown so the user knows at a glance
   *  whether the search hits any data. Omit to hide the header. */
  resultCount?: number
  resultNoun?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [opMenu, setOpMenu] = useState<number | null>(null)   // which pill's op menu is open

  const q = draft.trim()
  const numeric = isNumeric(q)

  // One row per field (generic first), each with its default operator.
  const rows = useMemo(() => {
    if (!q) return [] as { field: string; op: FacetOp; label: string; type?: string }[]
    const out: { field: string; op: FacetOp; label: string; type?: string }[] = [{ field: 'any', op: 'contains', label: '' }]
    for (const f of fields) {
      if (f.type === 'number' && !numeric) continue        // numeric fields need a number
      out.push({ field: f.key, op: defaultOp(f.type), label: f.label, type: f.type })
    }
    return out
  }, [q, fields, numeric])

  const showDropdown = open && rows.length > 0

  useEffect(() => { setActiveIndex(0) }, [draft])

  useEffect(() => {
    if (!open && opMenu === null) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) { setOpen(false); setOpMenu(null) }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, opMenu])

  const fieldOf = (key: string) => fields.find(f => f.key === key)
  const fieldLabel = (key: string) => fieldOf(key)?.label || ''

  function commit(field: string, op: FacetOp) {
    const text = draft.trim()
    if (!text) return
    if (!facets.some(f => f.field === field && f.op === op && f.text.toLowerCase() === text.toLowerCase())) {
      onFacetsChange([...facets, { field, op, text }])
    }
    onDraftChange('')
  }

  function changeOp(index: number, op: FacetOp) {
    onFacetsChange(facets.map((f, i) => i === index ? { ...f, op } : f))
    setOpMenu(null)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      const r = showDropdown ? rows[activeIndex] : null
      commit(r?.field ?? 'any', r?.op ?? 'contains')
    } else if (e.key === ',') {
      e.preventDefault(); commit('any', 'contains')
    } else if (e.key === 'ArrowDown' && showDropdown) {
      e.preventDefault(); setActiveIndex(i => Math.min(rows.length - 1, i + 1))
    } else if (e.key === 'ArrowUp' && showDropdown) {
      e.preventDefault(); setActiveIndex(i => Math.max(0, i - 1))
    } else if (e.key === 'Escape') {
      setOpen(false)
    } else if (e.key === 'Backspace' && draft === '' && facets.length > 0) {
      e.preventDefault(); onFacetsChange(facets.slice(0, -1))
    }
  }

  const hasContent = facets.length > 0 || draft.length > 0

  return (
    <div ref={containerRef} className={`relative w-full sm:w-auto ${className}`}>
      <div
        onClick={() => inputRef.current?.focus()}
        className="flex items-center flex-wrap gap-1.5 bg-secondary border border-foreground/15 rounded-xl min-h-[44px] sm:min-h-[36px] px-3 py-1.5 cursor-text focus-within:border-violet-500/50 focus-within:ring-1 focus-within:ring-violet-500/20 transition-all w-full"
      >
        <Search size={14} className="text-muted-foreground shrink-0" />

        {facets.map((f, i) => {
          const fieldDef = fieldOf(f.field)
          const ops = opsForType(fieldDef?.type)
          const canChangeOp = f.field !== 'any' && ops.length > 1
          return (
            <span key={f.field + f.op + f.text + i}
              className="relative inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md text-xs bg-violet-500/15 text-violet-700 dark:text-violet-300 border border-violet-500/30">
              {f.field !== 'any' && <span className="text-violet-700/70 dark:text-violet-400/70 font-medium">{fieldLabel(f.field)}</span>}
              {canChangeOp && (
                <button type="button"
                  onClick={e => { e.stopPropagation(); setOpMenu(opMenu === i ? null : i) }}
                  className="inline-flex items-center gap-0.5 px-1 rounded bg-violet-500/20 hover:bg-violet-500/35 text-violet-700 dark:text-violet-200 transition-colors"
                  title="Change operator">
                  {opLabel(f.op)}<ChevronDown className="w-2.5 h-2.5" />
                </button>
              )}
              <span className="max-w-[160px] truncate">{f.text}</span>
              <button type="button"
                onClick={e => { e.stopPropagation(); onFacetsChange(facets.filter((_, j) => j !== i)) }}
                aria-label="Remove filter" className="p-0.5 rounded hover:bg-violet-500/25 transition-colors">
                <X className="w-3 h-3" />
              </button>

              {opMenu === i && (
                <div onMouseDown={e => e.stopPropagation()}
                  className="absolute z-50 top-full left-0 mt-1 bg-card/55 backdrop-blur-xl backdrop-saturate-150 border border-foreground/10 ring-1 ring-black/5 rounded-lg shadow-xl shadow-black/25 py-1 min-w-[112px]">
                  {ops.map(op => (
                    <button key={op} type="button" onClick={() => changeOp(i, op)}
                      className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${f.op === op ? 'bg-violet-500/20 text-violet-700 dark:text-violet-200' : 'text-foreground hover:bg-foreground/10'}`}>
                      {opLabel(op)}
                    </button>
                  ))}
                </div>
              )}
            </span>
          )
        })}

        <input
          ref={inputRef}
          value={draft}
          onChange={e => { onDraftChange(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={facets.length === 0 ? placeholder : 'Add another filter…'}
          className="flex-1 min-w-[60px] bg-transparent text-sm focus:outline-none placeholder:text-muted-foreground/60 py-0.5"
        />

        {hasContent && (
          <button type="button"
            onClick={e => { e.stopPropagation(); onFacetsChange([]); onDraftChange('') }}
            aria-label="Clear search" className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground">
            <X size={13} />
          </button>
        )}
      </div>

      {/* "Search <Field> for: <text>" dropdown — one row per field */}
      {showDropdown && (
        <div
          onMouseDown={e => e.preventDefault() /* keep input focus */}
          className="absolute z-50 left-0 right-0 mt-1.5 bg-card/25 backdrop-blur-xl backdrop-saturate-150 border border-foreground/10 ring-1 ring-black/5 rounded-xl shadow-2xl shadow-black/25 overflow-hidden py-1 max-h-[22rem] overflow-y-auto"
        >
          {typeof resultCount === 'number' && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 mb-1 border-b border-foreground/10 text-xs font-semibold">
              {resultCount > 0
                ? <span className="text-violet-600 dark:text-violet-300">{resultCount} matching {pluralize(resultCount, resultNoun)}</span>
                : <span className="text-muted-foreground">No matching {pluralize(0, resultNoun)}</span>}
            </div>
          )}
          {rows.map((r, idx) => {
            const active = activeIndex === idx
            return (
              <button key={r.field} type="button" onClick={() => commit(r.field, r.op)}
                onMouseEnter={() => setActiveIndex(idx)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${active ? 'bg-violet-500/20 text-violet-700 dark:text-violet-100 font-medium' : 'text-foreground hover:bg-foreground/10'}`}>
                <Search size={13} className={`shrink-0 ${active ? 'text-violet-600 dark:text-violet-200' : 'text-muted-foreground'}`} />
                <span className="flex-1 truncate">
                  {r.field === 'any'
                    ? <>Search for: <span className="font-semibold italic">{q}</span></>
                    : r.type === 'number'
                      ? <>Search <span className="font-semibold">{r.label}</span> = <span className="font-semibold italic">{q}</span></>
                      : <>Search <span className="font-semibold">{r.label}</span> for: <span className="font-semibold italic">{q}</span></>}
                </span>
                {active && <CornerDownLeft size={12} className="text-violet-500/70 dark:text-muted-foreground/60 shrink-0" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

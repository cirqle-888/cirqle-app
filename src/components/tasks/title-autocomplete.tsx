'use client'

import { useEffect, useRef, useState } from 'react'
import { Clock, Sparkles, Check } from 'lucide-react'
import { getTitleSuggestions } from '@/app/(dashboard)/dashboard/tasks/quick-create-actions'

interface Props {
  value: string
  onChange: (v: string) => void
  className?: string
  placeholder?: string
  required?: boolean
  /** Past titles already loaded on the page — used for instant local matches
   *  before the server call returns. */
  localTitles?: string[]
}

// ── Levenshtein distance (small, bounded) for "did you mean" ─────────────────
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length, n = b.length
  if (!m) return n
  if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  let curr = new Array(n + 1)
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

/** Tidy a title: trim, collapse inner whitespace, fix spacing around dashes. */
function cleanTitle(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/\s*([—–-])\s*/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Title-case words but keep ALLCAPS tokens and small joiners lowercase. */
function toTitleCase(s: string): string {
  const small = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'to', 'in', 'on', 'by', 'with'])
  const words = s.split(' ')
  return words
    .map((w, i) => {
      if (!w) return w
      if (w.length > 1 && w === w.toUpperCase()) return w // keep acronyms (B.N., CQID)
      const lower = w.toLowerCase()
      if (i !== 0 && small.has(lower)) return lower
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join(' ')
}

export function TitleAutocomplete({ value, onChange, className, placeholder, required, localTitles = [] }: Props) {
  const [open, setOpen] = useState(false)
  const [serverSugs, setServerSugs] = useState<{ title: string; count: number }[]>([])
  const [focused, setFocused] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  // Debounced server fetch for suggestions.
  useEffect(() => {
    if (!focused) return
    const term = value.trim()
    const handle = setTimeout(async () => {
      const res = await getTitleSuggestions(term)
      if (res.ok && res.data) setServerSugs(res.data.suggestions)
    }, 220)
    return () => clearTimeout(handle)
  }, [value, focused])

  // Merge local + server suggestions, filtered by the query, deduped.
  const term = value.trim().toLowerCase()
  const merged = (() => {
    const map = new Map<string, number>()
    for (const t of localTitles) {
      const k = t.trim()
      if (k) map.set(k.toLowerCase(), (map.get(k.toLowerCase()) || 0) + 1)
    }
    const labelByKey = new Map<string, string>()
    localTitles.forEach(t => { const k = t.trim().toLowerCase(); if (k && !labelByKey.has(k)) labelByKey.set(k, t.trim()) })
    serverSugs.forEach(s => { const k = s.title.toLowerCase(); labelByKey.set(k, s.title); map.set(k, Math.max(map.get(k) || 0, s.count)) })
    return Array.from(map.entries())
      .map(([k, count]) => ({ title: labelByKey.get(k) || k, count }))
      .filter(s => !term || (s.title.toLowerCase().includes(term) && s.title.toLowerCase() !== term))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6)
  })()

  // Corrections.
  const cleaned = cleanTitle(value)
  const titleCased = toTitleCase(cleaned)
  const showCleanup = cleaned !== value && cleaned.length > 0
  const showCase = !showCleanup && titleCased !== value && titleCased.length > 0

  // "Did you mean" — closest past title within a small edit distance, not exact.
  const didYouMean = (() => {
    if (term.length < 3) return null
    const pool = merged.length ? merged : serverSugs.map(s => ({ title: s.title, count: s.count }))
    let best: { title: string; d: number } | null = null
    for (const s of pool) {
      const cand = s.title.toLowerCase()
      if (cand === term) return null // exact exists — nothing to suggest
      const d = levenshtein(term, cand)
      const tol = Math.max(1, Math.floor(cand.length * 0.25))
      if (d <= tol && (!best || d < best.d)) best = { title: s.title, d }
    }
    return best?.title ?? null
  })()

  // Close on outside click.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const hasPanel = open && focused && (merged.length > 0 || showCleanup || showCase || !!didYouMean)

  return (
    <div ref={boxRef} className="relative">
      <input
        value={value}
        onChange={e => { onChange(e.target.value); setOpen(true) }}
        onFocus={() => { setFocused(true); setOpen(true) }}
        onBlur={() => {
          // Auto-tidy whitespace on blur (non-destructive: only spacing).
          const c = cleanTitle(value)
          if (c !== value) onChange(c)
        }}
        required={required}
        className={className}
        placeholder={placeholder}
        autoComplete="off"
      />

      {hasPanel && (
        <div className="absolute z-50 left-0 right-0 mt-1 bg-secondary border border-foreground/15 rounded-xl shadow-2xl shadow-black/50 overflow-hidden">
          {/* Corrections */}
          {(showCleanup || showCase || didYouMean) && (
            <div className="p-1.5 border-b border-foreground/[0.06] space-y-1">
              {showCleanup && (
                <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => { onChange(cleaned); setOpen(false) }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left hover:bg-foreground/[0.06] transition-colors">
                  <Sparkles className="w-3.5 h-3.5 text-violet-400 shrink-0" />
                  <span className="text-xs text-muted-foreground">Clean up spacing →</span>
                  <span className="text-xs font-medium text-foreground truncate">{cleaned}</span>
                </button>
              )}
              {showCase && (
                <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => { onChange(titleCased); setOpen(false) }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left hover:bg-foreground/[0.06] transition-colors">
                  <Sparkles className="w-3.5 h-3.5 text-violet-400 shrink-0" />
                  <span className="text-xs text-muted-foreground">Title case →</span>
                  <span className="text-xs font-medium text-foreground truncate">{titleCased}</span>
                </button>
              )}
              {didYouMean && (
                <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => { onChange(didYouMean); setOpen(false) }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left hover:bg-amber-500/10 transition-colors">
                  <span className="text-xs text-amber-400 shrink-0">Did you mean</span>
                  <span className="text-xs font-medium text-foreground truncate">&ldquo;{didYouMean}&rdquo;?</span>
                </button>
              )}
            </div>
          )}

          {/* Past-title suggestions */}
          {merged.length > 0 && (
            <div className="max-h-52 overflow-y-auto py-1">
              <div className="px-3 py-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/50">Past titles</div>
              {merged.map(s => (
                <button key={s.title} type="button" onMouseDown={e => e.preventDefault()} onClick={() => { onChange(s.title); setOpen(false) }}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-foreground/[0.06] transition-colors">
                  <span className="flex items-center gap-2 min-w-0">
                    <Clock className="w-3 h-3 text-muted-foreground/60 shrink-0" />
                    <span className="text-sm truncate">{s.title}</span>
                  </span>
                  {value.trim().toLowerCase() === s.title.toLowerCase()
                    ? <Check className="w-3.5 h-3.5 text-green-400 shrink-0" />
                    : s.count > 1 && <span className="text-[10px] text-muted-foreground/60 shrink-0">{s.count}×</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

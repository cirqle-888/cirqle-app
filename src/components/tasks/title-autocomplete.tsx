'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { cleanTitle, normalizeTaskTitle } from '@/lib/utils/title-case'
import { Clock, Sparkles, Check, Wand2 } from 'lucide-react'
import { getTitleSuggestions, getRecentTitlePool } from '@/app/(dashboard)/dashboard/tasks/quick-create-actions'

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

/** Normalize for fuzzy comparison: lowercase, strip everything but a–z 0–9.
 *  This makes spacing/punctuation differences free ("weec end sle" ≈ "weekendsale"). */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}


export function TitleAutocomplete({ value, onChange, className, placeholder, required, localTitles = [] }: Props) {
  const [open, setOpen] = useState(false)
  const [serverSugs, setServerSugs] = useState<{ title: string; count: number }[]>([])
  const [pool, setPool] = useState<string[]>([])
  const [focused, setFocused] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const poolFetched = useRef(false)

  // Fetch the broad title pool once (on first focus) for fuzzy "did you mean".
  async function ensurePool() {
    if (poolFetched.current) return
    poolFetched.current = true
    const res = await getRecentTitlePool()
    if (res.ok && res.data) setPool(res.data.titles)
  }

  // Debounced server fetch for substring suggestions.
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
  //
  // Title case is no longer offered here — it is applied unconditionally on
  // blur and again on insert, so a button for it would only ever be a no-op.
  // The remaining suggestions are the ones the user must actually choose:
  // a spacing tidy they can see, and a fuzzy match against past titles.
  const cleaned = cleanTitle(value)
  const showCleanup = cleaned !== value && cleaned.length > 0

  // "Did you mean" — closest past title by normalized edit distance (spacing and
  // punctuation ignored), matched against the full history pool. Catches typos
  // like "weec end sle" → "Weekend Sale".
  const didYouMean = useMemo(() => {
    const raw = value.trim()
    if (raw.length < 4) return null
    const nt = norm(raw)
    if (nt.length < 4) return null

    const candidates = pool.length ? pool : localTitles
    let best: { title: string; d: number } | null = null
    for (const cand of candidates) {
      const nc = norm(cand)
      if (!nc) continue
      if (nc === nt) return null // an exact (normalized) match exists — nothing to suggest
      if (Math.abs(nc.length - nt.length) > 4) continue // length gate keeps it fast
      const d = levenshtein(nt, nc)
      const tol = Math.max(2, Math.floor(nc.length * 0.34))
      if (d <= tol && (!best || d < best.d)) best = { title: cand, d }
    }
    if (!best) return null
    // Skip if the only difference is letter case (the Title-case row covers that).
    const bestTitle: string = best.title
    if (bestTitle.toLowerCase() === raw.toLowerCase()) return null
    return bestTitle
  }, [value, pool, localTitles])

  // Close on outside click.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const hasPanel = open && focused && (merged.length > 0 || showCleanup || !!didYouMean)

  return (
    <div ref={boxRef} className="relative">
      <input
        value={value}
        onChange={e => { onChange(e.target.value); setOpen(true) }}
        onFocus={() => { setFocused(true); setOpen(true); ensurePool() }}
        onBlur={() => {
          // Normalise on blur so the field shows exactly what will be saved.
          // Task creation applies the same function again on insert — this is
          // the preview of that, not the enforcement of it.
          const c = normalizeTaskTitle(value)
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
          {(showCleanup || didYouMean) && (
            <div className="p-1.5 border-b border-foreground/[0.06] space-y-1">
              {didYouMean && (
                <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => { onChange(didYouMean); setOpen(false) }}
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left bg-amber-500/[0.08] hover:bg-amber-500/15 border border-amber-500/20 transition-colors">
                  <Wand2 className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span className="text-xs text-amber-400/90 shrink-0">Did you mean</span>
                  <span className="text-xs font-semibold text-foreground truncate">{didYouMean}</span>
                  <span className="text-xs text-amber-400/70 shrink-0">?</span>
                </button>
              )}
              {showCleanup && (
                <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => { onChange(cleaned); setOpen(false) }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left hover:bg-foreground/[0.06] transition-colors">
                  <Sparkles className="w-3.5 h-3.5 text-violet-400 shrink-0" />
                  <span className="text-xs text-muted-foreground">Clean up spacing →</span>
                  <span className="text-xs font-medium text-foreground truncate">{cleaned}</span>
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

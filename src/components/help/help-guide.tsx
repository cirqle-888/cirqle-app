'use client'

/**
 * Help guide — "How do I…?" answered by showing, not telling.
 *
 * Two parts, both mounted once in the dashboard layout so a guide survives
 * moving between pages:
 *
 *   · the PANEL: a searchable list of questions, limited to what this
 *     employee has access to (same permission keys the app already uses);
 *   · the RUNNER: one small card with the current step, and a ring drawn
 *     around the real control to press. Pressing it moves to the next step.
 *
 * No AI and no network: the guides are plain data in `lib/help/guides.ts`.
 * Open it from anywhere with
 *   window.dispatchEvent(new CustomEvent('cirqle:openHelp'))
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { ArrowRight, ChevronLeft, ChevronRight, LifeBuoy, MessageCircle, Search, X } from 'lucide-react'
import { usePermissions } from '@/contexts/permission-context'
import { HELP_GUIDES, searchGuides, type HelpGuide, type HelpStep, type HelpTarget } from '@/lib/help/guides'

const CLICKABLE = 'button, a, [role="menuitem"], [role="button"], summary, label, select, input'

function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect()
  if (r.width < 2 || r.height < 2) return false
  const cs = getComputedStyle(el)
  return cs.visibility !== 'hidden' && cs.display !== 'none'
}

function findOne(t: HelpTarget): HTMLElement | null {
  if (t.sel) {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(t.sel))) {
      if (isVisible(el)) return el
    }
    return null
  }
  if (t.text) {
    const want = t.text.toLowerCase()
    let best: HTMLElement | null = null
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(CLICKABLE))) {
      if (el.closest('[data-help-ui]') || !isVisible(el)) continue
      const label = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`.toLowerCase()
      if (!label.includes(want)) continue
      // The tightest match is the control itself, not a wrapper around it.
      if (!best || (el.textContent || '').length < (best.textContent || '').length) best = el
    }
    return best
  }
  return null
}

/** First target on screen. `primary` = it was the first one listed (the real control, not a fallback). */
function resolveTarget(step: HelpStep): { el: HTMLElement; primary: boolean } | null {
  if (!step.target) return null
  const list = Array.isArray(step.target) ? step.target : [step.target]
  for (let i = 0; i < list.length; i++) {
    const el = findOne(list[i])
    if (el) return { el, primary: i === 0 }
  }
  return null
}

function onPage(pathname: string, href?: string): boolean {
  return !href || pathname === href || pathname.startsWith(`${href}/`)
}

export function HelpGuide() {
  const { can, user } = usePermissions()
  const pathname = usePathname()
  const router = useRouter()

  const [panelOpen, setPanelOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<HelpGuide | null>(null)
  const [stepIdx, setStepIdx] = useState(0)
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null)

  // Guides this person may use — same permission keys as the features.
  const guides = useMemo(
    () => HELP_GUIDES.filter(g => g.perms.length === 0 || user.isAdmin || g.perms.some(p => can(p))),
    [can, user.isAdmin],
  )

  useEffect(() => {
    const open = () => { setQuery(''); setPanelOpen(true) }
    window.addEventListener('cirqle:openHelp', open)
    return () => window.removeEventListener('cirqle:openHelp', open)
  }, [])

  const step: HelpStep | null = active ? active.steps[stepIdx] ?? null : null
  const here = step ? onPage(pathname, step.href) : true

  const stop = useCallback(() => { setActive(null); setStepIdx(0); setRect(null) }, [])
  const next = useCallback(() => {
    setRect(null)
    setStepIdx(i => {
      if (!active) return i
      if (i + 1 >= active.steps.length) { setActive(null); return 0 }
      return i + 1
    })
  }, [active])
  const back = useCallback(() => { setRect(null); setStepIdx(i => Math.max(0, i - 1)) }, [])

  function start(g: HelpGuide) {
    setPanelOpen(false)
    setActive(g)
    setStepIdx(0)
    setRect(null)
    const first = g.steps[0]
    if (first?.href && !onPage(pathname, first.href)) router.push(first.href)
  }

  // ── Track the target: ring position, and "done" detection ────────────────
  const targetRef = useRef<{ el: HTMLElement; primary: boolean } | null>(null)
  const scrolledFor = useRef<string>('')
  useEffect(() => {
    if (!step || !here) { targetRef.current = null; return }
    const key = `${active?.id}:${stepIdx}`
    const tick = () => {
      if (step.doneWhen) {
        const done = Array.from(document.querySelectorAll(step.doneWhen)).some(isVisible)
        if (done) { next(); return }
      }
      const found = resolveTarget(step)
      targetRef.current = found
      if (!found) { setRect(null); return }
      if (scrolledFor.current !== key) {
        scrolledFor.current = key
        found.el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
      const r = found.el.getBoundingClientRect()
      setRect(prev => (prev && Math.abs(prev.top - r.top) < 1 && Math.abs(prev.left - r.left) < 1 &&
        Math.abs(prev.width - r.width) < 1 && Math.abs(prev.height - r.height) < 1)
        ? prev : { top: r.top, left: r.left, width: r.width, height: r.height })
    }
    tick()
    const id = window.setInterval(tick, 200)
    return () => window.clearInterval(id)
  }, [step, here, active?.id, stepIdx, next])

  // Pressing the ringed control IS the step — move on without a second tap.
  useEffect(() => {
    if (!step || !here || step.manual || step.doneWhen) return
    const advanceIfTarget = (e: Event) => {
      const t = targetRef.current
      if (!t || !t.primary || !(e.target instanceof Node) || !t.el.contains(e.target)) return
      const isField = t.el instanceof HTMLSelectElement || t.el instanceof HTMLInputElement
      if (isField !== (e.type === 'change')) return
      // After the click has done its own work (open a menu, navigate).
      window.setTimeout(next, 150)
    }
    document.addEventListener('click', advanceIfTarget, true)
    document.addEventListener('change', advanceIfTarget, true)
    return () => {
      document.removeEventListener('click', advanceIfTarget, true)
      document.removeEventListener('change', advanceIfTarget, true)
    }
  }, [step, here, next])

  useEffect(() => {
    if (!panelOpen && !active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (panelOpen) setPanelOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panelOpen, active])

  // ── Panel content ────────────────────────────────────────────────────────
  const results = query.trim() ? searchGuides(guides, query) : null
  const groups = useMemo(() => {
    const onThisPage = guides.filter(g => g.steps[0]?.href && onPage(pathname, g.steps[0].href))
    const out: { label: string; items: HelpGuide[] }[] = []
    if (onThisPage.length) out.push({ label: 'On this page', items: onThisPage })
    const seen = new Set(onThisPage.map(g => g.id))
    for (const g of guides) {
      if (seen.has(g.id)) continue
      const grp = out.find(o => o.label === g.area)
      if (grp) grp.items.push(g); else out.push({ label: g.area, items: [g] })
    }
    return out
  }, [guides, pathname])

  // Card sits at the bottom, unless that is where the ringed control is.
  const cardOnTop = !!rect && typeof window !== 'undefined' && rect.top + rect.height > window.innerHeight - 230

  const guideRow = (g: HelpGuide) => (
    <button key={g.id} type="button" onClick={() => start(g)}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span className="min-w-0 flex-1">{g.title}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground">{g.steps.length} step{g.steps.length !== 1 ? 's' : ''}</span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  )

  return (
    <div data-help-ui>
      {/* ── Panel ── */}
      {panelOpen && (
        <div className="fixed inset-0 z-[390] flex items-end justify-center sm:items-center sm:p-4"
          onMouseDown={e => { if (e.target === e.currentTarget) setPanelOpen(false) }}>
          <div className="absolute inset-0 bg-black/50" />
          <div role="dialog" aria-label="Help"
            className="relative flex max-h-[85dvh] w-full flex-col rounded-t-2xl border border-border bg-card shadow-2xl sm:max-w-md sm:rounded-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold"><LifeBuoy className="h-4 w-4 text-primary" />How do I…?</h2>
              <button type="button" onClick={() => setPanelOpen(false)} aria-label="Close help"
                className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"><X className="h-4 w-4" /></button>
            </div>
            <div className="px-4 pt-3">
              <label className="flex items-center gap-2 rounded-lg border border-border bg-secondary px-3">
                <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                <input autoFocus value={query} onChange={e => setQuery(e.target.value)}
                  placeholder="Type what you want to do…"
                  className="min-h-10 w-full bg-transparent text-sm focus:outline-none" />
              </label>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {results ? (
                results.length > 0 ? results.map(guideRow) : (
                  <div className="px-3 py-6 text-center">
                    <p className="text-sm font-medium">No guide for that yet</p>
                    <p className="mt-1 text-xs text-muted-foreground">Try other words, or ask in chat.</p>
                    <button type="button"
                      onClick={() => { setPanelOpen(false); window.dispatchEvent(new CustomEvent('cirqle:toggleChat')) }}
                      className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-lg border border-border px-3 text-xs font-medium hover:bg-secondary">
                      <MessageCircle className="h-4 w-4" />Ask in chat
                    </button>
                  </div>
                )
              ) : groups.map(grp => (
                <div key={grp.label} className="mb-1">
                  <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{grp.label}</p>
                  {grp.items.map(guideRow)}
                </div>
              ))}
            </div>
            <p className="border-t border-border/60 px-4 py-2.5 text-[11px] text-muted-foreground">
              Pick one and the app shows you where to tap, step by step.
            </p>
          </div>
        </div>
      )}

      {/* ── Runner: ring + step card ── */}
      {active && step && (
        <>
          {here && rect && (
            <div aria-hidden className="pointer-events-none fixed z-[395] rounded-xl ring-4 ring-primary ring-offset-2 ring-offset-background transition-all duration-150"
              style={{ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 }}>
              <span className="absolute inset-0 animate-ping rounded-xl ring-2 ring-primary/60" />
            </div>
          )}
          <div role="status" aria-live="polite"
            className={`fixed left-1/2 z-[400] w-[min(26rem,calc(100vw-1.5rem))] -translate-x-1/2 rounded-2xl border border-primary/40 bg-card p-3.5 shadow-2xl ${
              cardOnTop ? 'top-3' : 'bottom-[calc(var(--bottom-nav-h,0px)+0.75rem)]'}`}>
            <div className="flex items-start justify-between gap-3">
              <p className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <span className="shrink-0 whitespace-nowrap text-primary">Step {stepIdx + 1} of {active.steps.length}</span>
                <span className="shrink-0">·</span><span className="truncate">{active.title}</span>
              </p>
              <button type="button" onClick={stop} aria-label="Stop guide"
                className="-mr-1 -mt-1 shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"><X className="h-4 w-4" /></button>
            </div>
            <p className="mt-1 text-sm font-medium leading-snug">{step.text}</p>
            <div className="mt-3 flex items-center justify-between gap-2">
              <button type="button" onClick={back} disabled={stepIdx === 0}
                className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-0">
                <ChevronLeft className="h-4 w-4" />Back
              </button>
              {!here && step.href ? (
                <button type="button" onClick={() => router.push(step.href!)}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90">
                  Take me there<ArrowRight className="h-4 w-4" />
                </button>
              ) : (
                <button type="button" onClick={next}
                  className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-secondary">
                  {stepIdx + 1 >= active.steps.length ? 'Done' : 'Next'}<ChevronRight className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

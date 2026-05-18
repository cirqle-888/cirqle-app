'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  Search, X, ArrowRight,
  LayoutDashboard, CheckSquare, TrendingUp, FileText,
  BookOpen, Wallet, Users2, BarChart3, Settings, Upload,
  Hash, User, Clock, AlertCircle,
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

type ResultKind = 'nav' | 'task' | 'invoice' | 'client'

interface Result {
  id: string
  kind: ResultKind
  label: string
  sublabel?: string
  badge?: string
  badgeColor?: string
  href: string
}

// ─── Static nav items ─────────────────────────────────────────────────────────

const NAV_ITEMS: Result[] = [
  { id: 'nav-dashboard',     kind: 'nav', label: 'Dashboard',     href: '/dashboard',               sublabel: 'Overview & analytics' },
  { id: 'nav-tasks',         kind: 'nav', label: 'Tasks',          href: '/dashboard/tasks',          sublabel: 'Manage tasks' },
  { id: 'nav-contributions', kind: 'nav', label: 'Contributions',  href: '/dashboard/contributions',  sublabel: 'Team contributions' },
  { id: 'nav-invoices',      kind: 'nav', label: 'Invoices',       href: '/dashboard/invoices',       sublabel: 'Billing & payments' },
  { id: 'nav-quotations',    kind: 'nav', label: 'Quotations',     href: '/dashboard/quotations',     sublabel: 'Quote management' },
  { id: 'nav-cashbook',      kind: 'nav', label: 'Cash Book',      href: '/dashboard/cashbook',       sublabel: 'Cash flow tracking' },
  { id: 'nav-payroll',       kind: 'nav', label: 'HR & Payroll',   href: '/dashboard/payroll',        sublabel: 'Employees & salary' },
  { id: 'nav-reports',       kind: 'nav', label: 'Reports',        href: '/dashboard/reports',        sublabel: 'Performance reports' },
  { id: 'nav-import',        kind: 'nav', label: 'Bulk Import',    href: '/dashboard/import',         sublabel: 'Import data' },
  { id: 'nav-settings',      kind: 'nav', label: 'Settings',       href: '/dashboard/settings',       sublabel: 'App settings' },
]

const NAV_ICONS: Record<string, React.ElementType> = {
  'nav-dashboard':     LayoutDashboard,
  'nav-tasks':         CheckSquare,
  'nav-contributions': TrendingUp,
  'nav-invoices':      FileText,
  'nav-quotations':    BookOpen,
  'nav-cashbook':      Wallet,
  'nav-payroll':       Users2,
  'nav-reports':       BarChart3,
  'nav-settings':      Settings,
  'nav-import':        Upload,
}

// ─── Status styling helpers ───────────────────────────────────────────────────

function taskBadgeColor(status: string) {
  switch (status) {
    case 'done':        return 'bg-emerald-500/15 text-emerald-400'
    case 'in_progress': return 'bg-blue-500/15 text-blue-400'
    case 'pending':     return 'bg-yellow-500/15 text-yellow-400'
    case 'invoiced':    return 'bg-violet-500/15 text-violet-400'
    case 'cancelled':   return 'bg-red-500/15 text-red-400'
    default:            return 'bg-gray-500/15 text-gray-400'
  }
}

function invoiceBadgeColor(status: string) {
  switch (status) {
    case 'paid':        return 'bg-emerald-500/15 text-emerald-400'
    case 'partial':     return 'bg-blue-500/15 text-blue-400'
    case 'unpaid':      return 'bg-yellow-500/15 text-yellow-400'
    case 'overdue':     return 'bg-red-500/15 text-red-400'
    default:            return 'bg-gray-500/15 text-gray-400'
  }
}

function capitalize(s: string) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : ''
}

// ─── Kind icon ────────────────────────────────────────────────────────────────

function KindIcon({ result }: { result: Result }) {
  if (result.kind === 'nav') {
    const Icon = NAV_ICONS[result.id] || ArrowRight
    return <Icon className="w-4 h-4 shrink-0 text-muted-foreground" />
  }
  if (result.kind === 'task')    return <CheckSquare className="w-4 h-4 shrink-0 text-muted-foreground" />
  if (result.kind === 'invoice') return <FileText className="w-4 h-4 shrink-0 text-muted-foreground" />
  if (result.kind === 'client')  return <User className="w-4 h-4 shrink-0 text-muted-foreground" />
  return <Hash className="w-4 h-4 shrink-0 text-muted-foreground" />
}

// ─── Section label ────────────────────────────────────────────────────────────

function SectionLabel({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-3 pt-3 pb-1.5">
      <span className="text-[9px] font-semibold text-muted-foreground/40 uppercase tracking-widest">{label}</span>
      <div className="flex-1 h-px bg-foreground/[0.04]" />
    </div>
  )
}

// ─── Single result row ────────────────────────────────────────────────────────

function ResultRow({ result, active, onSelect }: { result: Result; active: boolean; onSelect: () => void }) {
  const rowRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <button
      ref={rowRef}
      type="button"
      onClick={onSelect}
      className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors rounded-lg mx-1 ${
        active ? 'bg-violet-500/15 text-foreground' : 'text-foreground hover:bg-foreground/[0.04]'
      }`}
    >
      <KindIcon result={result} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{result.label}</div>
        {result.sublabel && (
          <div className="text-xs text-muted-foreground/60 truncate">{result.sublabel}</div>
        )}
      </div>
      {result.badge && (
        <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full ${result.badgeColor}`}>
          {result.badge}
        </span>
      )}
      {active && <ArrowRight className="w-3.5 h-3.5 shrink-0 text-violet-400" />}
    </button>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function CommandPalette() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const [dbResults, setDbResults] = useState<Result[]>([])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // ── Open/close keyboard shortcut ──────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setOpen(o => !o)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ── Focus input when opened ───────────────────────────────────────────────
  useEffect(() => {
    if (open) {
      setQuery('')
      setDbResults([])
      setActiveIndex(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // ── DB search ─────────────────────────────────────────────────────────────
  const search = useCallback(async (q: string) => {
    if (!q.trim()) { setDbResults([]); setLoading(false); return }
    setLoading(true)
    const supabase = createClient()
    const term = q.toLowerCase()

    const [tasksRes, invoicesRes, clientsRes] = await Promise.all([
      supabase
        .from('tasks')
        .select('id, title, status, task_date, client:clients(name)')
        .ilike('title', `%${term}%`)
        .limit(5),

      supabase
        .from('invoices')
        .select('id, invoice_number, status, total_amount, client:clients(name)')
        .or(`invoice_number.ilike.%${term}%,notes.ilike.%${term}%`)
        .limit(5),

      supabase
        .from('clients')
        .select('id, name, code')
        .or(`name.ilike.%${term}%,code.ilike.%${term}%`)
        .limit(5),
    ])

    const results: Result[] = []

    for (const t of tasksRes.data ?? []) {
      const client = Array.isArray(t.client) ? t.client[0] : t.client
      results.push({
        id: `task-${t.id}`,
        kind: 'task',
        label: t.title,
        sublabel: `${client?.name ?? 'No client'} · ${t.task_date}`,
        badge: capitalize(t.status),
        badgeColor: taskBadgeColor(t.status),
        href: `/dashboard/tasks`,
      })
    }

    for (const inv of invoicesRes.data ?? []) {
      const client = Array.isArray(inv.client) ? inv.client[0] : inv.client
      results.push({
        id: `invoice-${inv.id}`,
        kind: 'invoice',
        label: inv.invoice_number,
        sublabel: client?.name ?? 'Unknown client',
        badge: capitalize(inv.status),
        badgeColor: invoiceBadgeColor(inv.status),
        href: `/dashboard/invoices`,
      })
    }

    for (const c of clientsRes.data ?? []) {
      results.push({
        id: `client-${c.id}`,
        kind: 'client',
        label: c.name,
        sublabel: c.code ? `Code: ${c.code}` : undefined,
        href: `/dashboard/tasks?client=${c.id}`,
      })
    }

    setDbResults(results)
    setLoading(false)
  }, [])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => search(query), 200)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query, search])

  // ── Build visible list ────────────────────────────────────────────────────
  const { sections, flat } = useMemo(() => {
    const q = query.toLowerCase().trim()
    const navFiltered = q
      ? NAV_ITEMS.filter(n => n.label.toLowerCase().includes(q) || (n.sublabel ?? '').toLowerCase().includes(q))
      : NAV_ITEMS

    type Section = { label: string; items: Result[] }
    const sections: Section[] = []

    if (navFiltered.length > 0) sections.push({ label: 'Pages', items: navFiltered })

    if (dbResults.length > 0) {
      const tasks    = dbResults.filter(r => r.kind === 'task')
      const invoices = dbResults.filter(r => r.kind === 'invoice')
      const clients  = dbResults.filter(r => r.kind === 'client')
      if (tasks.length)    sections.push({ label: 'Tasks',    items: tasks })
      if (invoices.length) sections.push({ label: 'Invoices', items: invoices })
      if (clients.length)  sections.push({ label: 'Clients',  items: clients })
    }

    const flat = sections.flatMap(s => s.items)
    return { sections, flat }
  }, [query, dbResults])

  // ── Keyboard nav ──────────────────────────────────────────────────────────
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(i => Math.min(i + 1, flat.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (flat[activeIndex]) navigate(flat[activeIndex])
    }
  }

  function navigate(result: Result) {
    router.push(result.href)
    setOpen(false)
  }

  // Reset active index when list changes
  useEffect(() => { setActiveIndex(0) }, [flat.length])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[999] flex items-start justify-center pt-[12vh] px-4"
      onMouseDown={e => { if (e.target === e.currentTarget) setOpen(false) }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Panel */}
      <div className="relative w-full max-w-xl bg-secondary border border-foreground/15 rounded-2xl shadow-2xl shadow-black/60 overflow-hidden animate-in fade-in zoom-in-95 duration-150">

        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-foreground/[0.06]">
          <Search className="w-4 h-4 text-muted-foreground/60 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search tasks, invoices, pages…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/40"
          />
          <div className="flex items-center gap-2">
            {loading && (
              <div className="w-3.5 h-3.5 border-2 border-violet-500/40 border-t-violet-500 rounded-full animate-spin" />
            )}
            {query && (
              <button type="button" onClick={() => setQuery('')} className="text-muted-foreground/50 hover:text-foreground transition-colors">
                <X className="w-4 h-4" />
              </button>
            )}
            <kbd className="hidden sm:inline-flex items-center gap-1 text-[10px] font-mono text-muted-foreground/40 bg-foreground/[0.04] border border-foreground/[0.06] rounded px-1.5 py-0.5">
              ESC
            </kbd>
          </div>
        </div>

        {/* Results */}
        <div className="max-h-[420px] overflow-y-auto py-1.5 overscroll-contain">
          {flat.length === 0 && !loading && (
            <div className="flex flex-col items-center justify-center py-10 gap-2 text-muted-foreground/40">
              <AlertCircle className="w-8 h-8 opacity-30" />
              <span className="text-sm">{query ? `No results for "${query}"` : 'Start typing to search…'}</span>
            </div>
          )}

          {(() => {
            let idx = 0
            return sections.map(section => (
              <div key={section.label}>
                <SectionLabel label={section.label} />
                {section.items.map(item => {
                  const thisIdx = idx++
                  return (
                    <ResultRow
                      key={item.id}
                      result={item}
                      active={activeIndex === thisIdx}
                      onSelect={() => navigate(item)}
                    />
                  )
                })}
              </div>
            ))
          })()}
        </div>

        {/* Footer hint */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-foreground/[0.06] text-[10px] text-muted-foreground/30 font-mono">
          <div className="flex items-center gap-3">
            <span>↑↓ navigate</span>
            <span>↵ open</span>
          </div>
          <span>⌘K to toggle</span>
        </div>
      </div>
    </div>
  )
}

// ─── Trigger button (for sidebar / header) ────────────────────────────────────

export function CommandPaletteTrigger({ className = '', isCollapsed = false }: { className?: string, isCollapsed?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
      }}
      className={`flex items-center h-8 ${isCollapsed ? 'justify-center w-8 px-0 gap-0' : 'gap-2 px-3'} rounded-lg text-xs text-muted-foreground/60 bg-foreground/[0.03] border border-foreground/[0.06] hover:border-foreground/[0.12] hover:text-muted-foreground transition-all ${className}`}
      title={isCollapsed ? 'Search (⌘K)' : undefined}
    >
      <Search className="w-3 h-3 shrink-0" />
      {!isCollapsed && (
        <div className="flex flex-1 items-center justify-between">
          <span className="text-left whitespace-nowrap">Search…</span>
          <kbd className="hidden sm:inline-flex items-center gap-0.5 font-mono text-[9px] text-muted-foreground/30">
            <span>⌘</span><span>K</span>
          </kbd>
        </div>
      )}
    </button>
  )
}

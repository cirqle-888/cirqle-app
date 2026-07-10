'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/contexts/permission-context'
import { useFavorites } from '@/contexts/favorites-context'
import { useWorkspace } from '@/contexts/workspace-context'
import { navSections, type NavItem } from '@/lib/nav-sections'
import { resolveFavoriteIcon, iconKeyFor } from '@/lib/favorites/icon-map'
import { recordUsage, listFrequent, listRecent, type UsageItem } from '@/lib/quick-actions/actions'
import { FavoriteToggle } from '@/components/ui/favorite-toggle'
import {
  Search, X, ArrowRight,
  CheckSquare, FileText, Hash, User, AlertCircle, Star, Clock3, Flame,
  Briefcase, Users, FileSignature, Receipt, Banknote, Plus
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

type ResultKind = 'nav' | 'task' | 'invoice' | 'client' | 'employee' | 'project' | 'quotation' | 'payroll' | 'cashbook' | 'action'

interface Result {
  id: string
  kind: ResultKind
  label: string
  sublabel?: string
  badge?: string
  badgeColor?: string
  href: string
  icon?: React.ElementType
  /** Present for nav results — lets the row render a star + record usage. */
  navItem?: NavItem
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
  if (result.icon) { const Icon = result.icon; return <Icon className="w-4 h-4 shrink-0 text-muted-foreground" /> }
  if (result.kind === 'task')    return <CheckSquare className="w-4 h-4 shrink-0 text-muted-foreground" />
  if (result.kind === 'invoice') return <FileText className="w-4 h-4 shrink-0 text-muted-foreground" />
  if (result.kind === 'client')  return <User className="w-4 h-4 shrink-0 text-muted-foreground" />
  if (result.kind === 'employee') return <Users className="w-4 h-4 shrink-0 text-muted-foreground" />
  if (result.kind === 'project') return <Briefcase className="w-4 h-4 shrink-0 text-muted-foreground" />
  if (result.kind === 'quotation') return <FileSignature className="w-4 h-4 shrink-0 text-muted-foreground" />
  if (result.kind === 'payroll') return <Banknote className="w-4 h-4 shrink-0 text-muted-foreground" />
  if (result.kind === 'cashbook') return <Receipt className="w-4 h-4 shrink-0 text-muted-foreground" />
  if (result.kind === 'action') return <Plus className="w-4 h-4 shrink-0 text-muted-foreground" />
  return <Hash className="w-4 h-4 shrink-0 text-muted-foreground" />
}

// ─── Section label ────────────────────────────────────────────────────────────

function SectionLabel({ label, icon: Icon }: { label: string; icon?: React.ElementType }) {
  return (
    <div className="flex items-center gap-2 px-3 pt-3 pb-1.5">
      {Icon && <Icon className="w-3 h-3 text-muted-foreground/40" />}
      <span className="text-[9px] font-semibold text-muted-foreground/40 uppercase tracking-widest">{label}</span>
      <div className="flex-1 h-px bg-foreground/[0.04]" />
    </div>
  )
}

// ─── Single result row ────────────────────────────────────────────────────────

function ResultRow({ result, active, onSelect, optionId }: { result: Result; active: boolean; onSelect: () => void; optionId: string }) {
  const rowRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <div
      className={`w-full flex items-center gap-2 px-1 mx-1 rounded-lg transition-colors ${
        active ? 'bg-violet-500/15' : 'hover:bg-foreground/[0.04]'
      }`}
    >
      <button
        ref={rowRef}
        type="button"
        id={optionId}
        role="option"
        aria-selected={active}
        onClick={onSelect}
        className="flex-1 min-w-0 flex items-center gap-3 py-2.5 pl-2 text-left"
      >
        <KindIcon result={result} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate text-foreground">{result.label}</div>
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
      {result.kind === 'nav' && (
        <FavoriteToggle
          entityType="nav_page"
          href={result.href}
          label={result.label}
          iconKey={result.navItem?.icon ? iconKeyFor(result.navItem.icon) : 'Star'}
          size={14}
          className="mr-1"
        />
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function CommandPalette() {
  const router = useRouter()
  const { user, can } = usePermissions()
  const { favorites } = useFavorites()
  const { current: activeWorkspace } = useWorkspace()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const [dbResults, setDbResults] = useState<Result[]>([])
  const [frequent, setFrequent] = useState<UsageItem[]>([])
  const [recent, setRecent] = useState<UsageItem[]>([])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Every module/page the viewer has permission to reach — the full catalogue,
  // not a stale hand-picked subset. Workspace-restricted hrefs (if any) are
  // ranked first, never hidden — Quick Actions can always reach anything
  // Search results should be able to reach, per spec.
  const allNavItems: NavItem[] = useMemo(
    () => navSections.flatMap(s => s.items).filter(i =>
      (!i.requiredPerm || can(i.requiredPerm)) && (!i.adminOnly || user.isAdmin)
    ),
    [can, user.isAdmin],
  )
  const workspaceHrefs = activeWorkspace.sidebarModuleHrefs
  const sortedNavItems = useMemo(() => {
    if (!workspaceHrefs) return allNavItems
    const inWorkspace = allNavItems.filter(i => workspaceHrefs.includes(i.href))
    const rest = allNavItems.filter(i => !workspaceHrefs.includes(i.href))
    return [...inWorkspace, ...rest]
  }, [allNavItems, workspaceHrefs])

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

  // ── Focus input + load Frequent/Recent when opened ────────────────────────
  // Deferred setState (setTimeout 0) — no sync setState in an effect body,
  // per the react-compiler lint rule.
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => {
      setQuery('')
      setDbResults([])
      setActiveIndex(0)
      requestAnimationFrame(() => inputRef.current?.focus())
      void listFrequent().then(setFrequent)
      void listRecent().then(setRecent)
    }, 0)
    return () => clearTimeout(t)
  }, [open])

  // ── DB search ─────────────────────────────────────────────────────────────
  const search = useCallback(async (q: string) => {
    if (!q.trim()) { setDbResults([]); setLoading(false); return }
    setLoading(true)
    const supabase = createClient()
    const term = q.toLowerCase()

    const [tasksRes, invoicesRes, clientsRes, employeesRes, projectsRes, quotationsRes, payrollRes, cashbookRes] = await Promise.all([
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

      supabase
        .from('employees')
        .select('id, name, email')
        .or(`name.ilike.%${term}%,email.ilike.%${term}%`)
        .limit(5),

      supabase
        .from('ad_projects')
        .select('id, campaign_name, client:clients(name)')
        .ilike('campaign_name', `%${term}%`)
        .limit(5),

      supabase
        .from('quotations')
        .select('id, quotation_number, status, client:clients(name)')
        .ilike('quotation_number', `%${term}%`)
        .limit(5),

      supabase
        .from('payroll')
        .select('id, payslip_number, month, year, status, employee:employees(name)')
        .ilike('payslip_number', `%${term}%`)
        .limit(5),

      supabase
        .from('cashbook_entries')
        .select('id, description, amount, entry_date')
        .ilike('description', `%${term}%`)
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

    for (const e of employeesRes.data ?? []) {
      results.push({
        id: `employee-${e.id}`,
        kind: 'employee',
        label: e.name,
        sublabel: e.email,
        href: `/dashboard/payroll`,
      })
    }

    for (const p of projectsRes.data ?? []) {
      const client = Array.isArray(p.client) ? p.client[0] : p.client
      results.push({
        id: `project-${p.id}`,
        kind: 'project',
        label: p.campaign_name,
        sublabel: client?.name ?? 'Unknown client',
        href: `/dashboard/advertising`,
      })
    }

    for (const q of quotationsRes.data ?? []) {
      const client = Array.isArray(q.client) ? q.client[0] : q.client
      results.push({
        id: `quotation-${q.id}`,
        kind: 'quotation',
        label: q.quotation_number,
        sublabel: `${client?.name ?? 'Unknown client'} · ${q.status}`,
        href: `/dashboard/quotations`,
      })
    }

    for (const pr of payrollRes.data ?? []) {
      const emp = Array.isArray(pr.employee) ? pr.employee[0] : pr.employee
      results.push({
        id: `payroll-${pr.id}`,
        kind: 'payroll',
        label: pr.payslip_number || `Payslip`,
        sublabel: `${emp?.name ?? 'Unknown employee'} · ${pr.month}/${pr.year}`,
        badge: capitalize(pr.status || ''),
        href: `/dashboard/payroll`,
      })
    }

    for (const cb of cashbookRes.data ?? []) {
      results.push({
        id: `cashbook-${cb.id}`,
        kind: 'cashbook',
        label: cb.description || 'Entry',
        sublabel: `${cb.entry_date} · Amount: ${cb.amount}`,
        href: `/dashboard/cashbook`,
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
    type Section = { label: string; items: Result[]; icon?: React.ElementType }
    const sections: Section[] = []

    if (!q) {
      // Empty query: Favorites → Frequent → Recent (the three Quick Actions tabs).
      if (favorites.length > 0) {
        sections.push({
          label: 'Favorites', icon: Star,
          items: favorites.map(f => ({
            id: `fav-${f.id}`, kind: 'nav' as const, label: f.label, href: f.href,
            icon: resolveFavoriteIcon(f.iconKey),
          })),
        })
      }
      if (frequent.length > 0) {
        sections.push({
          label: 'Frequently used', icon: Flame,
          items: frequent.map(u => ({
            id: `freq-${u.itemKey}`, kind: 'nav' as const, label: u.label, href: u.href,
            sublabel: `Used ${u.count}×`,
          })),
        })
      }
      if (recent.length > 0) {
        sections.push({
          label: 'Recently used', icon: Clock3,
          items: recent.map(u => ({
            id: `rec-${u.itemKey}`, kind: 'nav' as const, label: u.label, href: u.href,
          })),
        })
      }
      // Nothing pinned/used yet — fall back to the full catalogue so the
      // palette is never empty on first use.
      if (sections.length === 0) {
        sections.push({
          label: 'All modules',
          items: sortedNavItems.map(n => ({
            id: `nav-${n.href}`, kind: 'nav' as const, label: n.label, sublabel: n.href,
            href: n.href, icon: n.icon, navItem: n,
          })),
        })
      }

      // Add Quick Actions when query is empty
      sections.push({
        label: 'Quick Actions',
        icon: Plus,
        items: [
          { id: 'qa-task', kind: 'action', label: 'Create new task', href: '/dashboard/tasks?new=true' },
          { id: 'qa-invoice', kind: 'action', label: 'Create new invoice', href: '/dashboard/invoices?new=true' },
          { id: 'qa-quotation', kind: 'action', label: 'Create new quotation', href: '/dashboard/quotations?new=true' },
          { id: 'qa-cashbook', kind: 'action', label: 'Add cashbook entry', href: '/dashboard/cashbook?new=true' },
        ],
      })
    } else {
      const navFiltered = sortedNavItems.filter(n => n.label.toLowerCase().includes(q))
      if (navFiltered.length > 0) {
        sections.push({
          label: 'Pages',
          items: navFiltered.map(n => ({
            id: `nav-${n.href}`, kind: 'nav' as const, label: n.label, sublabel: n.href,
            href: n.href, icon: n.icon, navItem: n,
          })),
        })
      }
      if (dbResults.length > 0) {
        const tasks      = dbResults.filter(r => r.kind === 'task')
        const invoices   = dbResults.filter(r => r.kind === 'invoice')
        const clients    = dbResults.filter(r => r.kind === 'client')
        const employees  = dbResults.filter(r => r.kind === 'employee')
        const projects   = dbResults.filter(r => r.kind === 'project')
        const quotations = dbResults.filter(r => r.kind === 'quotation')
        const payroll    = dbResults.filter(r => r.kind === 'payroll')
        const cashbook   = dbResults.filter(r => r.kind === 'cashbook')

        if (tasks.length)      sections.push({ label: 'Tasks',      items: tasks })
        if (invoices.length)   sections.push({ label: 'Invoices',   items: invoices })
        if (clients.length)    sections.push({ label: 'Clients',    items: clients })
        if (employees.length)  sections.push({ label: 'Employees',  items: employees })
        if (projects.length)   sections.push({ label: 'Projects',   items: projects })
        if (quotations.length) sections.push({ label: 'Quotations', items: quotations })
        if (payroll.length)    sections.push({ label: 'Payroll',    items: payroll })
        if (cashbook.length)   sections.push({ label: 'Cashbook',   items: cashbook })
      }
    }

    const flat = sections.flatMap(s => s.items)
    return { sections, flat }
  }, [query, dbResults, favorites, frequent, recent, sortedNavItems])

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
    void recordUsage({
      itemKey: `${result.kind}:${result.href}`,
      itemType: result.kind,
      label: result.label,
      href: result.href,
      workspaceId: activeWorkspace.isSystem ? null : activeWorkspace.id,
    })
    router.push(result.href)
    setOpen(false)
  }

  // Reset active index when list changes (deferred — same lint rule as above).
  useEffect(() => { const t = setTimeout(() => setActiveIndex(0), 0); return () => clearTimeout(t) }, [flat.length])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[999] flex items-start justify-center pt-[12vh] px-4"
      onMouseDown={e => { if (e.target === e.currentTarget) setOpen(false) }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Panel */}
      <div role="dialog" aria-modal="true" aria-label="Command palette" className="relative w-full max-w-xl bg-secondary border border-foreground/15 rounded-2xl shadow-2xl shadow-black/60 overflow-hidden animate-in fade-in zoom-in-95 duration-150">

        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-foreground/[0.06]">
          <Search className="w-4 h-4 text-muted-foreground/60 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-results"
            aria-activedescendant={flat[activeIndex] ? `command-palette-option-${activeIndex}` : undefined}
            placeholder="Search modules, tasks, invoices, clients…"
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
        <div id="command-palette-results" role="listbox" aria-label="Search results" className="max-h-[420px] overflow-y-auto py-1.5 overscroll-contain">
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
                <SectionLabel label={section.label} icon={section.icon} />
                {section.items.map(item => {
                  const thisIdx = idx++
                  return (
                    <ResultRow
                      key={item.id}
                      result={item}
                      active={activeIndex === thisIdx}
                      optionId={`command-palette-option-${thisIdx}`}
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

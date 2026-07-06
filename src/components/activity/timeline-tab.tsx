'use client'

/**
 * <TimelineTab> — universal activity timeline (Cirqle Connect Wave A).
 *
 * One component for every scope: client, project, task, employee, or global.
 * Renders category-filter chips, icon + avatar rows, relative timestamps,
 * expandable field diffs, deep links, and cursor-based "load more".
 *
 * Read path: getTimeline() (single permission enforcement point —
 * finance categories are stripped server-side for users without
 * timeline.view_finance; chips for hidden categories are not shown).
 *
 * Design: docs/cirqle-connect/UI_FLOW.md §1
 */

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import {
  CheckSquare, ReceiptText, MessageSquare, Paperclip, Megaphone,
  Users, UserRound, Landmark, ChevronDown, ChevronRight,
  RefreshCw, ExternalLink, Briefcase,
} from 'lucide-react'
import Link from 'next/link'
import { getTimeline, type TimelineItem, type TimelineScope } from '@/lib/activity/timeline'
import { timelineSentence, timelineHref, ALL_CATEGORIES } from '@/lib/activity/timeline-copy'
import type { ActivityCategory } from '@/lib/activity/log'
import { usePermissions } from '@/contexts/permission-context'
import { displayEmployee } from '@/lib/utils/employee-display'

// ── Category icons ────────────────────────────────────────────────────────────

const CATEGORY_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  tasks: CheckSquare, billing: ReceiptText, chat: MessageSquare, files: Paperclip,
  advertising: Megaphone, crm: Users, employees: UserRound, finance: Landmark,
  recruitment: Briefcase,
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  const hrs  = Math.floor(diff / 3_600_000)
  const days = Math.floor(diff / 86_400_000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (hrs  < 24) return `${hrs}h ago`
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })
}

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const that  = new Date(d); that.setHours(0, 0, 0, 0)
  const diffDays = Math.round((today.getTime() - that.getTime()) / 86_400_000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
}

// ── Row ───────────────────────────────────────────────────────────────────────

function DiffDetail({ detail }: { detail: unknown }) {
  if (!Array.isArray(detail) || detail.length === 0) return null
  const rows = detail.filter(
    (d): d is { field: string; from: unknown; to: unknown } =>
      !!d && typeof d === 'object' && 'field' in (d as object),
  )
  if (rows.length === 0) return null
  return (
    <div className="mt-1.5 ml-0.5 space-y-0.5">
      {rows.map((r, i) => (
        <div key={i} className="text-xs text-muted-foreground">
          <span className="font-medium">{r.field}</span>
          {': '}
          <span className="line-through opacity-70">{String(r.from ?? '—')}</span>
          {' → '}
          <span>{String(r.to ?? '—')}</span>
        </div>
      ))}
    </div>
  )
}

function TimelineRow({ item, mask }: {
  item: TimelineItem
  mask: (name?: string | null, cqid?: string | null) => string
}) {
  const [expanded, setExpanded] = useState(false)
  const Icon = CATEGORY_ICON[item.category] ?? Users
  const rowInput = {
    entity_type: item.entityType, entity_id: item.entityId,
    action: item.action, category: item.category,
    note: item.note, detail: item.detail,
  }
  const href = timelineHref(rowInput)
  const sentence = timelineSentence(rowInput)
  const hasDiff = Array.isArray(item.detail) && item.detail.length > 0

  return (
    <div className="flex items-start gap-3 py-2.5 group">
      {/* Category icon */}
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="text-sm leading-snug">
          <span className="font-medium">{item.actor ? mask(item.actor.name, item.actor.cqid) : 'System'}</span>{' '}
          <span className="text-foreground/90">{sentence}</span>
          {href && (
            <Link
              href={href}
              className="ml-1.5 inline-flex items-center align-middle text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
              aria-label="Open"
            >
              <ExternalLink className="h-3 w-3" />
            </Link>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span title={new Date(item.createdAt).toLocaleString('en-IN')}>{formatRelative(item.createdAt)}</span>
          {hasDiff && (
            <button
              type="button"
              onClick={() => setExpanded(v => !v)}
              className="inline-flex items-center gap-0.5 hover:text-foreground"
            >
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              what changed
            </button>
          )}
        </div>
        {expanded && <DiffDetail detail={item.detail} />}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export interface TimelineTabProps {
  scope: TimelineScope
  /** Compact = tighter paddings for use inside modals/accordions. */
  variant?: 'default' | 'compact'
}

export function TimelineTab({ scope, variant = 'default' }: TimelineTabProps) {
  const { can, user, revealNames } = usePermissions()
  const canFinance = user.isAdmin || can('timeline.view_finance')
  const mask = useCallback(
    (name?: string | null, cqid?: string | null) =>
      displayEmployee({ name: name ?? '', cqid: cqid ?? '' }, { revealNames, canReveal: true }),
    [revealNames],
  )

  const categories = useMemo(
    () => ALL_CATEGORIES.filter(c => canFinance || (c.key !== 'billing' && c.key !== 'finance')),
    [canFinance],
  )

  const [active, setActive] = useState<ActivityCategory | 'all'>('all')
  const [items, setItems] = useState<TimelineItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [initialLoaded, setInitialLoaded] = useState(false)
  const [pending, startTransition] = useTransition()

  // Stable identity for the scope object so `load` doesn't recreate on
  // every parent render (callers pass object literals).
  const scopeKey = JSON.stringify(scope)

  const load = useCallback((reset: boolean, cat: ActivityCategory | 'all', cur: string | null) => {
    const parsedScope = JSON.parse(scopeKey) as TimelineScope
    startTransition(async () => {
      const res = await getTimeline(parsedScope, {
        categories: cat === 'all' ? undefined : [cat],
        cursor: reset ? null : cur,
      })
      if (!res.ok) { setError(res.error); return }
      setError(null)
      setItems(prev => (reset ? res.items : [...prev, ...res.items]))
      setCursor(res.nextCursor)
      setInitialLoaded(true)
    })
  }, [scopeKey])

  useEffect(() => { load(true, active, null) }, [load, active])

  // Group by day for section headers
  const groups = useMemo(() => {
    const out: { label: string; rows: TimelineItem[] }[] = []
    for (const item of items) {
      const label = dayLabel(item.createdAt)
      const last = out[out.length - 1]
      if (last && last.label === label) last.rows.push(item)
      else out.push({ label, rows: [item] })
    }
    return out
  }, [items])

  return (
    <div className={variant === 'compact' ? 'space-y-3' : 'space-y-4'}>
      {/* Filter chips */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setActive('all')}
          className={`rounded-full border px-3 py-1 text-xs transition-colors ${
            active === 'all' ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground'
          }`}
        >
          All
        </button>
        {categories.map(c => (
          <button
            key={c.key}
            type="button"
            onClick={() => setActive(c.key)}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              active === c.key ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            {c.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => load(true, active, null)}
          className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          aria-label="Refresh"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${pending ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {!error && initialLoaded && items.length === 0 && (
        <div className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
          No activity yet{active !== 'all' ? ' in this category' : ''}.
        </div>
      )}

      {!initialLoaded && pending && (
        <div className="space-y-3 py-2">
          {[0, 1, 2].map(i => (
            <div key={i} className="flex items-center gap-3 animate-pulse">
              <div className="h-7 w-7 rounded-full bg-muted" />
              <div className="h-3.5 flex-1 max-w-[70%] rounded bg-muted" />
            </div>
          ))}
        </div>
      )}

      {groups.map(g => (
        <div key={g.label}>
          <div className="sticky top-0 z-10 -mx-1 bg-background/95 px-1 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">
            {g.label}
          </div>
          <div className="divide-y divide-border/60">
            {g.rows.map(item => <TimelineRow key={item.id} item={item} mask={mask} />)}
          </div>
        </div>
      ))}

      {cursor && (
        <button
          type="button"
          onClick={() => load(false, active, cursor)}
          disabled={pending}
          className="w-full rounded-lg border border-border py-2 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          {pending ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}

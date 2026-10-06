'use client'

/**
 * Building blocks for list-page toolbars (Tasks, Contributions).
 *
 * One vocabulary so both pages read the same: row-1 controls are 36px to sit
 * level with the search box, row-2 controls are 30px to match the compact
 * filter dropdowns, and every "on" state is the same quiet violet tint.
 * Labels collapse to icons on narrower screens; the icon keeps a tooltip.
 */
import type { ComponentType, ReactNode } from 'react'
import { SlidersHorizontal } from 'lucide-react'

type Icon = ComponentType<{ className?: string }>

const ON = 'bg-violet-500/15 text-violet-700 dark:text-violet-300'

/** A rounded group that holds related row-1 buttons. */
export function ToolbarSegment({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex items-center gap-0.5 h-9 p-0.5 rounded-xl border border-foreground/15 bg-secondary shrink-0 ${className}`}>
      {children}
    </div>
  )
}

/**
 * A button inside a ToolbarSegment. The label shows from `labelFrom` up;
 * below it the button is icon-only and the label moves to the tooltip.
 */
export function SegmentButton({
  icon: I, label, active = false, onClick, title, labelFrom = 'xl', badge,
}: {
  icon: Icon
  label: string
  active?: boolean
  onClick: () => void
  title?: string
  labelFrom?: 'always' | 'lg' | 'xl'
  /** Small count shown after the label/icon. */
  badge?: ReactNode
}) {
  const labelCls = labelFrom === 'always' ? '' : labelFrom === 'lg' ? 'hidden lg:inline' : 'hidden xl:inline'
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      aria-label={label}
      aria-pressed={active}
      className={`h-8 min-w-8 px-2 rounded-[10px] text-xs font-medium flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
        active ? ON : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05]'
      }`}
    >
      <I className="w-3.5 h-3.5 shrink-0" />
      <span className={labelCls}>{label}</span>
      {badge}
    </button>
  )
}

/** All · Mine · Not mine — one control instead of two independent toggles. */
export function ScopeToggle({
  value, onChange, size = 'md',
}: {
  value: 'mine' | 'not_mine' | null
  onChange: (v: 'mine' | 'not_mine' | null) => void
  size?: 'sm' | 'md'
}) {
  const opts = [
    { v: null, label: 'Everyone', title: 'Everyone’s tasks' },
    { v: 'mine' as const, label: 'Mine', title: 'Tasks assigned to or contributed by me' },
    { v: 'not_mine' as const, label: 'Not mine', title: 'Tasks I’m not assigned to and haven’t contributed to' },
  ]
  const h = size === 'sm' ? 'h-[30px]' : 'h-9'
  const bh = size === 'sm' ? 'h-[26px]' : 'h-8'
  return (
    <div role="radiogroup" aria-label="Whose tasks" className={`flex items-center gap-0.5 ${h} p-0.5 rounded-xl border border-foreground/15 bg-secondary shrink-0`}>
      {opts.map(o => {
        const active = value === o.v
        return (
          <button
            key={o.label}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title}
            onClick={() => onChange(o.v)}
            className={`${bh} px-2.5 rounded-[10px] text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
              active ? ON : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Mobile-only "Filters" button with the number of active filters. */
export function FiltersButton({ open, count, onClick }: { open: boolean; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-label={count ? `Filters (${count} active)` : 'Filters'}
      className={`relative h-11 sm:h-9 px-3 rounded-xl border text-xs font-medium flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer ${
        open || count ? `border-violet-500/30 ${ON}` : 'border-foreground/15 bg-secondary text-muted-foreground hover:text-foreground'
      }`}
    >
      <SlidersHorizontal className="w-4 h-4" />
      <span className="hidden min-[400px]:inline">Filters</span>
      {count > 0 && (
        <span className="min-w-[16px] h-4 px-1 rounded-full bg-violet-500 text-white text-[10px] font-semibold leading-4 text-center">{count}</span>
      )}
    </button>
  )
}

/** A status / quick-filter chip with a count. */
export function StatusChip({
  label, count, active, onClick, tone = 'violet', dot = false, title,
}: {
  label: string
  count?: ReactNode
  active: boolean
  onClick: () => void
  tone?: 'violet' | 'orange'
  /** Attention dot (e.g. work needing scoring) while not selected. */
  dot?: boolean
  title?: string
}) {
  const on = tone === 'orange'
    ? 'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30'
    : `${ON} border-violet-500/30`
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`h-[30px] px-2.5 rounded-xl border text-xs font-medium flex items-center gap-1.5 shrink-0 whitespace-nowrap transition-colors cursor-pointer ${
        active ? on : 'border-transparent bg-secondary text-muted-foreground hover:text-foreground'
      }`}
    >
      {label}
      {count != null && (
        <span className={`text-[10px] font-semibold tabular-nums ${active ? 'opacity-90' : 'opacity-60'}`}>{count}</span>
      )}
      {dot && !active && <span className="w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0" />}
    </button>
  )
}

/** Thin vertical divider between toolbar groups (desktop only). */
export function ToolbarDivider() {
  return <span aria-hidden className="hidden sm:block w-px h-4 bg-foreground/10 shrink-0 mx-0.5" />
}

'use client'

import { ReactNode } from 'react'

/**
 * Dashboard page layout primitives.
 *
 * Goal: every list-style module (Tasks, Contributions, Invoices, …) renders inside the
 * same scroll/header/toolbar architecture, instead of each page hand-rolling its own
 * sticky math and spacing hacks.
 *
 * Structure:
 *
 *   <PageShell>
 *     <PageChrome>
 *       <Header ... />                              ← sticky by default
 *       <StickyToolbar>                             ← sits perfectly under Header
 *         <StickyToolbar.Row>…</StickyToolbar.Row>
 *         <StickyToolbar.Row>…</StickyToolbar.Row>
 *       </StickyToolbar>
 *     </PageChrome>
 *     <PageContent>…page body…</PageContent>     ← p-6 padded body
 *   </PageShell>
 *
 * Rules:
 *   - PageShell adds NO padding. Children own their own spacing.
 *   - PageChrome wraps the Header and StickyToolbar in a single sticky container to prevent visual jumps.
 *   - The Header and Toolbar stack naturally without hardcoded `top` offsets.
 */

// ─────────────────────────────────────────────────────────────────────────────
// <PageShell>
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Outermost page wrapper. A plain flex column that establishes the layout context
 * for the Header → Toolbar → Content stack. No padding, no sticky math of its own.
 */
export function PageShell({ children }: { children: ReactNode }) {
  return <div className="flex flex-col min-h-full">{children}</div>
}

// ─────────────────────────────────────────────────────────────────────────────
// <PageChrome>
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sticky container for the page header and toolbar. 
 * Groups them so they scroll as a single unified chrome without overlapping,
 * keeping their internal paddings and visual gaps stable.
 */
function PageChrome({ children }: { children: ReactNode }) {
  return (
    <div className="sticky top-0 z-30 flex flex-col w-full">
      {children}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// <StickyToolbar> + <StickyToolbar.Row>
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Frosted-glass toolbar that sits directly below the page Header.
 * Must be wrapped inside <PageChrome> so it scrolls together with the Header.
 *
 * IMPORTANT: do NOT add `overflow-hidden` here. Several toolbar controls (Board-view ⚙
 * settings popover, filter dropdowns, date pickers, …) position themselves with
 * `absolute top-full` so they hang BELOW the toolbar's box. `overflow-hidden` on a
 * clipping box clips those popovers regardless of their z-index.
 */
function StickyToolbar({ children }: { children: ReactNode }) {
  return (
    <div
      className="
        bg-background/95 backdrop-blur-md
        supports-[backdrop-filter]:bg-background/80
        border-b border-border/40
        px-4 sm:px-6
        py-3 sm:py-4
        space-y-1.5 sm:space-y-2
      "
    >
      {children}
    </div>
  )
}

/**
 * A single row inside the toolbar. Flex row, full width, items vertically centered.
 * Filters/chips rows can still wrap via flex-wrap inside their own row.
 */
function StickyToolbarRow({ children, className = '' }: { children: ReactNode; className?: string }) {
  // Tighter gaps on mobile so wrapped buttons sit closer together.
  return <div className={`flex items-center gap-1.5 sm:gap-2 w-full ${className}`}>{children}</div>
}

// Compound component API: <StickyToolbar.Row>
StickyToolbar.Row = StickyToolbarRow
export { StickyToolbar, PageChrome }

// ─────────────────────────────────────────────────────────────────────────────
// <PageContent>
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Standard padded body for a dashboard page. Use this for the main scrollable content
 * area (tables, boards, calendars, …) so every page gets the same p-6 rhythm.
 *
 * Pages that need a custom layout (e.g. a full-bleed canvas) can skip this and add
 * their own wrapper as a child of PageShell.
 */
export function PageContent({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={`p-6 space-y-4 ${className}`}>{children}</div>
}

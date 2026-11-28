'use client'

/**
 * The tab bar for a module whose pages are steps of one job — Cash Book and
 * its Recurring, Card and Bank pages; Invoices, Follow-ups and Statements;
 * the five Recruitment pages; Social's seven. The sidebar shows one row for
 * the module and the steps live here, under the page title, so the sidebar
 * stays short without anything being hidden.
 *
 * The groups are declared once — in src/lib/nav-sections.ts (`tabOf`), and
 * Social's in components/social-hub/social-tabs.tsx — and the page Header
 * draws this bar on every page of a group, so no page has to remember to.
 * Routes did not move, so bookmarks and deep links still work.
 *
 * A tab the viewer cannot open is dropped (same gate as the sidebar), and a
 * bar with one tab left draws nothing: one tab is a label, not a choice.
 */
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useMemo, useRef } from 'react'
import { usePermissions } from '@/contexts/permission-context'
import { useOptionalWorkspace } from '@/contexts/workspace-context'
import { isNavItemVisible, tabGroupFor } from '@/lib/nav-sections'
import { SOCIAL_TABS } from '@/components/social-hub/social-tabs'

export type ModuleTab = { href: string; label: string }
export type ModuleTabSet = { label: string; tabs: ModuleTab[] }

/** The tabs for the page being shown, or null when it has none to offer. */
export function useModuleTabs(): ModuleTabSet | null {
  const pathname = usePathname() ?? ''
  const { user, can } = usePermissions()
  const workspaceHrefs = useOptionalWorkspace()?.current.sidebarModuleHrefs ?? null
  const unitOnly = user.unitRoutesOnly ?? false

  return useMemo(() => {
    const group = tabGroupFor(pathname)
    // Only on the tab pages themselves. A record or sub-page under one (an
    // application, a new quotation) keeps its breadcrumb back instead.
    if (group && group.some(t => t.href === pathname)) {
      const shown = group.filter(t =>
        isNavItemVisible(t, can, user.isAdmin, unitOnly) &&
        // A workspace narrows the tabs just as it narrows the sidebar — but
        // the page on screen always keeps its own tab, or the bar would
        // point nowhere.
        (t.href === pathname || !workspaceHrefs || workspaceHrefs.includes(t.href)),
      )
      return shown.length >= 2
        ? { label: group[0].label, tabs: shown.map(t => ({ href: t.href, label: t.tabLabel ?? t.label })) }
        : null
    }
    if (SOCIAL_TABS.some(t => t.href === pathname)) {
      const shown = SOCIAL_TABS.filter(t => can(t.perm))
      return shown.length >= 2 ? { label: 'Social', tabs: shown.map(t => ({ href: t.href, label: t.label })) } : null
    }
    return null
  }, [pathname, can, user.isAdmin, unitOnly, workspaceHrefs])
}

/** Underlined text tabs on the Header's bottom edge, scrolling sideways on a phone. */
export function TabBar({ label, tabs, activeHref }: {
  label: string
  tabs: ModuleTab[]
  activeHref: string | null
}) {
  const navRef = useRef<HTMLElement>(null)
  // On a phone the bar scrolls sideways, and a later tab (Social's Insights,
  // Recruitment's Reports) opened off-screen — you couldn't see where you
  // were. Centre it, moving only the bar: scrollIntoView moves the page too.
  useEffect(() => {
    const bar = navRef.current
    const active = bar?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!bar || !active) return
    const b = bar.getBoundingClientRect()
    const a = active.getBoundingClientRect()
    if (a.left >= b.left && a.right <= b.right) return
    bar.scrollLeft += a.left + a.width / 2 - (b.left + b.width / 2)
  }, [activeHref, tabs.length])

  return (
    <nav
      ref={navRef}
      aria-label={label}
      className="flex items-end gap-0.5 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden -mx-2.5"
    >
      {tabs.map(t => {
        const active = t.href === activeHref
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={`relative shrink-0 whitespace-nowrap rounded-md px-2.5 pt-1 pb-2.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
              active
                ? 'font-semibold text-foreground'
                : 'font-medium text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
            <span
              aria-hidden
              className={`absolute inset-x-2 bottom-0 h-[2px] rounded-full transition-opacity ${active ? 'gradient-bg opacity-100' : 'opacity-0'}`}
            />
          </Link>
        )
      })}
    </nav>
  )
}

/** The module's tab bar, as the page Header draws it. */
export function ModuleTabs({ set }: { set: ModuleTabSet }) {
  const pathname = usePathname() ?? ''
  return <TabBar label={set.label} activeHref={pathname} tabs={set.tabs} />
}

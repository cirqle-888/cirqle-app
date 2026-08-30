'use client'

/**
 * One module, six pages.
 *
 * Instagram and Facebook work was spread across six sidebar entries that had
 * to be found individually — plan a month here, publish there, answer comments
 * somewhere else. They are steps in one job, so they now carry a shared tab
 * bar and read as one place.
 *
 * The ROUTES are deliberately unchanged. Moving six pages would break every
 * bookmark and deep link in the app (the posting queue links into the
 * composer, My Work links into the queue) to gain nothing a tab bar does not
 * already give. This is a navigation fix, not a migration.
 *
 * Tabs are ordered by the workflow rather than alphabetically: plan the month,
 * see what is ready, publish it, answer the people who reply, check the grid,
 * read the numbers.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { usePermissions } from '@/contexts/permission-context'
import {
  CalendarDays, Send, PenSquare, MessageCircle, Grid3x3, BarChart3,
} from 'lucide-react'

const TABS = [
  { href: '/dashboard/social-calendar', label: 'Plan',     icon: CalendarDays,   perm: 'social.view' },
  { href: '/dashboard/social/queue',    label: 'To Post',  icon: Send,           perm: 'social.publish' },
  { href: '/dashboard/social/calendar', label: 'Compose',  icon: PenSquare,      perm: 'social.publish' },
  { href: '/dashboard/social/inbox',    label: 'Comments', icon: MessageCircle,  perm: 'social.publish' },
  { href: '/dashboard/social/feed',     label: 'Feed',     icon: Grid3x3,        perm: 'social.plan_feed' },
  { href: '/dashboard/social',          label: 'Insights', icon: BarChart3,      perm: 'social.view_insights' },
] as const

export function SocialTabs() {
  const pathname = usePathname()
  const { can } = usePermissions()

  const visible = TABS.filter(t => can(t.perm))
  // One tab is not a tab bar — it is a label taking up room.
  if (visible.length < 2) return null

  return (
    <nav
      aria-label="Social"
      className="flex items-center gap-1 overflow-x-auto -mx-1 px-1 pb-1"
    >
      {visible.map(t => {
        // /dashboard/social is a prefix of every other tab, so it only counts
        // as active on an exact match — otherwise Insights lights up everywhere.
        const active = t.href === '/dashboard/social'
          ? pathname === t.href
          : pathname === t.href || pathname.startsWith(`${t.href}/`)
        const Icon = t.icon
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border whitespace-nowrap transition-colors ${
              active
                ? 'bg-primary/10 border-primary/30 text-primary font-medium'
                : 'bg-card border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon className="w-3.5 h-3.5 shrink-0" />
            {t.label}
          </Link>
        )
      })}
    </nav>
  )
}

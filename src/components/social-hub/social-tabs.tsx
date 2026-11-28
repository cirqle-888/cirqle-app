'use client'

/**
 * One module, seven pages.
 *
 * Instagram and Facebook work was spread across six sidebar entries that had
 * to be found individually — plan a month here, publish there, answer comments
 * somewhere else. They are steps in one job, so they carry a shared tab bar
 * and read as one place.
 *
 * The ROUTES are deliberately unchanged. Moving the pages would break every
 * bookmark and deep link in the app (the posting queue links into the
 * composer, My Work links into the queue) to gain nothing a tab bar does not
 * already give.
 *
 * The page Header draws this bar (components/layout/module-tabs.tsx) on every
 * Social page, in the same place as every other module's tabs — pages no
 * longer render it themselves.
 *
 * Tabs are ordered by the workflow rather than alphabetically: plan the month,
 * see what is ready, publish it, answer the people who reply, check the grid,
 * read the numbers.
 */

export const SOCIAL_TABS = [
  { href: '/dashboard/social-calendar', label: 'Plan',     perm: 'social.view' },
  { href: '/dashboard/social/queue',    label: 'To Post',  perm: 'social.publish' },
  { href: '/dashboard/social/calendar', label: 'Compose',  perm: 'social.publish' },
  { href: '/dashboard/social/inbox',    label: 'Comments', perm: 'social.publish' },
  { href: '/dashboard/social/feed',     label: 'Feed',     perm: 'social.plan_feed' },
  { href: '/dashboard/social/times',    label: 'Times',    perm: 'social.view' },
  { href: '/dashboard/social',          label: 'Insights', perm: 'social.view_insights' },
] as const

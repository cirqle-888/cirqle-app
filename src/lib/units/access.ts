/**
 * Which pages a UNIT TEAM member may open (pure, dependency-free — the sign-in
 * check in src/lib/supabase/middleware.ts imports it, so it must stay tiny).
 *
 * Cirqle is the parent; its departments (Social Media & Creative, Cirqle
 * Flyers…) and sub-brands (Memoura) are units, each run by its own team. A
 * non-admin member of a unit must never see another unit's data. Filtering
 * every one of the app's ~60 pages would leave a leak the day someone adds a
 * page and forgets — so a unit member gets an ALLOW-LIST instead: these pages
 * and nothing else. A new page is closed to unit teams until it is added here,
 * and a test (access.test.ts) refuses an entry whose page does not narrow its
 * data to the unit.
 *
 * Admins and the office team (people in no unit) are not affected. Unit
 * staff (role 'staff') get the shorter UNIT_STAFF_PAGES below.
 */

export interface UnitTeamPage {
  href: string
  /** How the page keeps to the member's unit — checked by access.test.ts. */
  scopedBy: string
  /** Files that must contain `marker` for the claim above to hold. */
  proof: { file: string; marker: string }[]
}

export const UNIT_TEAM_PAGES: readonly UnitTeamPage[] = [
  {
    href: '/dashboard/my-work',
    scopedBy: 'Own work; a team lead sees only their own unit’s people',
    proof: [{ file: 'src/app/(dashboard)/dashboard/my-work/page.tsx', marker: 'unitTeamIds' }],
  },
  {
    href: '/dashboard/tasks',
    scopedBy: 'Service scope — confined to the unit’s services',
    proof: [{ file: 'src/app/(dashboard)/dashboard/tasks/page.tsx', marker: 'taskScopeP.then(s => [...s.serviceIds])' }],
  },
  {
    href: '/dashboard/clients',
    scopedBy: 'Service and department scope — only the unit’s clients',
    proof: [
      { file: 'src/app/(dashboard)/dashboard/clients/page.tsx', marker: 'loadServiceScope' },
      { file: 'src/app/(dashboard)/dashboard/clients/[id]/page.tsx', marker: 'loadServiceScope' },
    ],
  },
  {
    href: '/dashboard/contributions',
    scopedBy: 'Service scope — the unit’s tasks only',
    proof: [{ file: 'src/app/(dashboard)/dashboard/contributions/page.tsx', marker: 'const myServiceIds = [...taskScope.serviceIds]' }],
  },
  {
    href: '/dashboard/requests',
    scopedBy: 'Unit work filter — requests on the unit’s services or from its clients',
    proof: [{ file: 'src/app/(dashboard)/dashboard/requests/page.tsx', marker: 'unitWorkFilter' }],
  },
  {
    href: '/dashboard/social-calendar',
    scopedBy: 'Unit work filter — plans of the unit’s clients only',
    proof: [{ file: 'src/app/(dashboard)/dashboard/social-calendar/page.tsx', marker: 'unitWorkFilter' }],
  },
  {
    href: '/dashboard/chat',
    scopedBy: 'Conversation membership plus chat access rules (service scope)',
    proof: [{ file: 'src/app/(dashboard)/dashboard/chat/actions.ts', marker: 'loadChatAccess' }],
  },
  {
    href: '/dashboard/prompt-studio',
    scopedBy: 'Department scope — only the unit’s clients',
    proof: [{ file: 'src/app/(dashboard)/dashboard/prompt-studio/page.tsx', marker: 'loadDepartmentClientScope' }],
  },
  {
    href: '/dashboard/units',
    scopedBy: 'The member’s own units only; results only when the owner shares them',
    proof: [{ file: 'src/app/(dashboard)/dashboard/units/_page.ts', marker: 'requireUnitViewer' }],
  },
]

/**
 * Where a unit member lands instead of a page they may not open. It must be a
 * page EVERY member can open whatever their designation — the units page
 * (lib/units, requireUnitViewer) is. My Work was the first choice, but a
 * member whose designation cannot open it was sent to the dashboard, which
 * sent them back: a redirect loop (found testing as CQID004, 2026-11-27).
 */
export const UNIT_TEAM_HOME = '/dashboard/units'

/**
 * Unit STAFF (role 'staff') — on a team, but own work only: the pages they
 * need to do the work given to them, nothing that lists the unit's clients,
 * plans or earnings. A subset of UNIT_TEAM_PAGES (checked by access.test.ts).
 */
export const UNIT_STAFF_PAGES: readonly string[] = [
  '/dashboard/my-work',
  '/dashboard/tasks',
  '/dashboard/requests',
  '/dashboard/chat',
  '/dashboard/prompt-studio',
  '/dashboard/units',
]

/** How a person is held to unit pages: not at all, a team member's pages, or a staff member's. */
export type UnitLock = boolean | 'staff'

/** The lock for someone's unit roles (lead / member / staff). No roles = not locked. */
export function unitLockOf(roles: readonly string[]): UnitLock {
  if (!roles.length) return false
  return roles.every(r => r === 'staff') ? 'staff' : true
}

/** May a unit team member (or, with 'staff', a staff member) open this path? Query strings and hashes are ignored. */
export function unitTeamMayOpen(href: string, lock: UnitLock = true): boolean {
  const path = href.split(/[?#]/)[0].replace(/\/+$/, '') || '/'
  // Only dashboard pages are restricted here; API routes keep their own checks.
  if (path !== '/dashboard' && !path.startsWith('/dashboard/')) return true
  const pages = lock === 'staff' ? UNIT_STAFF_PAGES : UNIT_TEAM_PAGES.map(p => p.href)
  return pages.some(h => path === h || path.startsWith(`${h}/`))
}

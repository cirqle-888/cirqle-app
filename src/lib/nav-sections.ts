/**
 * Sidebar nav definition — shared source of truth so the sidebar itself and
 * the icon-grid app launcher (src/components/layout/app-launcher.tsx) render
 * the exact same destinations/permissions from one place.
 *
 * Sections are the sidebar's accordion groups: labeled sections collapse, and
 * `defaultOpen` controls the first-run state (the user's own toggles persist
 * in localStorage; the section holding the active route auto-opens).
 */
import {
  LayoutDashboard, CheckSquare, Users2, FileText, BookOpen, Wallet, BarChart3, Sheet,
  Settings, TrendingUp, Upload, Inbox, PhoneCall, Award, Activity, Blocks, Megaphone, Handshake,
  SlidersHorizontal, MessageSquare, ClipboardCheck, NotebookPen, LayoutGrid,
  Briefcase, ClipboardList, CalendarClock, CalendarDays, BadgeCheck, PieChart, Building2, Tags, History, Sparkles,
  BadgePercent, CalendarRange, HardHat, Repeat, Package as PackageIcon,
  Share2, UserPlus, Gauge,
  type LucideIcon,
} from 'lucide-react'

export type NavItem = {
  label: string
  href: string
  icon: LucideIcon
  requiredPerm?: string
  adminOnly?: boolean
  /** Extra search terms for the App Launcher (src/components/layout/app-launcher.tsx) — never rendered, only matched against. */
  keywords?: string[]
}
export type NavSection = {
  label?: string
  items: NavItem[]
  /** First-run accordion state for labeled sections (user toggles persist over this). */
  defaultOpen?: boolean
}

/** Permission/admin gate shared by every navSections consumer (Sidebar, App Launcher, Command Palette). */
export function isNavItemVisible(item: NavItem, can: (key: string) => boolean, isAdmin: boolean): boolean {
  return (!item.requiredPerm || can(item.requiredPerm)) && (!item.adminOnly || isAdmin)
}

/**
 * Most-specific matching nav href for the current pathname, so a parent
 * ("Invoices") doesn't light up when a child route ("Invoices › Follow-ups")
 * is active. Shared by Sidebar and App Launcher so both highlight the same
 * page the same way.
 */
export function resolveActiveHref(sections: { items: NavItem[] }[], pathname: string): string | null {
  const candidates = sections
    .flatMap(s => s.items.map(i => i.href))
    .filter(h => pathname === h || (h !== '/dashboard' && pathname.startsWith(h + '/')))
  if (candidates.length === 0) return null
  return candidates.reduce((a, b) => (b.length > a.length ? b : a))
}

/**
 * SECTION DESIGN (2026-08 single-owner audit): the visible sections carry only
 * what live data shows is in daily use; everything rarely- or never-used moves
 * to the collapsed "Advanced" section at the bottom. NOTHING is removed —
 * every route stays reachable and every item keeps its permission gate, so
 * returning a feature to the main nav is a one-line move. Evidence at audit
 * time: recruitment/quotations/approvals/org-units had zero rows ever;
 * social calendar 5, partners 4, personal workspace 0.
 */
export const navSections: NavSection[] = [
  {
    // Unlabeled home section — always visible, never collapses.
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, requiredPerm: 'dashboard.view' },
    ],
  },
  {
    label: 'Work',
    defaultOpen: true,
    items: [
      { label: 'AI Capture',    href: '/dashboard/capture',       icon: Sparkles, keywords: ['quick capture', 'paste', 'whatsapp', 'email', 'offer flyer'] },
      { label: 'Requests',      href: '/dashboard/requests',      icon: Inbox, requiredPerm: 'requests.view' },
      { label: 'Tasks',         href: '/dashboard/tasks',         icon: CheckSquare },
      { label: 'Clients',       href: '/dashboard/clients',       icon: Users2, requiredPerm: 'clients.view' },
      { label: 'Leads',         href: '/dashboard/leads',         icon: UserPlus, requiredPerm: 'leads.view', keywords: ['crm', 'meta leads', 'lead ads', 'prospects', 'enquiries'] },
      { label: 'Contributions', href: '/dashboard/contributions', icon: TrendingUp },
      { label: 'Chat',          href: '/dashboard/chat',          icon: MessageSquare, requiredPerm: 'chat.access' },
    ],
  },
  {
    label: 'Finance',
    defaultOpen: true,
    items: [
      // Commercial flow: Quotations → Packages → Invoices (design §12 #7).
      // Quotations sits in Advanced until one is actually issued.
      { label: 'Packages',          href: '/dashboard/packages',   icon: PackageIcon, requiredPerm: 'packages.view', keywords: ['agreement', 'retainer', 'commitment', 'bundle', 'committed', 'promised'] },
      { label: 'Invoices',          href: '/dashboard/invoices',   icon: FileText, requiredPerm: 'billing.view_invoices' },
      { label: 'Follow-ups',        href: '/dashboard/invoices/follow-ups', icon: PhoneCall, requiredPerm: 'billing.view_invoices' },
      { label: 'Cash Book',         href: '/dashboard/cashbook',   icon: Wallet,   requiredPerm: 'cashbook.view', keywords: ['expenses', 'bank', 'transactions'] },
      { label: 'Recurring',         href: '/dashboard/cashbook/recurring', icon: Repeat, requiredPerm: 'cashbook.view', keywords: ['rent', 'subscription', 'monthly bill', 'repeat', 'standing'] },
      // The monthly control centre: profit composition, payroll status,
      // corrections and the lock action for each financial period.
      { label: 'Months',            href: '/dashboard/finance/months', icon: CalendarRange, requiredPerm: 'payroll.view', keywords: ['financial timeline', 'period', 'close', 'lock', 'profit', 'month end'] },
    ],
  },
  {
    label: 'HR',
    defaultOpen: true,
    items: [
      { label: 'HR & Payroll', href: '/dashboard/payroll',     icon: Users2, requiredPerm: 'payroll.view', keywords: ['salary', 'payslip', 'employees'] },
      // Performance Scorecards: score employees & applicants, apply ratings.
      { label: 'Performance',  href: '/dashboard/performance', icon: Gauge, requiredPerm: 'performance.manage', keywords: ['scorecard', 'rating', 'appraisal', 'review', 'applicant', 'cv', 'measure'] },
    ],
  },
  {
    label: 'Insights',
    defaultOpen: false,
    items: [
      // Reports is gated by reports.view — admins always have it; non-admins
      // see the tab only when their designation grants it in Settings → Designations.
      { label: 'Reports', href: '/dashboard/reports', icon: BarChart3, requiredPerm: 'reports.view' },
      // Contribution Analysis: spreadsheet-style per-task profitability / earnings BI report.
      { label: 'Contribution Analysis', href: '/dashboard/reports/contribution-analysis', icon: Sheet, requiredPerm: 'reports.view', keywords: ['spreadsheet', 'earnings', 'BI'] },
      // Earnings by Role: what each ownership "hat" earned (Accounts, HR, CEO
      // Direct) — the split payroll's single ownership_earned figure hides.
      // Rows strip to the viewer's own awards without payroll.view_amounts.
      { label: 'Earnings by Role', href: '/dashboard/reports/role-earnings', icon: HardHat, requiredPerm: 'reports.view', keywords: ['hat', 'ownership', 'revenue share', 'accounts', 'HR', 'role label', 'incentive'] },
      // What-If Planner: simulate increments / commission / pricing / roles over a period.
      { label: 'What-If Planner', href: '/dashboard/reports/what-if', icon: SlidersHorizontal, requiredPerm: 'reports.view', keywords: ['simulation', 'forecast', 'commission'] },
      // Business Health Center: cash/collections, overdue aging, client risk, cron status.
      { label: 'Business Health', href: '/dashboard/health', icon: Activity, requiredPerm: 'reports.view', keywords: ['cash flow', 'overdue', 'risk', 'cron'] },
    ],
  },
  {
    label: 'Apps',
    defaultOpen: false,
    items: [
      { label: 'Advertising',    href: '/dashboard/advertising', icon: Megaphone, requiredPerm: 'advertising.view', keywords: ['campaigns', 'ads', 'marketing'] },
      { label: 'Social',         href: '/dashboard/social',      icon: Share2, requiredPerm: 'social.view_insights', keywords: ['instagram', 'facebook', 'pages', 'insights', 'reach', 'publishing', 'meta'] },
      { label: 'Agency',         href: '/dashboard/agency',      icon: LayoutGrid, requiredPerm: 'reports.view', keywords: ['agency dashboard', 'all clients', 'overview', 'spend', 'leads', 'cpl', 'alerts'] },
    ],
  },
  {
    // Everything below is fully functional but rarely (or never yet) used —
    // parked here so the everyday nav stays small. Promote an item back to its
    // topical section the day it earns regular use.
    label: 'Advanced',
    defaultOpen: false,
    items: [
      // ── Occasional work tools ──
      { label: 'My Planner',    href: '/dashboard/workspace',     icon: NotebookPen, keywords: ['workspace', 'todo', 'notes', 'reminders', 'personal'] },
      { label: 'Approvals',     href: '/dashboard/approvals',     icon: ClipboardCheck },
      { label: 'Social Calendar', href: '/dashboard/social-calendar', icon: CalendarDays, requiredPerm: 'social.view', keywords: ['content', 'planner', 'posts', 'instagram', 'social media'] },
      { label: 'Apps Directory', href: '/dashboard/apps',        icon: Blocks, keywords: ['integrations', 'marketplace', 'standard request', 'intake links'] },
      // Offer Flyer editor: FROZEN since the Cirqle Studio Figma plugin became
      // the primary design workflow — adminOnly keeps it off staff nav; the
      // permission is kept so a future unfreeze is a one-line revert.
      { label: 'Offer Intake', href: '/dashboard/offer-prepare', icon: BadgePercent, requiredPerm: 'offer.prepare', adminOnly: true, keywords: ['prepare offer', 'weekly offer', 'sheet', 'whatsapp list', 'supermarket'] },
      // ── Finance, rarely issued ──
      { label: 'Quotations',        href: '/dashboard/quotations', icon: BookOpen, requiredPerm: 'billing.view_quotations' },
      { label: 'Business Partners', href: '/dashboard/partners',   icon: Handshake, requiredPerm: 'finance.partner.view', keywords: ['vendors', 'suppliers'] },
      // ── Recruitment (unused until hiring starts) ──
      { label: 'Open Positions', href: '/dashboard/recruitment/positions',    icon: Briefcase,     requiredPerm: 'recruitment.view' },
      { label: 'Applications',   href: '/dashboard/recruitment/applications', icon: ClipboardList, requiredPerm: 'recruitment.view' },
      { label: 'Interviews',     href: '/dashboard/recruitment/interviews',   icon: CalendarClock, requiredPerm: 'recruitment.view' },
      { label: 'Offers',         href: '/dashboard/recruitment/offers',       icon: BadgeCheck,    requiredPerm: 'recruitment.view' },
      { label: 'Hiring Reports', href: '/dashboard/recruitment/reports',      icon: PieChart,      requiredPerm: 'recruitment.view' },
      // ── Specialist reports ──
      { label: 'Company Operations', href: '/dashboard/reports/company-ops', icon: Building2, requiredPerm: 'reports.view', keywords: ['P&L', 'burn rate', 'runway'] },
      { label: 'Client Profitability', href: '/dashboard/reports/client-profitability', icon: TrendingUp, requiredPerm: 'reports.view', keywords: ['margin', 'finance engine'] },
      { label: 'Cost & Tags', href: '/dashboard/reports/cost-attribution', icon: Tags, requiredPerm: 'reports.view', keywords: ['spend', 'attribution'] },
      { label: 'Client Ranking', href: '/dashboard/clients/ranking', icon: Award, requiredPerm: 'reports.view', keywords: ['reliability', 'scoring'] },
      { label: 'Activity', href: '/dashboard/activity', icon: History, requiredPerm: 'timeline.view_all', keywords: ['timeline', 'audit log'] },
      // ── Admin utilities ──
      // Bulk Import is strictly admin-only — it can mass-create tasks,
      // contributions, and cashbook entries, so it shouldn't surface to
      // non-admin team members who might happen to hold `tasks.create`.
      { label: 'Bulk Import', href: '/dashboard/import',   icon: Upload,   adminOnly: true, keywords: ['csv', 'mass import'] },
      { label: 'Workspaces',  href: '/dashboard/settings/workspaces', icon: LayoutGrid, requiredPerm: 'workspaces.manage', keywords: ['teams'] },
    ],
  },
  {
    label: 'System',
    defaultOpen: false,
    items: [
      { label: 'Settings',    href: '/dashboard/settings', icon: Settings, requiredPerm: 'settings.access' },
    ],
  },
]

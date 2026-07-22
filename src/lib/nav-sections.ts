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
  BadgePercent, FileSignature,
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
      { label: 'Approvals',     href: '/dashboard/approvals',     icon: ClipboardCheck },
      { label: 'Contributions', href: '/dashboard/contributions', icon: TrendingUp },
      { label: 'Workspace',     href: '/dashboard/workspace',     icon: NotebookPen },
      { label: 'Chat',          href: '/dashboard/chat',          icon: MessageSquare, requiredPerm: 'chat.access' },
    ],
  },
  {
    label: 'Finance',
    defaultOpen: true,
    items: [
      { label: 'Quotations',        href: '/dashboard/quotations', icon: BookOpen, requiredPerm: 'billing.view_quotations' },
      // Commercial flow: Quotations → Agreements → Invoices (design §12 #7)
      { label: 'Agreements',        href: '/dashboard/agreements', icon: FileSignature, requiredPerm: 'agreements.view', keywords: ['contract', 'retainer', 'commitment', 'package', 'promised'] },
      { label: 'Invoices',          href: '/dashboard/invoices',   icon: FileText, requiredPerm: 'billing.view_invoices' },
      { label: 'Follow-ups',        href: '/dashboard/invoices/follow-ups', icon: PhoneCall, requiredPerm: 'billing.view_invoices' },
      { label: 'Cash Book',         href: '/dashboard/cashbook',   icon: Wallet,   requiredPerm: 'cashbook.view', keywords: ['expenses', 'bank', 'transactions'] },
      { label: 'Business Partners', href: '/dashboard/partners',   icon: Handshake, requiredPerm: 'finance.partner.view', keywords: ['vendors', 'suppliers'] },
    ],
  },
  {
    label: 'People',
    defaultOpen: false,
    items: [
      { label: 'HR & Payroll',   href: '/dashboard/payroll', icon: Users2, requiredPerm: 'payroll.view', keywords: ['salary', 'payslip', 'employees'] },
      { label: 'Open Positions', href: '/dashboard/recruitment/positions',    icon: Briefcase,     requiredPerm: 'recruitment.view' },
      { label: 'Applications',   href: '/dashboard/recruitment/applications', icon: ClipboardList, requiredPerm: 'recruitment.view' },
      { label: 'Interviews',     href: '/dashboard/recruitment/interviews',   icon: CalendarClock, requiredPerm: 'recruitment.view' },
      { label: 'Offers',         href: '/dashboard/recruitment/offers',       icon: BadgeCheck,    requiredPerm: 'recruitment.view' },
      { label: 'Hiring Reports', href: '/dashboard/recruitment/reports',      icon: PieChart,      requiredPerm: 'recruitment.view' },
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
      // Company Operations: company-scoped P&L + burn rate / runway + scope triage.
      { label: 'Company Operations', href: '/dashboard/reports/company-ops', icon: Building2, requiredPerm: 'reports.view', keywords: ['P&L', 'burn rate', 'runway'] },
      // Client Profitability: per-client contribution margin (Finance Engine).
      { label: 'Client Profitability', href: '/dashboard/reports/client-profitability', icon: TrendingUp, requiredPerm: 'reports.view', keywords: ['margin', 'finance engine'] },
      // Cost & Tags: spend-by-tag + per-employee attributed cost (Finance Engine).
      { label: 'Cost & Tags', href: '/dashboard/reports/cost-attribution', icon: Tags, requiredPerm: 'reports.view', keywords: ['spend', 'attribution'] },
      // Client Ranking: payment reliability + business value scoring per client.
      { label: 'Client Ranking', href: '/dashboard/clients/ranking', icon: Award, requiredPerm: 'reports.view', keywords: ['reliability', 'scoring'] },
      // Business Health Center: cash/collections, overdue aging, client risk, cron status.
      { label: 'Business Health', href: '/dashboard/health', icon: Activity, requiredPerm: 'reports.view', keywords: ['cash flow', 'overdue', 'risk', 'cron'] },
      // What-If Planner: simulate increments / commission / pricing over a period.
      { label: 'What-If Planner', href: '/dashboard/reports/what-if', icon: SlidersHorizontal, requiredPerm: 'reports.view', keywords: ['simulation', 'forecast', 'commission'] },
      // Universal activity timeline — gated by timeline.view_all (migration 014).
      { label: 'Activity', href: '/dashboard/activity', icon: History, requiredPerm: 'timeline.view_all', keywords: ['timeline', 'audit log'] },
    ],
  },
  {
    label: 'Apps',
    defaultOpen: false,
    items: [
      { label: 'Advertising',    href: '/dashboard/advertising', icon: Megaphone, requiredPerm: 'advertising.view', keywords: ['campaigns', 'ads', 'marketing'] },
      // Offer Flyer: internal weekly-offer preparation (paste WhatsApp list →
      // review → designer Google Sheet). Gated by the dedicated offer.prepare
      // permission; admins always see it.
      { label: 'Offer Flyer', href: '/dashboard/offer-prepare', icon: BadgePercent, requiredPerm: 'offer.prepare', keywords: ['prepare offer', 'weekly offer', 'sheet', 'whatsapp list', 'supermarket'] },
      // Social Calendar: plan a client's content month, push items into the
      // Requests inbox (social_meta pattern — see docs in the migration).
      { label: 'Social Calendar', href: '/dashboard/social-calendar', icon: CalendarDays, requiredPerm: 'social.view', keywords: ['content', 'planner', 'posts', 'instagram', 'social media'] },
      { label: 'Apps Directory', href: '/dashboard/apps',        icon: Blocks, keywords: ['integrations', 'marketplace'] },
    ],
  },
  {
    label: 'System',
    defaultOpen: false,
    items: [
      // Bulk Import is strictly admin-only — it can mass-create tasks,
      // contributions, and cashbook entries, so it shouldn't surface to
      // non-admin team members who might happen to hold `tasks.create`.
      { label: 'Bulk Import', href: '/dashboard/import',   icon: Upload,   adminOnly: true, keywords: ['csv', 'mass import'] },
      { label: 'Workspaces',  href: '/dashboard/settings/workspaces', icon: LayoutGrid, requiredPerm: 'workspaces.manage', keywords: ['teams'] },
      { label: 'Settings',    href: '/dashboard/settings', icon: Settings, requiredPerm: 'settings.access' },
    ],
  },
]

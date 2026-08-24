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
  Share2, UserPlus, Gauge, ShieldCheck, Grid3x3, MapPin,
  Scale, Receipt,
  type LucideIcon,
} from 'lucide-react'

export type NavItem = {
  label: string
  href: string
  icon: LucideIcon
  requiredPerm?: string
  /**
   * Visible when the viewer holds ANY of these. Used where one page is reachable
   * under several keys — the financial reports accept their own narrow key OR
   * the older blanket `reports.view`, so splitting that key did not blank the
   * Insights section for anyone who already had it.
   */
  requiredAnyPerm?: string[]
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
  const anyOk = !item.requiredAnyPerm?.length || item.requiredAnyPerm.some(can)
  return (!item.requiredPerm || can(item.requiredPerm)) && anyOk && (!item.adminOnly || isAdmin)
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
 * SECTION DESIGN (2026-08, revised): every item lives in the section named for
 * its FUNCTION — no catch-all. The earlier layout parked eighteen rarely-used
 * items in one flat "Advanced" list, which made the bottom of the sidebar a
 * junk drawer nobody could scan. Instead, rarely-used sections simply default
 * to collapsed (Recruitment, Insights, Tools), so the everyday nav stays short
 * while everything keeps a predictable home.
 *
 * NOTHING is removed — every route stays reachable and every item keeps its
 * permission gate. Daily-use evidence: Work + Finance + HR stay open;
 * Marketing holds the social/content workflow (Social Calendar earned its
 * promotion out of Advanced — it now drives package delivery planning).
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
      { label: 'Statements',        href: '/dashboard/statements', icon: Receipt, requiredPerm: 'billing.view_invoices', keywords: ['statement of account', 'ledger', 'ageing', 'aging', 'balance due', 'outstanding'] },
      // Sits with collections, not in Tools: a partner is a commission-earning
      // intermediary who OWNS clients (partner_code, commission_type/value, and
      // per-partner outstanding/margin rollups), and Follow-ups already offers a
      // "By Business Partner" view. Keywords used to read 'vendors, suppliers' —
      // this app has no vendor concept at all, so search pointed at the wrong
      // kind of entity entirely.
      { label: 'Business Partners', href: '/dashboard/partners',   icon: Handshake, requiredPerm: 'finance.partner.view', keywords: ['commission', 'referral', 'reseller', 'agent', 'partner code', 'BP'] },
      { label: 'Cash Book',         href: '/dashboard/cashbook',   icon: Wallet,   requiredPerm: 'cashbook.view', keywords: ['expenses', 'bank', 'transactions'] },
      { label: 'Recurring',         href: '/dashboard/cashbook/recurring', icon: Repeat, requiredPerm: 'cashbook.view', keywords: ['rent', 'subscription', 'monthly bill', 'repeat', 'standing'] },
      // The monthly control centre: profit composition, payroll status,
      // corrections and the lock action for each financial period.
      { label: 'Months',            href: '/dashboard/finance/months', icon: CalendarRange, requiredPerm: 'payroll.view', keywords: ['financial timeline', 'period', 'close', 'lock', 'profit', 'month end'] },
    ],
  },
  {
    // The social/content workflow, together at last: plan the month, publish,
    // measure, advertise. Social Calendar earned its way out of the old
    // Advanced list — it now plans package deliverables day by day.
    label: 'Marketing',
    defaultOpen: false,
    items: [
      // Order mirrors the workflow: connect once, decide whose each asset is,
      // keep our own separate — then the modules that consume those assets.
      { label: 'Connections',      href: '/dashboard/connections',     icon: Blocks, requiredPerm: 'advertising.manage_providers', keywords: ['integrations', 'meta', 'oauth', 'connect', 'facebook', 'google ads', 'token', 'ad accounts'] },
      { label: 'Asset Assignment', href: '/dashboard/assets',          icon: Building2, requiredPerm: 'assets.assign', keywords: ['assign', 'ownership', 'unassigned', 'pages', 'ad accounts', 'lead forms', 'which client'] },
      { label: 'Cirqle Accounts',  href: '/dashboard/cirqle-accounts', icon: ShieldCheck, requiredPerm: 'assets.view_cirqle', keywords: ['our own', 'agency', 'internal', 'own marketing', 'cirqle owned'] },
      { label: 'Social',           href: '/dashboard/social',          icon: Share2, requiredPerm: 'social.view_insights', keywords: ['instagram', 'facebook', 'pages', 'insights', 'reach', 'publishing', 'meta'] },
      // Sits beside Social Calendar: the calendar answers WHEN, the planner
      // answers HOW THE GRID LOOKS — the two halves of planning a feed.
      { label: 'Feed Planner',     href: '/dashboard/social/feed',     icon: Grid3x3, requiredPerm: 'social.plan_feed', keywords: ['instagram grid', 'feed preview', 'mockup', 'creatives', 'profile', 'aesthetic', 'layout'] },
      { label: 'Social Calendar',  href: '/dashboard/social-calendar', icon: CalendarDays, requiredPerm: 'social.view', keywords: ['content', 'planner', 'posts', 'instagram', 'social media'] },
      { label: 'Leads',            href: '/dashboard/leads',           icon: UserPlus, requiredPerm: 'leads.view', keywords: ['crm', 'meta leads', 'lead ads', 'prospects', 'enquiries'] },
      // Door-to-door / direct marketing: physical prospects on a map, visit
      // tracking, follow-ups — distinct from the Meta-ads Leads CRM above.
      { label: 'Field Marketing',  href: '/dashboard/field-marketing', icon: MapPin, requiredPerm: 'field.view', keywords: ['map', 'territory', 'door to door', 'direct marketing', 'supermarkets', 'shops', 'visits', 'gps', 'route', 'coverage', 'field sales'] },
      { label: 'Advertising',      href: '/dashboard/advertising',     icon: Megaphone, requiredPerm: 'advertising.view', keywords: ['campaigns', 'ads', 'marketing'] },
      { label: 'Agency',           href: '/dashboard/agency',          icon: LayoutGrid, requiredPerm: 'reports.view', keywords: ['agency dashboard', 'all clients', 'overview', 'spend', 'leads', 'cpl', 'alerts'] },
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
    // Hiring pipeline, in process order. Its own section rather than five rows
    // inside HR: it is empty until hiring starts, and collapsed-by-default
    // keeps it from padding a section that IS in daily use.
    label: 'Recruitment',
    defaultOpen: false,
    items: [
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
      { label: 'Reports', href: '/dashboard/reports', icon: BarChart3, requiredAnyPerm: ['reports.view', 'reports.view_company_financials', 'reports.view_client_financials', 'reports.view_people_earnings'] },
      // Contribution Analysis: spreadsheet-style per-task profitability / earnings BI report.
      { label: 'Contribution Analysis', href: '/dashboard/reports/contribution-analysis', icon: Sheet, requiredAnyPerm: ['reports.view_people_earnings', 'reports.view'], keywords: ['spreadsheet', 'earnings', 'BI'] },
      // Earnings by Role: what each ownership "hat" earned (Accounts, HR, CEO
      // Direct) — the split payroll's single ownership_earned figure hides.
      // Rows strip to the viewer's own awards without payroll.view_amounts.
      { label: 'Earnings by Role', href: '/dashboard/reports/role-earnings', icon: HardHat, requiredAnyPerm: ['reports.view_people_earnings', 'reports.view'], keywords: ['hat', 'ownership', 'revenue share', 'accounts', 'HR', 'role label', 'incentive'] },
      // What-If Planner: simulate increments / commission / pricing / roles over a period.
      { label: 'What-If Planner', href: '/dashboard/reports/what-if', icon: SlidersHorizontal, requiredAnyPerm: ['reports.view_people_earnings', 'reports.view'], keywords: ['simulation', 'forecast', 'commission'] },
      // Business Health Center: cash/collections, overdue aging, client risk, cron status.
      { label: 'Business Health', href: '/dashboard/health', icon: Activity, requiredAnyPerm: ['reports.view_company_financials', 'reports.view'], keywords: ['cash flow', 'overdue', 'risk', 'cron'] },
      // Was reachable only by typing the URL — no nav entry and no inbound link
      // anywhere in the app, despite being live and maintained. It surfaces
      // done-but-uninvoiced tasks and invoice/task drift; on the day it was
      // added here it was holding ₹6,400 of uninvoiced work and ₹2,375 of
      // unbilled client expenses that nobody could see.
      { label: 'Billing Reconciliation', href: '/dashboard/reports/reconcile', icon: Scale, requiredAnyPerm: ['reports.view_client_financials', 'reports.view'], keywords: ['unbilled', 'uninvoiced', 'drift', 'missing invoice', 'reconcile'] },
      // ── Specialist reports — every report lives HERE, not scattered ──
      { label: 'Company Operations',   href: '/dashboard/reports/company-ops', icon: Building2, requiredAnyPerm: ['reports.view_company_financials', 'reports.view'], keywords: ['P&L', 'burn rate', 'runway'] },
      { label: 'Client Profitability', href: '/dashboard/reports/client-profitability', icon: TrendingUp, requiredAnyPerm: ['reports.view_client_financials', 'reports.view'], keywords: ['margin', 'finance engine'] },
      { label: 'Cost & Tags',          href: '/dashboard/reports/cost-attribution', icon: Tags, requiredAnyPerm: ['reports.view_company_financials', 'reports.view'], keywords: ['spend', 'attribution'] },
      { label: 'Client Ranking',       href: '/dashboard/clients/ranking', icon: Award, requiredAnyPerm: ['reports.view_client_financials', 'reports.view'], keywords: ['reliability', 'scoring'] },
    ],
  },
  {
    // Occasional utilities and admin plumbing — real features without a weekly
    // rhythm. Collapsed by default; promote anything that earns regular use.
    label: 'Tools',
    defaultOpen: false,
    items: [
      { label: 'My Planner',        href: '/dashboard/workspace',  icon: NotebookPen, keywords: ['workspace', 'todo', 'notes', 'reminders', 'personal'] },
      { label: 'Approvals',         href: '/dashboard/approvals',  icon: ClipboardCheck },
      { label: 'Quotations',        href: '/dashboard/quotations', icon: BookOpen, requiredPerm: 'billing.view_quotations' },
      { label: 'Apps Directory',    href: '/dashboard/apps',       icon: Blocks, keywords: ['integrations', 'marketplace', 'standard request', 'intake links'] },
      // Offer Flyer editor: FROZEN since the Cirqle Studio Figma plugin became
      // the primary design workflow — adminOnly keeps it off staff nav; the
      // permission is kept so a future unfreeze is a one-line revert.
      { label: 'Offer Intake',      href: '/dashboard/offer-prepare', icon: BadgePercent, requiredPerm: 'offer.prepare', adminOnly: true, keywords: ['prepare offer', 'weekly offer', 'sheet', 'whatsapp list', 'supermarket'] },
      { label: 'Activity',          href: '/dashboard/activity',   icon: History, requiredPerm: 'timeline.view_all', keywords: ['timeline', 'audit log'] },
      // Bulk Import is strictly admin-only — it can mass-create tasks,
      // contributions, and cashbook entries, so it shouldn't surface to
      // non-admin team members who might happen to hold `tasks.create`.
      { label: 'Bulk Import',       href: '/dashboard/import',     icon: Upload,   adminOnly: true, keywords: ['csv', 'mass import'] },
    ],
  },
  {
    label: 'System',
    defaultOpen: false,
    items: [
      // A /dashboard/settings/* route — belongs with Settings, not in Tools.
      { label: 'Workspaces',  href: '/dashboard/settings/workspaces', icon: LayoutGrid, requiredPerm: 'workspaces.manage', keywords: ['teams'] },
      { label: 'Settings',    href: '/dashboard/settings', icon: Settings, requiredPerm: 'settings.access' },
    ],
  },
]

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
  Compass, LayoutDashboard, CheckSquare, Users2, FileText, BookOpen, Wallet, BarChart3, Sheet,
  Settings, TrendingUp, Upload, Inbox, PhoneCall, Award, Activity, Blocks, Megaphone, Handshake,
  SlidersHorizontal, MessageSquare, ClipboardCheck, NotebookPen, LayoutGrid,
  Briefcase, ClipboardList, CalendarClock, BadgeCheck, PieChart, Building2, Tags, History, Sparkles,
  CalendarRange, HardHat, Repeat, Package as PackageIcon,
  Share2, UserPlus, Gauge, ShieldCheck, MapPin, Target,
  Scale, Receipt, Images, Wand2,
  Calculator, CreditCard, Landmark, ShoppingBag, Store, Bookmark, Split,
  type LucideIcon,
} from 'lucide-react'
import { unitTeamMayOpen, type UnitLock } from '@/lib/units/access'

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
  /** With adminOnly: also shown to business-unit team members (their own unit's page). */
  unitTeams?: boolean
  /** Extra search terms for the App Launcher (src/components/layout/app-launcher.tsx) — never rendered, only matched against. */
  keywords?: string[]
  /**
   * This page is a TAB of another entry (that entry's href), not a sidebar row
   * of its own. Steps of one job — Cash Book and its Recurring, Card and Bank
   * pages; Invoices, Follow-ups and Statements — used to be separate rows that
   * had to be found one by one. Now the sidebar shows the parent only, and
   * every page of the group carries the same tab bar under its title
   * (components/layout/module-tabs.tsx, rendered by the page Header).
   *
   * Nothing else changes: the item keeps its own permission (canOpenHref still
   * judges the route by it), its search keywords, favourites and Feature Usage.
   * A tab must sit in the same section as its parent (nav-sections.test.ts).
   */
  tabOf?: string
  /** Shorter name on the tab bar, when the sidebar label is too long for a tab. */
  tabLabel?: string
  /**
   * Kept for permissions and search, but not drawn as a sidebar row: the page
   * has a permanent button of its own elsewhere (AI Capture sits in the header
   * of every page), so a row would only be a second copy of it.
   */
  hideInSidebar?: boolean
  /** With hideInSidebar: where to find the page instead, in words (Feature Usage's "how to start"). */
  foundAt?: string
}
export type NavSection = {
  label?: string
  items: NavItem[]
  /** First-run accordion state for labeled sections (user toggles persist over this). */
  defaultOpen?: boolean
}

/** Permission/admin gate shared by every navSections consumer (Sidebar, App Launcher, Command Palette). */
export function isNavItemVisible(item: NavItem, can: (key: string) => boolean, isAdmin: boolean, unitOnly: UnitLock = false): boolean {
  // A business-unit team member sees only the unit-team pages; unit staff an
  // even shorter list (lib/units/access).
  if (unitOnly && !isAdmin && !unitTeamMayOpen(item.href, unitOnly)) return false
  const anyOk = !item.requiredAnyPerm?.length || item.requiredAnyPerm.some(can)
  return (!item.requiredPerm || can(item.requiredPerm)) && anyOk
    // Unit staff (own work only) do not get the unit pages in their menus.
    && (!item.adminOnly || isAdmin || (!!item.unitTeams && unitOnly === true))
}

/**
 * Most-specific matching nav href for the current pathname, so a parent
 * ("Invoices") doesn't light up when a child route ("Invoices › Follow-ups")
 * is active. Shared by Sidebar and App Launcher so both highlight the same
 * page the same way.
 */
/**
 * Would the dashboard layout let this user open `href`? This IS the rule the
 * layout's denied-route guard applies (the layout calls it), so a link or
 * button gated on it can never lead somewhere that silently bounces the user
 * back to /dashboard. Query strings and hashes are ignored. Routes outside
 * the sidebar, and /dashboard itself, are left to their own page checks.
 */
export function canOpenHref(href: string, can: (key: string) => boolean, isAdmin: boolean, unitOnly: UnitLock = false): boolean {
  const path = href.split(/[?#]/)[0]
  if (unitOnly && !isAdmin && !unitTeamMayOpen(path, unitOnly)) return false
  const active = resolveActiveHref(navSections, path)
  if (!active || active === '/dashboard') return true
  const item = navSections.flatMap(s => s.items).find(i => i.href === active)
  return !item || isNavItemVisible(item, can, isAdmin, unitOnly)
}

export function resolveActiveHref(sections: { items: NavItem[] }[], pathname: string): string | null {
  const candidates = sections
    .flatMap(s => s.items.map(i => i.href))
    .filter(h => pathname === h || (h !== '/dashboard' && pathname.startsWith(h + '/')))
  if (candidates.length === 0) return null
  return candidates.reduce((a, b) => (b.length > a.length ? b : a))
}

/** One sidebar row: an entry that is not a tab, standing for its whole tab group. */
export type NavRow = {
  /** The group's parent href — what a page's tabOf points at. */
  key: string
  /** What the row shows and opens: the parent, or — when the viewer may not
   *  open the parent — the first tab they can, so a permission held on one
   *  tab alone never hides the page. */
  item: NavItem
  /** Every item of the group the viewer may see, parent first, in list order. */
  members: NavItem[]
}

/**
 * The rows of one section, for the sidebar and the App Launcher: tabs fold
 * into their parent's row, `hideInSidebar` items are left out. `isShown` is
 * the caller's gate (permissions, plus the workspace filter in the sidebar).
 */
export function buildNavRows(items: NavItem[], isShown: (item: NavItem) => boolean): NavRow[] {
  const rows: NavRow[] = []
  for (const item of items) {
    if (item.tabOf || item.hideInSidebar) continue
    const members = [item, ...items.filter(i => i.tabOf === item.href)].filter(isShown)
    if (members.length > 0) rows.push({ key: item.href, item: members[0], members })
  }
  return rows
}

/**
 * The row key (parent href) of the page at `pathname` — what the sidebar
 * lights up. A tab page lights its parent's row. Null outside the sidebar.
 */
export function activeRowKey(pathname: string, sections: NavSection[] = navSections): string | null {
  const path = pathname.split(/[?#]/)[0]
  const active = resolveActiveHref(sections, path)
  if (!active) {
    const alias = NAV_ALIASES.find(a => path === a.prefix || path.startsWith(`${a.prefix}/`))
    return alias && sections.some(s => s.items.some(i => i.href === alias.href)) ? alias.href : null
  }
  const item = sections.flatMap(s => s.items).find(i => i.href === active)
  return item?.tabOf ?? active
}

/**
 * Pages outside the sidebar that belong to one of its rows. The Social tabs
 * (To Post, Compose, Comments, Feed, Insights) live under /dashboard/social
 * while the one Social row points at the plan — without this, nothing in the
 * sidebar lit up on five of Social's seven pages. Feature Usage counts visits
 * the same way (lib/feature-usage/catalogue.ts).
 */
export const NAV_ALIASES: readonly { prefix: string; href: string }[] = [
  { prefix: '/dashboard/social', href: '/dashboard/social-calendar' },
]

/**
 * The tab group of the page at `pathname`: the parent first, then its tabs
 * in list order — all of them, unfiltered. Null when the page belongs to no
 * group. Query strings and hashes are ignored.
 */
export function tabGroupFor(pathname: string, sections: NavSection[] = navSections): NavItem[] | null {
  const path = pathname.split(/[?#]/)[0]
  const items = sections.flatMap(s => s.items)
  const active = resolveActiveHref(sections, path)
  const item = active ? items.find(i => i.href === active) : undefined
  if (!item) return null
  const parentHref = item.tabOf ?? item.href
  const tabs = items.filter(i => i.tabOf === parentHref)
  if (tabs.length === 0) return null
  const parent = items.find(i => i.href === parentHref)
  return parent ? [parent, ...tabs] : tabs
}

/**
 * SECTION DESIGN (2026-11, tidy-up). Two rules:
 *
 * 1. Every page lives in the section named for its FUNCTION. Approvals and My
 *    Planner are daily work, not "Tools"; Quotations is selling, not a tool;
 *    Memoura's Orders and Shop are sales, not marketing; Billing
 *    Reconciliation is invoicing, not a report; Feature Usage is about the
 *    app, so it sits with the app's own settings.
 *
 * 2. Steps of ONE job are one row with tabs (`tabOf`), not one row each.
 *    Cash Book was four rows, Invoices three, Recruitment five, the reports
 *    fourteen. The sidebar went from 63 rows to 37 (65 pages: two reports that
 *    had no entry gained one); every page is one row plus at most one tab away,
 *    and keeps its route and permission.
 *
 * NOTHING is removed — every route stays reachable and every item keeps its
 * permission gate (canOpenHref judges each page by its own item, tab or not).
 * Order matters in one place: a person without dashboard.view lands on the
 * first item they may open (dashboard/page.tsx), so the Work section opens
 * with My Work, Requests and Tasks.
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
      // First in the section for the people who hold it: a designer's whole
      // job lives here, and requests.work_own is granted to nobody who also
      // has the inbox, so this never doubles up with Requests below.
      { label: 'My Work',       href: '/dashboard/my-work',       icon: ClipboardCheck, requiredAnyPerm: ['requests.work_own', 'requests.manage'], keywords: ['my tasks', 'pending', 'assigned to me', 'board', 'todo', 'team work', 'move for'] },
      // What one department delivered for each client this month, to share
      // with that team — the manager's side of My Work. Counts only.
      { label: 'Team Work Report', tabLabel: 'Team report', href: '/dashboard/reports/team-work', tabOf: '/dashboard/my-work', icon: Users2, requiredAnyPerm: ['requests.manage', 'reports.view'], keywords: ['monthly', 'social media', 'department', 'delivered', 'done', 'motivate', 'team', 'whatsapp', 'per client', 'output'] },
      { label: 'Requests',      href: '/dashboard/requests',      icon: Inbox, requiredPerm: 'requests.view' },
      { label: 'Tasks',         href: '/dashboard/tasks',         icon: CheckSquare },
      // Weekly use (catalogue.ts) — it sat in the collapsed Tools section.
      { label: 'Approvals',     href: '/dashboard/approvals',     icon: BadgeCheck, keywords: ['approve', 'reject', 'awaiting me', 'sign off'] },
      { label: 'Clients',       href: '/dashboard/clients',       icon: Building2, requiredPerm: 'clients.view' },
      // Any rung of the contributions ladder opens the page; the page strips
      // the rows to what that rung allows.
      { label: 'Contributions', href: '/dashboard/contributions', icon: TrendingUp,
        requiredAnyPerm: ['contributions.view_own', 'contributions.view_unit', 'contributions.view_all'] },
      { label: 'Chat',          href: '/dashboard/chat',          icon: MessageSquare, requiredPerm: 'chat.access' },
      { label: 'My Planner',    href: '/dashboard/workspace',     icon: NotebookPen, keywords: ['workspace', 'todo', 'to-do', 'notes', 'personal'] },
      // The header's AI Capture button is on every page, so a row here was a
      // second copy of it. Kept for its permission and for search.
      { label: 'AI Capture',    href: '/dashboard/capture',       icon: Sparkles, requiredPerm: 'capture.use', hideInSidebar: true, foundAt: 'Tap AI Capture at the top of any page', keywords: ['quick capture', 'paste', 'whatsapp', 'email', 'offer flyer'] },
    ],
  },
  {
    // Selling and getting paid: quote → package → invoice → collect.
    label: 'Sales',
    defaultOpen: true,
    items: [
      { label: 'Quotations',        href: '/dashboard/quotations', icon: BookOpen, requiredPerm: 'billing.view_quotations', keywords: ['quote', 'proposal', 'estimate'] },
      { label: 'Quote Planner',     tabLabel: 'Planner', href: '/dashboard/quote-planner', tabOf: '/dashboard/quotations', icon: Calculator, requiredPerm: 'quote_planner.view', keywords: ['quote', 'quotation', 'proposal', 'pricing', 'margin', 'estimate', 'package price', 'what will we earn'] },
      { label: 'Packages',          href: '/dashboard/packages',   icon: PackageIcon, requiredPerm: 'packages.view', keywords: ['agreement', 'retainer', 'commitment', 'bundle', 'committed', 'promised'] },
      { label: 'Invoices',          href: '/dashboard/invoices',   icon: FileText, requiredPerm: 'billing.view_invoices' },
      { label: 'Follow-ups',        href: '/dashboard/invoices/follow-ups', tabOf: '/dashboard/invoices', icon: PhoneCall, requiredPerm: 'billing.view_invoices', keywords: ['collections', 'chase', 'overdue', 'unpaid', 'reminder'] },
      { label: 'Statements',        href: '/dashboard/statements', tabOf: '/dashboard/invoices', icon: Receipt, requiredPerm: 'billing.view_invoices', keywords: ['statement of account', 'ledger', 'ageing', 'aging', 'balance due', 'outstanding'] },
      // Done-but-uninvoiced tasks and invoice/task drift: invoicing work, so it
      // sits with Invoices rather than among the reports.
      { label: 'Unbilled Work', tabLabel: 'Unbilled work', href: '/dashboard/reports/reconcile', tabOf: '/dashboard/invoices', icon: Scale, requiredAnyPerm: ['reports.view_client_financials', 'reports.view'], keywords: ['unbilled', 'uninvoiced', 'drift', 'missing invoice', 'reconcile', 'not billed', 'billing reconciliation'] },
      // A partner is a commission-earning intermediary who OWNS clients, and
      // Follow-ups already offers a "By Business Partner" view.
      { label: 'Business Partners', href: '/dashboard/partners',   icon: Handshake, requiredPerm: 'finance.partner.view', keywords: ['commission', 'referral', 'reseller', 'agent', 'partner code', 'BP'] },
      // Retail orders for Cirqle's own product brands (Memoura gifts). Buyers
      // are the public, not clients, so this is its own list, not a client view.
      { label: 'Orders',            href: '/dashboard/orders',     icon: ShoppingBag, requiredPerm: 'orders.view', keywords: ['memoura', 'gifts', 'shop', 'customers', 'dispatch', 'courier', 'tracking', 'advance', 'balance', 'retail'] },
      // What the Memoura website sells and announces: gifts on/off, banner, prices, delivery.
      { label: 'Shop Settings',     tabLabel: 'Shop settings', href: '/dashboard/shop', tabOf: '/dashboard/orders', icon: Store, requiredPerm: 'orders.view', keywords: ['shop', 'memoura', 'gifts', 'products', 'catalogue', 'banner', 'offer', 'prices', 'delivery charge', 'website', 'highlight', 'print sizes'] },
    ],
  },
  {
    // The books: money in and out, month end, and how profit is shared.
    label: 'Finance',
    defaultOpen: true,
    items: [
      { label: 'Cash Book',         tabLabel: 'Entries', href: '/dashboard/cashbook', icon: Wallet, requiredPerm: 'cashbook.view', keywords: ['expenses', 'bank', 'transactions'] },
      { label: 'Recurring',         href: '/dashboard/cashbook/recurring', tabOf: '/dashboard/cashbook', icon: Repeat, requiredPerm: 'cashbook.view', keywords: ['rent', 'subscription', 'monthly bill', 'repeat', 'standing'] },
      { label: 'Card Statements',   tabLabel: 'Cards', href: '/dashboard/cashbook/cards', tabOf: '/dashboard/cashbook', icon: CreditCard, requiredPerm: 'card_reconciliation.view', keywords: ['credit card', 'statement', 'reconcile', 'reconciliation', 'billing cycle', 'card bill'] },
      { label: 'Bank Reconciliation', tabLabel: 'Bank', href: '/dashboard/cashbook/bank', tabOf: '/dashboard/cashbook', icon: Landmark, requiredPerm: 'bank_reconciliation.view', keywords: ['bank statement', 'reconcile', 'reconciliation', 'mismatch', 'missing entries', 'unmatched', 'passbook', 'balance', 'import statement', 'pdf statement'] },
      // The monthly control centre: profit composition, payroll status,
      // corrections and the lock action for each financial period.
      { label: 'Months',            href: '/dashboard/finance/months', icon: CalendarRange, requiredPerm: 'payroll.view', keywords: ['financial timeline', 'period', 'close', 'lock', 'profit', 'month end'] },
      // Admin only in this release: company cash profit, capital and every
      // investor's share. The route and every action re-check isAdmin.
      { label: 'Profit Sharing',    href: '/dashboard/finance/profit-sharing', icon: PieChart, requiredPerm: 'profit_sharing.view', adminOnly: true, keywords: ['capital', 'investment', 'investor', 'founder', 'profit share', 'dividend', 'reserve', 'entitlement', 'payout', 'device'] },
      // Cirqle's departments and sub-brands (units): their teams, optional
      // profit-and-loss agreements, own invoices and Cash Book, and a Focus
      // mode for meetings. Admins manage them; a unit's team sees only its own
      // unit here. Pages and actions re-check all of this.
      { label: 'Departments & Brands', href: '/dashboard/units', icon: Split, adminOnly: true, unitTeams: true, keywords: ['department', 'brand', 'unit', 'team', 'profit share', 'agreement', 'partnership', 'focus mode', 'social media team', 'cirqle flyers', 'memoura', 'split', 'general costs', 'p&l'] },
    ],
  },
  {
    // The social/content workflow: plan the month, publish, measure, advertise.
    label: 'Marketing',
    defaultOpen: false,
    items: [
      // Start here: pick a client, and their Pages, campaigns, content and
      // leads are all in one hub (/dashboard/marketing/[clientId]). Visible to
      // anyone who holds any one marketing module; each tab keeps its own gate.
      { label: 'Clients Hub',      tabLabel: 'Clients', href: '/dashboard/marketing', icon: Target, requiredAnyPerm: ['social.view', 'social.view_insights', 'advertising.view', 'leads.view', 'assets.assign'], keywords: ['marketing', 'client marketing', 'pages', 'campaigns', 'content', 'leads', 'one place', 'client hub'] },
      // The same clients, all at once: totals, alerts and AI insights. It was
      // a row of its own ("Agency") showing what the hub's cards show.
      { label: 'All-client Performance', tabLabel: 'All-client performance', href: '/dashboard/agency', tabOf: '/dashboard/marketing', icon: LayoutGrid, requiredPerm: 'reports.view', keywords: ['agency dashboard', 'all clients', 'overview', 'spend', 'leads', 'cpl', 'alerts'] },
      // ONE entry for the whole Instagram/Facebook workflow; its pages share a
      // tab bar (components/social-hub/social-tabs).
      { label: 'Social',           href: '/dashboard/social-calendar', icon: Share2, requiredPerm: 'social.view', keywords: ['content', 'planner', 'posts', 'instagram', 'facebook', 'calendar', 'publish', 'schedule', 'comments', 'inbox', 'reply', 'feed', 'grid', 'insights', 'reach', 'to post', 'caption', 'hashtags', 'stories', 'reels'] },
      { label: 'Advertising',      tabLabel: 'Campaigns', href: '/dashboard/advertising', icon: Megaphone, requiredPerm: 'advertising.view', keywords: ['campaigns', 'ads', 'marketing'] },
      // Swipe file of ads saved from the Facebook Ad Library with the Cirqle Ad Saver Chrome extension.
      { label: 'Ad Library',       href: '/dashboard/ad-library', tabOf: '/dashboard/advertising', icon: Bookmark, requiredPerm: 'advertising.view', keywords: ['swipe file', 'competitor ads', 'facebook ad library', 'meta ads library', 'inspiration', 'saved ads', 'chrome extension', 'ad spy', 'creatives'] },
      { label: 'Leads',            href: '/dashboard/leads',           icon: UserPlus, requiredPerm: 'leads.view', keywords: ['crm', 'meta leads', 'lead ads', 'prospects', 'enquiries'] },
      { label: 'Prompt Studio',    href: '/dashboard/prompt-studio',   icon: Wand2, requiredPerm: 'prompt_studio.view', keywords: ['prompt', 'ai video', 'veo', 'kling', 'script', 'voiceover', 'music', 'client card', 'template', 'film', 'series', 'product video', 'reel'] },
      // Publishes straight to cirqle.work — the site reads this content from a
      // separate Supabase project, so nothing here touches business data.
      { label: 'Portfolio',        href: '/dashboard/portfolio',       icon: Images, requiredPerm: 'portfolio.view', keywords: ['website', 'work', 'gallery', 'creatives', 'showcase', 'cirqle.work', 'case studies', 'brands', 'social media posts', 'upload work'] },
      // Door-to-door / direct marketing: physical prospects on a map, visit
      // tracking, follow-ups — distinct from the Meta-ads Leads CRM above.
      { label: 'Field Marketing',  href: '/dashboard/field-marketing', icon: MapPin, requiredPerm: 'field.view', keywords: ['map', 'territory', 'door to door', 'direct marketing', 'supermarkets', 'shops', 'visits', 'gps', 'route', 'coverage', 'field sales'] },
      // Setup, done once per account — last, so the daily tools come first.
      // Connecting accounts, saying whose each one is, and Cirqle's own: one job.
      { label: 'Connections',      href: '/dashboard/connections',     icon: Blocks, requiredPerm: 'advertising.manage_providers', keywords: ['integrations', 'meta', 'oauth', 'connect', 'facebook', 'google ads', 'token', 'ad accounts'] },
      { label: 'Asset Assignment', href: '/dashboard/assets', tabOf: '/dashboard/connections', icon: Building2, requiredPerm: 'assets.assign', keywords: ['assign', 'ownership', 'unassigned', 'pages', 'ad accounts', 'lead forms', 'which client'] },
      { label: 'Cirqle Brands',    href: '/dashboard/cirqle-accounts', tabOf: '/dashboard/connections', icon: ShieldCheck, requiredPerm: 'assets.view_cirqle', keywords: ['our own', 'agency', 'internal', 'own marketing', 'cirqle owned', 'brands', 'sub-brand', 'cirqle accounts', 'flyers', 'memoura'] },
    ],
  },
  {
    label: 'People',
    defaultOpen: false,
    items: [
      { label: 'HR & Payroll', href: '/dashboard/payroll',     icon: Users2, requiredPerm: 'payroll.view', keywords: ['salary', 'payslip', 'employees', 'hr'] },
      // Performance Scorecards: score employees & applicants, apply ratings.
      { label: 'Performance',  href: '/dashboard/performance', icon: Gauge, requiredPerm: 'performance.manage', keywords: ['scorecard', 'rating', 'appraisal', 'review', 'applicant', 'cv', 'measure'] },
      // The hiring pipeline, one row, its steps as tabs in process order.
      { label: 'Recruitment',    tabLabel: 'Open positions', href: '/dashboard/recruitment/positions', icon: Briefcase, requiredPerm: 'recruitment.view', keywords: ['hiring', 'jobs', 'vacancy', 'open positions'] },
      { label: 'Applications',   href: '/dashboard/recruitment/applications', tabOf: '/dashboard/recruitment/positions', icon: ClipboardList, requiredPerm: 'recruitment.view', keywords: ['applicants', 'cv', 'candidates'] },
      { label: 'Interviews',     href: '/dashboard/recruitment/interviews',   tabOf: '/dashboard/recruitment/positions', icon: CalendarClock, requiredPerm: 'recruitment.view' },
      { label: 'Offers',         href: '/dashboard/recruitment/offers',       tabOf: '/dashboard/recruitment/positions', icon: BadgeCheck,    requiredPerm: 'recruitment.view' },
      { label: 'Hiring Reports', tabLabel: 'Reports', href: '/dashboard/recruitment/reports', tabOf: '/dashboard/recruitment/positions', icon: PieChart, requiredPerm: 'recruitment.view' },
    ],
  },
  {
    // Every report lives here, three rows by what it is about. The financial
    // reports accept their own narrow key OR the older blanket reports.view.
    label: 'Insights',
    defaultOpen: false,
    items: [
      // The business as a whole.
      { label: 'Business Health', tabLabel: 'Health', href: '/dashboard/health', icon: Activity, requiredAnyPerm: ['reports.view_company_financials', 'reports.view'], keywords: ['cash flow', 'overdue', 'risk', 'cron', 'business reports'] },
      { label: 'Company Operations', tabLabel: 'Operations', href: '/dashboard/reports/company-ops', tabOf: '/dashboard/health', icon: Building2, requiredAnyPerm: ['reports.view_company_financials', 'reports.view'], keywords: ['P&L', 'burn rate', 'runway'] },
      { label: 'Cost & Tags',     href: '/dashboard/reports/cost-attribution', tabOf: '/dashboard/health', icon: Tags, requiredAnyPerm: ['reports.view_company_financials', 'reports.view'], keywords: ['spend', 'attribution'] },
      // Each department's profit and loss, and its growth over time — one
      // dataset in two views. Neither had a menu entry: they were reachable
      // only from the dashboard panel and a link row on the reports page.
      // Gates are the pages' own (department-pnl / department-growth page.tsx).
      { label: 'Department P&L',  href: '/dashboard/reports/department-pnl', tabOf: '/dashboard/health', icon: Split, requiredAnyPerm: ['reports.view_company_financials', 'reports.view'], keywords: ['department profit', 'department p&l', 'service category', 'who earned what'] },
      { label: 'Department Growth', href: '/dashboard/reports/department-growth', tabOf: '/dashboard/health', icon: TrendingUp, requiredAnyPerm: ['reports.view_client_financials', 'reports.view'], keywords: ['departments', 'discipline', 'growth', 'department cards'] },
      // Clients: volume and trend, margin, reliability.
      { label: 'Client Reports', tabLabel: 'Analytics', href: '/dashboard/client-analytics', icon: BarChart3, requiredAnyPerm: ['reports.view_client_financials', 'reports.view'], keywords: ['client analytics', 'per client', 'trend', 'compare', 'month', 'week', 'quarter', 'year', 'growth', 'chart', 'graph', 'how is this client doing'] },
      { label: 'Client Profitability', tabLabel: 'Profitability', href: '/dashboard/reports/client-profitability', tabOf: '/dashboard/client-analytics', icon: TrendingUp, requiredAnyPerm: ['reports.view_client_financials', 'reports.view'], keywords: ['margin', 'finance engine'] },
      // The page itself accepts reports.view only (clients/ranking/page.tsx),
      // so the menu asks the same — it used to offer the page to holders of
      // reports.view_client_financials, who were then bounced.
      { label: 'Client Ranking', tabLabel: 'Ranking', href: '/dashboard/clients/ranking', tabOf: '/dashboard/client-analytics', icon: Award, requiredPerm: 'reports.view', keywords: ['reliability', 'scoring'] },
      // The team: what people did and earned. /dashboard/reports itself is the
      // employee performance report (not a hub), hence its name here.
      { label: 'Team Performance', tabLabel: 'Performance', href: '/dashboard/reports', icon: Sheet, requiredAnyPerm: ['reports.view', 'reports.view_company_financials', 'reports.view_client_financials', 'reports.view_people_earnings'], keywords: ['reports', 'employee performance', 'team reports'] },
      // Spreadsheet-style per-task profitability / earnings BI report.
      { label: 'Contribution Analysis', tabLabel: 'Contribution analysis', href: '/dashboard/reports/contribution-analysis', tabOf: '/dashboard/reports', icon: Sheet, requiredAnyPerm: ['reports.view_people_earnings', 'reports.view'], keywords: ['spreadsheet', 'earnings', 'BI'] },
      // What each ownership "hat" earned (Accounts, HR, CEO Direct). Rows strip
      // to the viewer's own awards without payroll.view_amounts.
      { label: 'Earnings by Role', href: '/dashboard/reports/role-earnings', tabOf: '/dashboard/reports', icon: HardHat, requiredAnyPerm: ['reports.view_people_earnings', 'reports.view'], keywords: ['hat', 'ownership', 'revenue share', 'accounts', 'HR', 'role label', 'incentive'] },
      // Simulate increments / commission / pricing / roles over a period.
      { label: 'What-If Planner', tabLabel: 'What-if', href: '/dashboard/reports/what-if', tabOf: '/dashboard/reports', icon: SlidersHorizontal, requiredAnyPerm: ['reports.view_people_earnings', 'reports.view'], keywords: ['simulation', 'forecast', 'commission'] },
    ],
  },
  {
    // Setting the app up and looking after it — collapsed; nobody needs it daily.
    label: 'Admin',
    defaultOpen: false,
    items: [
      { label: 'Settings',    href: '/dashboard/settings', icon: Settings, requiredPerm: 'settings.access' },
      // Opened from the sidebar's workspace switcher ("My workspaces" /
      // "Manage workspaces"), Settings and search, so it needs no row. No
      // permission: every employee designs their own personal workspaces
      // there (the page scopes itself, settings/workspaces/page.tsx). The old
      // workspaces.manage gate here bounced non-managers from their own page
      // whenever the layout guard saw the real path.
      { label: 'Workspaces',  href: '/dashboard/settings/workspaces', icon: LayoutGrid, hideInSidebar: true, foundAt: 'Open the workspace menu at the top of the sidebar → My workspaces', keywords: ['teams', 'workspace', 'my workspaces'] },
      { label: 'Activity',    href: '/dashboard/activity',   icon: History, requiredPerm: 'timeline.view_all', keywords: ['timeline', 'audit log'] },
      // Which features nobody (or one person) uses, what each is for and how
      // to start it — about the app itself, so it sits with Settings. Built
      // from this very list (lib/feature-usage/catalogue.ts). Admin only.
      { label: 'Feature Usage', href: '/dashboard/reports/feature-usage', icon: Compass, adminOnly: true, keywords: ['unused', 'never used', 'adoption', 'how to use', 'features', 'training', 'who uses', 'not using'] },
      { label: 'Apps Directory', href: '/dashboard/apps',    icon: Blocks, keywords: ['integrations', 'marketplace', 'standard request', 'intake links', 'portals'] },
      // Strictly admin-only — it can mass-create tasks, contributions, and
      // cashbook entries.
      { label: 'Bulk Import', href: '/dashboard/import',     icon: Upload,   adminOnly: true, keywords: ['csv', 'mass import'] },
    ],
  },
]

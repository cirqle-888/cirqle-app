/**
 * The page Header's breadcrumb trail (components/layout/header.tsx), as pure
 * data so it can be tested against the app's real routes (breadcrumbs.test.ts).
 */
import { navSections } from '@/lib/nav-sections'

export type Crumb = { label: string; href: string; isLast: boolean }

/** Folder names that are not in the sidebar under their own href. */
const ROUTE_LABELS: Record<string, string> = {
  'prompt-studio': 'Prompt Studio',
  dashboard:     'Dashboard',
  tasks:         'Tasks',
  contributions: 'Contributions',
  invoices:      'Invoices',
  packages:      'Packages',
  connections:   'Connections',
  feed:          'Feed Planner',
  assets:        'Asset Assignment',
  marketing:     'Marketing',
  'cirqle-accounts': 'Cirqle Brands',
  portfolio:     'Website Portfolio',
  quotations:    'Quotations',
  cashbook:      'Cash Book',
  recurring:     'Recurring Expenses',
  clients:       'Clients',
  ranking:       'Client Ranking',
  capture:       'AI Capture',
  'pricing-matrix': 'Pricing Matrix',
  'quote-planner': 'Quote Planner',
  'client-analytics': 'Client Analytics',
  partners:      'Business Partners',
  payroll:       'HR & Payroll',
  reports:       'Reports',
  workspace:     'My Planner',
  'role-earnings': 'Earnings by Role',
  import:        'Bulk Import',
  settings:      'Settings',
  finance:       'Finance',
  'profit-sharing': 'Profit Sharing',
  units:         'Departments & Brands',
  investors:     'Investors & Capital',
  periods:       'Profit Periods',
  departments:   'Departments',
  settlements:   'Settlements',
  devices:       'Device Valuation',
  history:       'Audit History',
  health:        'Business Health',
  social:        'Social',
  employees:     'Employees',
  whatsapp:      'WhatsApp',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Breadcrumb levels that are folders, not pages. They used to be links to a
 * 404 ("Finance" above Months and Profit Sharing); now they are left out.
 * breadcrumbs.test.ts fails when a folder without a page is not listed here
 * or in CRUMB_REDIRECTS.
 */
export const NO_PAGE: readonly RegExp[] = [
  /^\/dashboard\/admin$/,
  /^\/dashboard\/finance$/,
  /^\/dashboard\/connections\/[^/]+$/,
  /^\/dashboard\/portfolio\/presentation(\/[^/]+)?$/,
]

/** Folders with no page whose crumb still has an obvious home to point at. */
export const CRUMB_REDIRECTS: Readonly<Record<string, string>> = {
  '/dashboard/social/accounts': '/dashboard/social',
  '/dashboard/advertising/clients': '/dashboard/advertising',
  '/dashboard/advertising/campaigns': '/dashboard/advertising',
  '/dashboard/employees': '/dashboard/payroll',
}

/**
 * The sidebar's own names win, so a crumb reads exactly like the menu it came
 * from ("What-If Planner", not "What-if"; "Bank Reconciliation", not "Bank").
 */
let navLabels: Record<string, string> | null = null
function navLabel(href: string): string | undefined {
  navLabels ??= Object.fromEntries(navSections.flatMap(s => s.items).map(i => [i.href, i.label]))
  return navLabels[href]
}

export function crumbsFor(pathname: string, crumbLabel?: string): Crumb[] {
  // e.g. /dashboard/tasks  →  ['dashboard', 'tasks']
  const segments = pathname.split('/').filter(Boolean)
  const out: Crumb[] = []
  segments.forEach((seg, i) => {
    const isLast = i === segments.length - 1
    const href = '/' + segments.slice(0, i + 1).join('/')
    // The trail starts with a Home icon, which IS the dashboard — a
    // "Dashboard" crumb beside it said the same thing twice. Without it a
    // top-level page has a one-crumb trail, which the Header leaves out: the
    // sidebar already shows where you are, and the title says it.
    if (href === '/dashboard') return
    if (!isLast && !CRUMB_REDIRECTS[href] && NO_PAGE.some(re => re.test(href))) return
    const label = isLast && crumbLabel
      ? crumbLabel
      : navLabel(href)
        ?? (UUID_RE.test(seg) ? 'Details'                // never print a raw record id
        : ROUTE_LABELS[seg] ?? (seg.charAt(0).toUpperCase() + seg.slice(1)).replace(/-/g, ' '))
    out.push({ label, href: CRUMB_REDIRECTS[href] ?? href, isLast })
  })
  return followTheSidebar(out)
}

/**
 * A URL's folders are not always where the page lives in the sidebar. Every
 * report sits under /dashboard/reports, which is Team Performance — but
 * Feature Usage belongs to Admin and Department Growth to Business Health.
 * So: a tab page's crumb is preceded by its own module, and a page from
 * another sidebar section drops the folder it happens to live in.
 */
function followTheSidebar(crumbs: Crumb[]): Crumb[] {
  const items = navSections.flatMap(s => s.items)
  const itemOf = (href: string) => items.find(i => i.href === href)
  const sectionOf = (href: string) => navSections.find(s => s.items.some(i => i.href === href))
  const out = [...crumbs]
  for (let i = 1; i < out.length; i++) {
    const page = itemOf(out[i].href)
    const folder = itemOf(out[i - 1].href)
    if (!page || !folder) continue
    if (page.tabOf) {
      const parent = itemOf(page.tabOf)
      if (parent && folder.href !== parent.href) out[i - 1] = { label: parent.label, href: parent.href, isLast: false }
    } else if (sectionOf(folder.href) !== sectionOf(page.href)) {
      out.splice(i - 1, 1)
      i--
    }
  }
  return out
}

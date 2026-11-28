/**
 * The feature catalogue behind Insights → Feature Usage.
 *
 * WHERE THE LIST COMES FROM: the sidebar (`navSections`). Every sidebar item is
 * a feature, with the same permission gate the sidebar uses, so a page added to
 * the sidebar shows up in the report on its own. This file only adds the words:
 * a one-line "what it's for", a short "how to start" (where to tap, first
 * step), and how often the feature is meant to be used.
 *
 * A sidebar item with no entry below still appears, with a plain fallback
 * ("Open Finance → X in the sidebar."). catalogue.test.ts names any such item,
 * so whoever adds a page is asked for its two lines.
 *
 * Keep both lines short and concrete. They are read by someone who has never
 * opened the page.
 */
import { navSections, resolveActiveHref, type NavItem, type NavSection } from '@/lib/nav-sections'

/**
 * How often a feature is meant to be used. Decides what "used well" means:
 * a daily tool used once a month is under-used; a month-end tool used once a
 * month is used exactly as intended.
 */
export type Rhythm = 'daily' | 'weekly' | 'monthly' | 'occasional'

export const RHYTHM_LABEL: Record<Rhythm, string> = {
  daily: 'Meant for every day',
  weekly: 'Meant for every week',
  monthly: 'Meant for every month',
  occasional: 'Set up once, or when needed',
}

export interface FeatureGuide {
  /** One line: what this feature is for. */
  what: string
  /** Where to tap and the first thing to do. */
  start: string
  rhythm: Rhythm
}

/** A sidebar item as the report sees it. Plain data, safe to send to the browser. */
export interface Feature extends FeatureGuide {
  href: string
  label: string
  /** Sidebar section, e.g. "Finance". "Home" for the unlabeled first section. */
  section: string
  /** Position in the sidebar, for a stable order everywhere. */
  order: number
  /** False when the words are the fallback because no entry exists below. */
  described: boolean
  // The sidebar's own gate, copied so the report can decide who may open it.
  requiredPerm?: string
  requiredAnyPerm?: string[]
  adminOnly?: boolean
}

export const FEATURE_GUIDES: Record<string, FeatureGuide> = {
  // ── Home ──────────────────────────────────────────────────────────────────
  '/dashboard': { rhythm: 'daily',
    what: 'Your day at a glance: money in and out, work due, and alerts.',
    start: 'Tap Dashboard at the top of the sidebar and read the cards at the top.' },

  // ── Work ──────────────────────────────────────────────────────────────────
  '/dashboard/capture': { rhythm: 'weekly',
    what: 'Paste a WhatsApp message or email and AI turns it into a request or task.',
    start: 'Work → AI Capture, paste the client\'s message, check what it found, then save.' },
  '/dashboard/my-work': { rhythm: 'daily',
    what: 'Everything assigned to you or your team, on a board you move forward.',
    start: 'Work → My Work, pick a card and move it to the next column when it moves on.' },
  '/dashboard/requests': { rhythm: 'daily',
    what: 'The inbox for client work: every request, who has it, and when it is due.',
    start: 'Work → Requests, tap New request, pick the client and write what they need.' },
  '/dashboard/tasks': { rhythm: 'daily',
    what: 'Every job done for a client, with its price. Invoices are built from these.',
    start: 'Work → Tasks, tap Add Task, pick the client and the service, then save.' },
  '/dashboard/clients': { rhythm: 'weekly',
    what: 'Each client\'s details, work, invoices and balance in one place.',
    start: 'Work → Clients, open a client to see their history, or tap Add Client.' },
  '/dashboard/contributions': { rhythm: 'weekly',
    what: 'Who did which part of each job, so earnings and commission are fair.',
    start: 'Work → Contributions, pick the month, then fill each person\'s share on the jobs.' },
  '/dashboard/chat': { rhythm: 'daily',
    what: 'Team messages inside the app, one to one or in groups.',
    start: 'Work → Chat, pick a colleague by CQID and send a message.' },

  // ── Finance ───────────────────────────────────────────────────────────────
  '/dashboard/packages': { rhythm: 'monthly',
    what: 'Monthly agreements with clients: what is promised and how much is delivered.',
    start: 'Finance → Packages, tap New package, pick the client and the monthly deliverables.' },
  '/dashboard/quote-planner': { rhythm: 'monthly',
    what: 'Work out a price for a quote or package and see the margin before you send it.',
    start: 'Finance → Quote Planner, add the services, adjust the price, check the margin.' },
  '/dashboard/invoices': { rhythm: 'weekly',
    what: 'Make, send and track client invoices and their payments.',
    start: 'Finance → Invoices, tap ⋯ → Generate from tasks, pick the client and month.' },
  '/dashboard/invoices/follow-ups': { rhythm: 'weekly',
    what: 'Unpaid invoices sorted by urgency, with a log of every reminder.',
    start: 'Finance → Follow-ups, open the top invoice, contact the client, log what they said.' },
  '/dashboard/statements': { rhythm: 'monthly',
    what: 'A statement of account per client: invoices, payments and the balance due.',
    start: 'Finance → Statements, pick a client, then download or share the statement.' },
  '/dashboard/partners': { rhythm: 'monthly',
    what: 'People who bring you clients for a commission, and what they are owed.',
    start: 'Finance → Business Partners, tap Add partner, set the commission, link their clients.' },
  '/dashboard/cashbook': { rhythm: 'daily',
    what: 'Every rupee in and out: income, expenses and transfers between accounts.',
    start: 'Finance → Cash Book, tap Add Entry → Expense, type the amount, and save.' },
  '/dashboard/cashbook/recurring': { rhythm: 'monthly',
    what: 'Bills that repeat, like rent or subscriptions, post themselves every month.',
    start: 'Finance → Recurring, tap Add recurring, enter the bill and its day of the month.' },
  '/dashboard/cashbook/cards': { rhythm: 'monthly',
    what: 'Check a credit card statement against the Cash Book, line by line.',
    start: 'Finance → Card Statements, upload the month\'s card statement, then match the lines.' },
  '/dashboard/cashbook/bank': { rhythm: 'monthly',
    what: 'Check the bank statement against the Cash Book and find missing entries.',
    start: 'Finance → Bank Reconciliation, import the bank statement, then fix the unmatched lines.' },
  '/dashboard/finance/months': { rhythm: 'monthly',
    what: 'Close each month: profit, payroll status and corrections, then lock it.',
    start: 'Finance → Months, open last month, check the numbers, then lock it.' },
  '/dashboard/finance/profit-sharing': { rhythm: 'monthly',
    what: 'Company profit, capital, and each investor\'s share and payout.',
    start: 'Finance → Profit Sharing, check the month\'s profit, then record the payouts.' },
  // From the Departments & Brands work (shows once that page is in the sidebar).
  '/dashboard/units': { rhythm: 'monthly',
    what: 'Cirqle\'s departments and brands: their teams, profit agreements and results.',
    start: 'Finance → Departments & Brands, open a unit to see its team and this month\'s results.' },

  // ── Marketing ─────────────────────────────────────────────────────────────
  '/dashboard/marketing': { rhythm: 'weekly',
    what: 'One page per client for marketing: Pages, campaigns, content and leads together.',
    start: 'Marketing → Clients Hub, pick a client to see all their marketing in one place.' },
  '/dashboard/social-calendar': { rhythm: 'daily',
    what: 'Plan, post and answer comments for Instagram and Facebook.',
    start: 'Marketing → Social, open a client\'s plan, add a post to a day, then Send to Requests.' },
  '/dashboard/prompt-studio': { rhythm: 'weekly',
    what: 'Ready prompts for AI video, image, voice and music tools, filled in for a client.',
    start: 'Marketing → Prompt Studio, pick a template and a client, then copy the prompt.' },
  '/dashboard/advertising': { rhythm: 'weekly',
    what: 'Ad campaigns on Meta and Google: spend, results and cost per lead.',
    start: 'Marketing → Advertising, pick a client to see their running campaigns.' },
  '/dashboard/ad-library': { rhythm: 'weekly',
    what: 'A swipe file of good ads, saved from the Facebook Ad Library.',
    start: 'Marketing → Ad Library, tap Connect Chrome, add the extension, save your first ad.' },
  '/dashboard/leads': { rhythm: 'weekly',
    what: 'Enquiries from lead ads and other sources, with their follow-up status.',
    start: 'Marketing → Leads, open a new lead, contact them, then set the status.' },
  '/dashboard/orders': { rhythm: 'weekly',
    what: 'Memoura gift orders: advance, balance, dispatch and tracking.',
    start: 'Marketing → Orders, tap New order, enter the customer and the gift.' },
  '/dashboard/shop': { rhythm: 'monthly',
    what: 'What the Memoura website shows: gifts on or off, banner, prices, delivery charge.',
    start: 'Marketing → Shop, switch a gift on or off or change the banner, then save.' },
  '/dashboard/portfolio': { rhythm: 'monthly',
    what: 'Publish your best work to the cirqle.work website.',
    start: 'Marketing → Portfolio, tap Upload, pick the creative and the brand, publish.' },
  '/dashboard/field-marketing': { rhythm: 'weekly',
    what: 'Shops and prospects on a map, with visits and follow-ups for door-to-door sales.',
    start: 'Marketing → Field Marketing, tap Add place, then log your first visit.' },
  '/dashboard/agency': { rhythm: 'weekly',
    what: 'Every client\'s ads in one view: spend, leads, cost per lead and alerts.',
    start: 'Marketing → Agency, look at the clients with alerts first.' },
  '/dashboard/connections': { rhythm: 'occasional',
    what: 'Connect the Facebook, Instagram and Google Ads accounts to the app.',
    start: 'Marketing → Connections, tap Connect and sign in with the business account.' },
  '/dashboard/assets': { rhythm: 'occasional',
    what: 'Say which client owns each connected Page, ad account and lead form.',
    start: 'Marketing → Asset Assignment, open the unassigned ones and pick a client for each.' },
  '/dashboard/cirqle-accounts': { rhythm: 'occasional',
    what: 'Cirqle\'s own Pages and ad accounts (Flyers, Memoura), kept apart from clients\'.',
    start: 'Marketing → Cirqle Brands, check that each brand has its accounts connected.' },

  // ── HR ────────────────────────────────────────────────────────────────────
  '/dashboard/payroll': { rhythm: 'monthly',
    what: 'Staff records, monthly salary, advances and payslips.',
    start: 'HR → HR & Payroll, open this month, check the draft, then mark it paid.' },
  '/dashboard/performance': { rhythm: 'monthly',
    what: 'Score employees and job applicants on scorecards and apply the ratings.',
    start: 'HR → Performance, pick a person, fill the scorecard, and save.' },

  // ── Recruitment ───────────────────────────────────────────────────────────
  '/dashboard/recruitment/positions': { rhythm: 'occasional',
    what: 'Jobs you are hiring for, each with a link people apply through.',
    start: 'Recruitment → Open Positions, tap New position, describe the job, share the link.' },
  '/dashboard/recruitment/applications': { rhythm: 'occasional',
    what: 'Everyone who applied, moved through stages from new to hired.',
    start: 'Recruitment → Applications, open a new one and move it to the next stage.' },
  '/dashboard/recruitment/interviews': { rhythm: 'occasional',
    what: 'The interview schedule, with reminders and notes.',
    start: 'Recruitment → Interviews, tap Schedule, pick the applicant and the time.' },
  '/dashboard/recruitment/offers': { rhythm: 'occasional',
    what: 'Job offers sent to chosen candidates, and their answers.',
    start: 'Recruitment → Offers, pick the selected candidate, set salary and joining date, send.' },
  '/dashboard/recruitment/reports': { rhythm: 'occasional',
    what: 'How hiring is going: applications, time to hire, where good people come from.',
    start: 'Recruitment → Hiring Reports, pick the period and read the numbers.' },

  // ── Insights ──────────────────────────────────────────────────────────────
  '/dashboard/reports': { rhythm: 'monthly',
    what: 'Monthly business reports: revenue, profit, clients and people.',
    start: 'Insights → Reports, pick the month and read the summary cards.' },
  '/dashboard/reports/contribution-analysis': { rhythm: 'monthly',
    what: 'A spreadsheet of every job: who did it, what it earned, what it cost.',
    start: 'Insights → Contribution Analysis, pick the month and sort by earnings.' },
  '/dashboard/reports/role-earnings': { rhythm: 'monthly',
    what: 'What each role (Accounts, HR, CEO Direct) earned from ownership shares.',
    start: 'Insights → Earnings by Role, pick the month and check each role\'s share.' },
  '/dashboard/reports/what-if': { rhythm: 'occasional',
    what: 'Try a raise, a commission or a price change and see the effect before deciding.',
    start: 'Insights → What-If Planner, change one number and compare before and after.' },
  '/dashboard/health': { rhythm: 'weekly',
    what: 'Cash, overdue invoices, risky clients, and whether the automatic jobs ran.',
    start: 'Insights → Business Health, start with the owner check at the top.' },
  '/dashboard/reports/reconcile': { rhythm: 'monthly',
    what: 'Finished work that was never invoiced, and invoices that drifted from their tasks.',
    start: 'Insights → Billing Reconciliation, open the uninvoiced work and bill it.' },
  '/dashboard/reports/team-work': { rhythm: 'monthly',
    what: 'What one department delivered for each client this month, to share with the team.',
    start: 'Insights → Team Work Report, pick the department, then tap Share with the team.' },
  '/dashboard/reports/company-ops': { rhythm: 'monthly',
    what: 'Company profit and loss, monthly burn, and how many months of cash are left.',
    start: 'Insights → Company Operations, check the burn rate and runway.' },
  '/dashboard/reports/client-profitability': { rhythm: 'monthly',
    what: 'Which clients make money after costs, and which do not.',
    start: 'Insights → Client Profitability, sort by margin and look at the bottom rows.' },
  '/dashboard/client-analytics': { rhythm: 'monthly',
    what: 'One client\'s trend over weeks, months or years, as charts.',
    start: 'Insights → Client Analytics, pick a client and a period.' },
  '/dashboard/reports/cost-attribution': { rhythm: 'monthly',
    what: 'Where the money goes, by tag and kind of cost.',
    start: 'Insights → Cost & Tags, pick the month and open the biggest tag.' },
  '/dashboard/clients/ranking': { rhythm: 'monthly',
    what: 'Clients scored on how reliably they pay and how much work they bring.',
    start: 'Insights → Client Ranking, check the lowest scores before taking new work.' },
  '/dashboard/reports/feature-usage': { rhythm: 'monthly',
    what: 'Which parts of the app are used, by whom, and how to start the rest.',
    start: 'Insights → Feature Usage, open Never used and try one feature a week.' },

  // ── Tools ─────────────────────────────────────────────────────────────────
  '/dashboard/workspace': { rhythm: 'weekly',
    what: 'Your own to-do list, notes and reminders.',
    start: 'Tools → My Planner, add one to-do for today with a reminder.' },
  '/dashboard/approvals': { rhythm: 'weekly',
    what: 'Things waiting for a yes or no, in one list.',
    start: 'Tools → Approvals, open the first one and approve or reject it.' },
  '/dashboard/quotations': { rhythm: 'monthly',
    what: 'Formal price quotes for clients, which can later become invoices.',
    start: 'Tools → Quotations, tap New quotation, add the services, send it.' },
  '/dashboard/apps': { rhythm: 'occasional',
    what: 'Ready forms and links to give clients, like a standard request form.',
    start: 'Tools → Apps Directory, pick an app and copy its link for a client.' },
  '/dashboard/activity': { rhythm: 'occasional',
    what: 'A timeline of who changed what in the app.',
    start: 'Tools → Activity, filter by type to see the latest changes.' },
  '/dashboard/import': { rhythm: 'occasional',
    what: 'Add many tasks, contributions or Cash Book entries at once from a spreadsheet.',
    start: 'Tools → Bulk Import, download the template, fill it in, and upload it.' },

  // ── System ────────────────────────────────────────────────────────────────
  '/dashboard/settings/workspaces': { rhythm: 'occasional',
    what: 'A view per team that shows only the pages and widgets they need.',
    start: 'System → Workspaces, tap New workspace, pick its pages and members.' },
  '/dashboard/settings': { rhythm: 'occasional',
    what: 'Company details, staff, roles and permissions, and alerts.',
    start: 'System → Settings, check Company first, then the roles under Designations.' },
}

/**
 * Pages that sit outside the sidebar but belong to one sidebar feature. The
 * Social tabs (To Post, Comments, Feed, Insights…) live under /dashboard/social
 * while the sidebar's one Social entry points at the plan.
 */
const FEATURE_ALIASES: { prefix: string; href: string }[] = [
  { prefix: '/dashboard/social', href: '/dashboard/social-calendar' },
]

/** Every sidebar item as a feature, in sidebar order. */
export function listFeatures(sections: NavSection[] = navSections): Feature[] {
  const out: Feature[] = []
  const seen = new Set<string>()
  for (const section of sections) {
    for (const item of section.items) {
      if (seen.has(item.href)) continue
      seen.add(item.href)
      out.push(toFeature(item, section.label ?? 'Home', out.length))
    }
  }
  return out
}

function toFeature(item: NavItem, section: string, order: number): Feature {
  const guide = FEATURE_GUIDES[item.href]
  return {
    href: item.href,
    label: item.label,
    section,
    order,
    described: !!guide,
    what: guide?.what ?? `Open it to see what ${item.label} does — no description has been written yet.`,
    start: guide?.start ?? (section === 'Home' ? `Tap ${item.label} in the sidebar.` : `Open ${section} → ${item.label} in the sidebar.`),
    rhythm: guide?.rhythm ?? 'weekly',
    ...(item.requiredPerm ? { requiredPerm: item.requiredPerm } : {}),
    ...(item.requiredAnyPerm?.length ? { requiredAnyPerm: [...item.requiredAnyPerm] } : {}),
    ...(item.adminOnly ? { adminOnly: true } : {}),
  }
}

/**
 * The sidebar feature a page belongs to, or null for a page outside the
 * sidebar. Deeper routes count for their sidebar page (/dashboard/clients/abc
 * is Clients); query strings and hashes are ignored, so no record id or
 * search ever reaches the visit log.
 */
export function featureForPath(path: string, sections: NavSection[] = navSections): string | null {
  const clean = (path || '').split(/[?#]/)[0].replace(/\/+$/, '') || '/'
  if (!clean.startsWith('/dashboard')) return null
  const hit = resolveActiveHref(sections, clean)
  if (hit) return hit
  for (const a of FEATURE_ALIASES) {
    if (clean === a.prefix || clean.startsWith(`${a.prefix}/`)) {
      // Only when the target is really in the sidebar it was written for.
      return sections.some(s => s.items.some(i => i.href === a.href)) ? a.href : null
    }
  }
  return null
}

/**
 * The role-specific daily action queue.
 *
 * Smart Focus — the "what should I do now?" feed — lives in the admin branch of
 * DashboardClient, which returns early to EmployeeDashboard for everyone else.
 * So the queue was effectively admin-only, and the two roles the agency
 * actually runs on got nothing from it:
 *
 *   · an accounts person holding `billing.view_invoices` saw no overdue
 *     invoices and no drafts waiting to be sent — the whole of their job;
 *   · a manager holding `requests.review` saw no pending approvals, even
 *     though the requests are queued on them specifically.
 *
 * Both were a data gap rather than a leak: page.tsx fetched those rows behind
 * `isAdmin ?` and handed non-admins an empty array, so the cards never
 * rendered. Conservative, but it meant the dashboard had nothing to say to the
 * people who most needed telling.
 *
 * This module is the ordering and eligibility rule, kept pure so it can be
 * tested without a database or a React tree. It decides WHICH buckets a viewer
 * is entitled to and in WHAT order they matter; the caller supplies the counts
 * and renders the result. Icons and colours stay in the component — those are
 * JSX concerns and would make this module untestable in a node environment.
 *
 * Deliberately NOT a second dashboard. The same buckets feed the existing
 * Smart Focus grid for admins and the existing EmployeeDashboard panel for
 * everyone else, which is what the improvement plan asked for.
 */

/** Every bucket the queue can surface. */
export type ActionQueueKey =
  | 'overdue_invoices'
  | 'requests_awaiting'
  | 'my_contributions'
  | 'drafts_to_send'
  | 'payroll_review'
  | 'missing_contributions'
  | 'my_tasks'
  | 'today_tasks'
  | 'notifications'

/**
 * What the viewer is allowed to be shown.
 *
 * These are capability flags, not raw permission keys, so the caller resolves
 * `hasPermission` once (server-side, where the real identity lives) and this
 * module stays free of any dependency on the permission system.
 */
export interface ActionQueueCaps {
  /** Admins see every bucket that has a count. */
  isAdmin: boolean
  /** `billing.view_invoices` — overdue money and drafts waiting to go out. */
  billing: boolean
  /** `requests.review` or `requests.manage` — approvals queued on this person. */
  requestsReview: boolean
  /** `payroll.view` — payroll runs awaiting review. */
  payroll: boolean
  /** `contributions.view_all` — other people's unscored work, not just one's own. */
  contributionsAll: boolean
  /** Signed in as an employee record, so the personal buckets can be filled. */
  hasEmployeeRecord: boolean
}

/** Counts the caller has already fetched. Absent or zero means "nothing to do". */
export interface ActionQueueCounts {
  overdueInvoices?: number
  requestsAwaiting?: number
  myContributions?: number
  draftsToSend?: number
  payrollPending?: number
  missingContributions?: number
  myTasks?: number
  todayTasks?: number
  unreadNotifications?: number
}

/** A sample of row labels per bucket, shown under the count. */
export type ActionQueueSamples = Partial<Record<ActionQueueKey, string[]>>

export interface ActionQueueItem {
  key: ActionQueueKey
  /** What needs attention, in the user's words. */
  title: string
  count: number
  /** Singular noun; the caller pluralises against `count`. */
  unit: string
  /** Why it is in the queue — the plan asked that each item explain itself. */
  reason: string
  /** Where clicking it goes. The action, not a report about the action. */
  href: string
  /** Up to three row labels, for context without opening the screen. */
  items: string[]
  /** Semantic tone; the component maps this to its own palette. */
  tone: 'red' | 'amber' | 'orange' | 'cyan' | 'blue' | 'violet' | 'emerald'
}

/**
 * Order is deliberate and is the whole point of the feature.
 *
 * Lower number = higher up. The rule: things that block *other* people or cost
 * money first, then one's own committed work, then anything merely
 * informational. Notifications sit last because they are a mixed bag — a
 * notification worth acting on is almost always also represented by one of the
 * specific buckets above it.
 */
const ORDER: Record<ActionQueueKey, number> = {
  overdue_invoices: 10,
  requests_awaiting: 20,
  my_contributions: 30,
  drafts_to_send: 40,
  payroll_review: 50,
  missing_contributions: 60,
  my_tasks: 70,
  today_tasks: 80,
  notifications: 90,
}

/** Static copy per bucket. Kept beside the order so the two cannot drift. */
const SPEC: Record<ActionQueueKey, Omit<ActionQueueItem, 'count' | 'items'>> = {
  overdue_invoices: {
    key: 'overdue_invoices', title: 'Overdue Invoices', unit: 'invoice', tone: 'red',
    reason: 'Past their due date and still unpaid', href: '/dashboard/invoices/follow-ups',
  },
  requests_awaiting: {
    key: 'requests_awaiting', title: 'Requests Awaiting Action', unit: 'request', tone: 'cyan',
    reason: 'Submitted and waiting on your review', href: '/dashboard/requests',
  },
  my_contributions: {
    key: 'my_contributions', title: 'Add Your Contribution', unit: 'task', tone: 'amber',
    reason: 'Finished work you have not scored yet — payroll waits on this',
    href: '/dashboard/contributions',
  },
  drafts_to_send: {
    key: 'drafts_to_send', title: 'Drafts to Send', unit: 'invoice', tone: 'orange',
    reason: 'Prepared but not yet sent to the client', href: '/dashboard/invoices/follow-ups',
  },
  payroll_review: {
    key: 'payroll_review', title: 'Payroll to Review', unit: 'record', tone: 'emerald',
    reason: 'Calculated and awaiting approval', href: '/dashboard/payroll',
  },
  missing_contributions: {
    key: 'missing_contributions', title: 'Missing Contributions', unit: 'task', tone: 'amber',
    reason: 'Done work nobody has scored', href: '/dashboard/contributions',
  },
  my_tasks: {
    key: 'my_tasks', title: 'Your Open Tasks', unit: 'task', tone: 'blue',
    reason: 'Assigned to you and not finished', href: '/dashboard/my-work',
  },
  today_tasks: {
    key: 'today_tasks', title: "Today's Tasks", unit: 'task', tone: 'blue',
    reason: 'Scheduled for today', href: '/dashboard/tasks',
  },
  notifications: {
    key: 'notifications', title: 'Notifications', unit: 'unread', tone: 'violet',
    reason: 'Unread updates', href: '/dashboard',
  },
}

/** Which capability each bucket requires. `true` means everyone. */
function isEligible(key: ActionQueueKey, caps: ActionQueueCaps): boolean {
  if (caps.isAdmin) return true
  switch (key) {
    case 'overdue_invoices':
    case 'drafts_to_send':
      return caps.billing
    case 'requests_awaiting':
      return caps.requestsReview
    case 'payroll_review':
      return caps.payroll
    case 'missing_contributions':
      return caps.contributionsAll
    case 'my_contributions':
    case 'my_tasks':
      return caps.hasEmployeeRecord
    // Personal and harmless: an unread count of one's own notifications, and
    // the day's schedule. Neither reveals anything the viewer cannot already
    // open, so they need no permission beyond reaching the dashboard.
    case 'notifications':
    case 'today_tasks':
      return true
  }
}

const COUNT_FOR: Record<ActionQueueKey, keyof ActionQueueCounts> = {
  overdue_invoices: 'overdueInvoices',
  requests_awaiting: 'requestsAwaiting',
  my_contributions: 'myContributions',
  drafts_to_send: 'draftsToSend',
  payroll_review: 'payrollPending',
  missing_contributions: 'missingContributions',
  my_tasks: 'myTasks',
  today_tasks: 'todayTasks',
  notifications: 'unreadNotifications',
}

/**
 * Build the viewer's queue: eligible buckets that have something in them,
 * most urgent first.
 *
 * A bucket with a zero (or missing) count is dropped rather than rendered
 * empty — an action queue that lists things needing no action is the noise
 * this feature exists to remove.
 */
export function buildActionQueue(
  caps: ActionQueueCaps,
  counts: ActionQueueCounts,
  samples: ActionQueueSamples = {},
): ActionQueueItem[] {
  return (Object.keys(SPEC) as ActionQueueKey[])
    .filter(key => isEligible(key, caps))
    .map(key => ({
      ...SPEC[key],
      count: Math.max(0, Math.trunc(counts[COUNT_FOR[key]] ?? 0)),
      items: (samples[key] ?? []).slice(0, 3),
    }))
    .filter(item => item.count > 0)
    .sort((a, b) => ORDER[a.key] - ORDER[b.key])
}

/**
 * Total across the queue, for the "N need attention" badge.
 *
 * Counts only the buckets that represent a decision someone is waiting on.
 * Today's schedule and unread notifications are excluded: a day with twelve
 * tasks on it is a normal day, and inflating the badge with it trains people
 * to ignore the badge.
 */
const INFORMATIONAL: ReadonlySet<ActionQueueKey> = new Set(['today_tasks', 'notifications'])

export function actionQueueAttentionCount(items: ActionQueueItem[]): number {
  return items.reduce((sum, i) => (INFORMATIONAL.has(i.key) ? sum : sum + i.count), 0)
}

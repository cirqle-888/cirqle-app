/**
 * "How do I…?" guides — the whole help system's content lives in this file.
 *
 * A guide is a question in plain words plus a few steps. Each step can name a
 * page (`href`) and a control to point at (`target`); the runner in
 * `components/help/help-guide.tsx` takes the user there and rings the control.
 *
 * ── ADDING A GUIDE ───────────────────────────────────────────────────────
 *
 *   {
 *     id: 'unique-id',
 *     title: 'What the employee would ask',
 *     area: 'Invoices',                       // group heading in the list
 *     keywords: ['other words they might type'],
 *     perms: ['billing.edit'],                // ANY of these (admins see all)
 *     steps: [
 *       { text: 'Tap Add Entry', href: '/dashboard/cashbook', target: { text: 'Add Entry' } },
 *     ],
 *   }
 *
 * `target` finds a control by CSS (`sel`) or by its visible label (`text`).
 * Give several and the first one actually on screen wins — handy when a phone
 * hides the control behind another button. Steps without a target are just
 * read and passed with Next.
 *
 * Keep step text to one short line. Nobody reads a paragraph mid-task.
 */

export interface HelpTarget {
  /** CSS selector. */
  sel?: string
  /** Visible label of a button / link / menu item (case-insensitive, contains). */
  text?: string
}

export interface HelpStep {
  text: string
  /** Page this step happens on. The runner offers "Take me there" when elsewhere. */
  href?: string
  /** Control(s) to ring; first visible match wins. */
  target?: HelpTarget | HelpTarget[]
  /** Move on by itself once this selector is on screen (e.g. an invoice was opened). */
  doneWhen?: string
  /** Ring it, but don't move on when it's clicked (a field to type in, a final Save). */
  manual?: boolean
}

export interface HelpGuide {
  id: string
  title: string
  area: string
  keywords: string[]
  /** Any one of these permissions shows the guide. Empty = everyone. */
  perms: string[]
  steps: HelpStep[]
}

const INV = '/dashboard/invoices'
const CASH = '/dashboard/cashbook'
const INVOICE_OPEN = '[aria-label="More invoice actions"]'

export const HELP_GUIDES: HelpGuide[] = [
  // ── Payments ──────────────────────────────────────────────────────────────
  {
    id: 'partner-payment',
    title: 'Record a payment from a business partner',
    area: 'Payments',
    keywords: ['partner', 'bp', 'many clients', 'oldest invoice', 'received', 'collection', 'bulk payment'],
    perms: ['cashbook.edit'],
    steps: [
      { text: 'Pick the business partner here.', href: INV,
        target: [{ sel: '[aria-label="Filter by business partner"]' }, { sel: '[aria-label="Filters"]' }],
        doneWhen: 'a[href*="receive=1"]' },
      { text: 'Tap Receive payment.', href: INV, target: { sel: 'a[href*="receive=1"]' } },
      { text: 'Type the amount you received.', href: CASH, target: { sel: 'input[placeholder="0.00"]' }, manual: true },
      { text: 'Tap Pay oldest first — it fills the oldest invoices for you.', href: CASH, target: { text: 'Pay oldest first' } },
      { text: 'Check the invoices listed, then tap Save Income.', href: CASH, target: { text: 'Save Income' }, manual: true },
    ],
  },
  {
    id: 'client-payment',
    title: 'Record a payment for one invoice',
    area: 'Payments',
    keywords: ['paid', 'received', 'client paid', 'mark paid', 'part payment', 'partial'],
    perms: ['billing.edit', 'billing.view_workflow'],
    steps: [
      { text: 'Open the invoice that was paid.', href: INV, doneWhen: INVOICE_OPEN },
      { text: 'Tap Record Payment.', href: INV, target: [{ text: 'Record Payment' }, { sel: INVOICE_OPEN }] },
      { text: 'Enter the amount and date, then save. A smaller amount is saved as a part payment.', href: INV },
    ],
  },
  {
    id: 'client-payment-many',
    title: 'One payment covering several invoices of a client',
    area: 'Payments',
    keywords: ['multiple invoices', 'split', 'two invoices', 'lump sum', 'oldest'],
    perms: ['cashbook.edit'],
    steps: [
      { text: 'Pick the client here.', href: INV,
        target: [{ sel: '[aria-label="Filter by client"]' }, { sel: '[aria-label="Filters"]' }],
        doneWhen: 'a[href*="receive=1"]' },
      { text: 'Tap Receive payment.', href: INV, target: { sel: 'a[href*="receive=1"]' } },
      { text: 'Type the amount you received.', href: CASH, target: { sel: 'input[placeholder="0.00"]' }, manual: true },
      { text: 'Tap Pay oldest first.', href: CASH, target: { text: 'Pay oldest first' } },
      { text: 'Check the split, then tap Save Income.', href: CASH, target: { text: 'Save Income' }, manual: true },
    ],
  },

  // ── Invoices ──────────────────────────────────────────────────────────────
  {
    id: 'sent-invoice-add-tasks',
    title: 'Add or update tasks on an invoice that is already sent',
    area: 'Invoices',
    keywords: ['sent invoice', 'draft', 'review', 'missed task', 'update task', 'change invoice', 'reopen', 'edit sent'],
    perms: ['billing.edit'],
    steps: [
      { text: 'Open the sent invoice.', href: INV, doneWhen: INVOICE_OPEN },
      { text: 'Tap the ⋯ menu.', href: INV, target: { sel: INVOICE_OPEN } },
      { text: 'Choose Refresh from tasks. No need to move it back to draft.', href: INV, target: { text: 'Refresh from tasks' } },
      { text: 'Tick the tasks to add or update, write the reason, and apply.', href: INV },
    ],
  },
  {
    id: 'sent-invoice-edit',
    title: 'Fix a price or line on a sent invoice',
    area: 'Invoices',
    keywords: ['wrong price', 'wrong amount', 'edit sent', 'force edit', 'unlock', 'correct', 'discount'],
    perms: ['billing.edit'],
    steps: [
      { text: 'Open the sent invoice.', href: INV, doneWhen: INVOICE_OPEN },
      { text: 'Tap the ⋯ menu.', href: INV, target: { sel: INVOICE_OPEN } },
      { text: 'Choose Force edit.', href: INV, target: { text: 'Force edit' } },
      { text: 'Write why you are changing it, then tap Unlock & Edit.', href: INV, target: { text: 'Unlock & Edit' } },
      { text: 'Change the line or price. The change is logged with your reason.', href: INV },
    ],
  },
  {
    id: 'send-drafts',
    title: 'Find the invoices that are ready to send',
    area: 'Invoices',
    keywords: ['draft', 'send', 'ready', 'pending to send', 'review'],
    perms: ['billing.view_invoices', 'billing.edit', 'billing.view_workflow'],
    steps: [
      { text: 'Tap Ready to send — the list shows only those.', href: INV, target: { text: 'Ready to send' } },
      { text: 'Open one, check the lines, then use the button at the top of the invoice to move it on.', href: INV },
    ],
  },
  {
    id: 'overdue',
    title: 'See which invoices are overdue',
    area: 'Invoices',
    keywords: ['overdue', 'late', 'pending', 'not paid', 'due'],
    perms: ['billing.view_invoices', 'billing.edit', 'billing.view_workflow'],
    steps: [
      { text: 'Tap Overdue.', href: INV, target: { text: 'Overdue' } },
      { text: 'To send reminders, tap Follow-ups.', href: INV, target: { sel: '[aria-label="Follow-ups"], a[href$="/invoices/follow-ups"]' } },
    ],
  },
  {
    id: 'generate-invoice',
    title: 'Create an invoice from finished tasks',
    area: 'Invoices',
    keywords: ['new invoice', 'generate', 'create invoice', 'bill tasks'],
    perms: ['billing.edit'],
    steps: [
      { text: 'Tap the ⋯ menu.', href: INV, target: { sel: '[aria-label="Invoice tools"]' } },
      { text: 'Choose Generate from tasks.', href: INV, target: { text: 'Generate from tasks' } },
      { text: 'Pick the client and month, tick the tasks, and create.', href: INV },
    ],
  },
  {
    id: 'download-invoice',
    title: 'Download or share an invoice PDF',
    area: 'Invoices',
    keywords: ['pdf', 'download', 'whatsapp', 'share', 'print', 'send to client'],
    perms: ['billing.view_invoices', 'billing.edit', 'billing.view_workflow'],
    steps: [
      { text: 'Open the invoice.', href: INV, doneWhen: INVOICE_OPEN },
      { text: 'Tap Download. WhatsApp share and Print are beside it or in the ⋯ menu.', href: INV,
        target: [{ sel: '[title="Download PDF"]' }, { sel: INVOICE_OPEN }], manual: true },
    ],
  },
  {
    id: 'partner-invoices',
    title: 'See all pending invoices of a business partner',
    area: 'Invoices',
    keywords: ['partner', 'bp', 'pending', 'outstanding', 'statement'],
    perms: ['billing.view_invoices', 'billing.edit', 'billing.view_workflow'],
    steps: [
      { text: 'Pick the business partner here. The list shows every client they brought.', href: INV,
        target: [{ sel: '[aria-label="Filter by business partner"]' }, { sel: '[aria-label="Filters"]' }], manual: true },
    ],
  },

  // ── Cash Book ─────────────────────────────────────────────────────────────
  {
    id: 'add-expense',
    title: 'Add an expense',
    area: 'Cash Book',
    keywords: ['expense', 'spent', 'purchase', 'bill', 'outflow', 'payment made'],
    perms: ['cashbook.edit'],
    steps: [
      { text: 'Tap Add Entry.', href: CASH, target: { text: 'Add Entry' } },
      { text: 'Tap Expense.', href: CASH, target: { text: '- Expense' } },
      { text: 'Pick the category, type the amount and what it was for.', href: CASH },
      { text: 'Tap Save Expense.', href: CASH, target: { text: 'Save Expense' }, manual: true },
    ],
  },
  {
    id: 'transfer',
    title: 'Move money between two accounts',
    area: 'Cash Book',
    keywords: ['transfer', 'bank to bank', 'cash to bank', 'deposit', 'withdraw'],
    perms: ['cashbook.edit'],
    steps: [
      { text: 'Tap Transfer.', href: CASH, target: { text: 'Transfer' } },
      { text: 'Pick the two accounts and the amount, then save. It is not counted as income or expense.', href: CASH },
    ],
  },

  {
    id: 'recurring-expense',
    title: 'Set up rent or a subscription that repeats every month',
    area: 'Cash Book',
    keywords: ['recurring', 'rent', 'subscription', 'monthly', 'internet', 'emi', 'auto'],
    perms: ['cashbook.edit'],
    steps: [
      { text: 'Open Recurring. Add it once and it posts itself every month.', href: '/dashboard/cashbook/recurring' },
    ],
  },

  // ── Tasks ─────────────────────────────────────────────────────────────────
  {
    id: 'add-task',
    title: 'Add a task',
    area: 'Tasks',
    keywords: ['new task', 'create task', 'work', 'job', 'entry'],
    perms: ['tasks.create'],
    steps: [
      { text: 'Tap Add Task.', href: '/dashboard/tasks', target: { text: 'Add Task' } },
      { text: 'Pick the client and service, fill the details, and save.', href: '/dashboard/tasks' },
    ],
  },
  {
    id: 'my-tasks',
    title: 'See only my tasks',
    area: 'Tasks',
    keywords: ['mine', 'my work', 'assigned to me', 'my tasks'],
    perms: [],
    steps: [
      { text: 'Tap Mine.', href: '/dashboard/tasks', target: { sel: 'button[title^="Tasks assigned to or contributed by me"]' }, manual: true },
    ],
  },
  {
    id: 'find-task',
    title: 'Find a task',
    area: 'Tasks',
    keywords: ['search', 'look up', 'old task', 'task number'],
    perms: [],
    steps: [
      { text: 'Type the title, client, service or task number here.', href: '/dashboard/tasks', target: { sel: 'input[placeholder^="Search title, client"]' }, manual: true },
      { text: 'Not in the list? Tap Search DB to look through older tasks too.', href: '/dashboard/tasks', target: { text: 'Search DB' }, manual: true },
    ],
  },
  {
    id: 'task-board',
    title: 'See tasks as a board or calendar',
    area: 'Tasks',
    keywords: ['board', 'kanban', 'calendar', 'view'],
    perms: [],
    steps: [
      { text: 'Tap Board (or Calendar) to change how tasks are shown.', href: '/dashboard/tasks', target: { sel: 'button[title="Board"]' }, manual: true },
    ],
  },

  // ── Requests ──────────────────────────────────────────────────────────────
  {
    id: 'new-request',
    title: 'Add a client request',
    area: 'Requests',
    keywords: ['request', 'new request', 'client asked', 'design request', 'whatsapp'],
    perms: ['requests.manage', 'requests.review'],
    steps: [
      { text: 'Tap New Request.', href: '/dashboard/requests', target: { text: 'New Request' } },
      { text: 'Pick the client, write what they asked for, and save.', href: '/dashboard/requests' },
    ],
  },
  {
    id: 'unassigned-requests',
    title: 'See requests nobody is working on',
    area: 'Requests',
    keywords: ['unassigned', 'pending', 'nobody', 'assign'],
    perms: ['requests.view'],
    steps: [
      { text: 'Tap unassigned — the list shows only open requests with no one on them.', href: '/dashboard/requests', target: { sel: 'button[title^="Show only open requests nobody"]' }, manual: true },
    ],
  },
  {
    id: 'requests-by-client',
    title: 'See what each client is waiting for',
    area: 'Requests',
    keywords: ['pending by client', 'waiting', 'status', 'client pending'],
    perms: ['requests.view'],
    steps: [
      { text: 'Tap Pending by client.', href: '/dashboard/requests', target: { text: 'Pending by client' } },
    ],
  },

  // ── Clients & partners ────────────────────────────────────────────────────
  {
    id: 'add-client',
    title: 'Add a new client',
    area: 'Clients',
    keywords: ['new client', 'create client', 'customer'],
    perms: ['clients.create', 'clients.create_draft'],
    steps: [
      { text: 'Tap Add Client.', href: '/dashboard/clients', target: { text: 'Add Client' } },
      { text: 'Fill in the name and contact details, then save.', href: '/dashboard/clients' },
    ],
  },
  {
    id: 'find-client',
    title: 'Find a client',
    area: 'Clients',
    keywords: ['search client', 'client details', 'phone', 'code'],
    perms: ['clients.view'],
    steps: [
      { text: 'Type the name, code or email here.', href: '/dashboard/clients', target: { sel: 'input[placeholder^="Search name, code"]' }, manual: true },
    ],
  },
  {
    id: 'add-partner',
    title: 'Add a business partner',
    area: 'Clients',
    keywords: ['partner', 'bp', 'referral', 'commission'],
    perms: ['finance.partner.create'],
    steps: [
      { text: 'Tap Add Partner.', href: '/dashboard/partners', target: { text: 'Add Partner' } },
      { text: 'Enter the name and commission, then save. Link their clients from the partner’s dashboard.', href: '/dashboard/partners' },
    ],
  },
  {
    id: 'remove-partner',
    title: 'Remove a business partner added by mistake',
    area: 'Clients',
    keywords: ['delete partner', 'archive partner', 'inactive', 'wrong partner', 'remove'],
    perms: ['finance.partner.edit'],
    steps: [
      { text: 'Tap the pencil on the partner’s card.', href: '/dashboard/partners' },
      { text: 'Tap Delete partner (only when no clients are linked), or Make inactive to keep the history.', href: '/dashboard/partners',
        target: [{ text: 'Delete partner' }, { text: 'Make inactive' }], manual: true },
    ],
  },

  // ── General ───────────────────────────────────────────────────────────────
  {
    id: 'search-anything',
    title: 'Find any page, client or record quickly',
    area: 'General',
    keywords: ['search', 'find', 'go to', 'open page', 'where is'],
    perms: [],
    steps: [
      { text: 'Tap search and type what you are looking for.', target: { sel: 'button[title^="Search"], button[aria-label^="Search"]' } },
    ],
  },
  {
    id: 'notifications',
    title: 'See my notifications',
    area: 'General',
    keywords: ['bell', 'alerts', 'notification', 'mentions'],
    perms: [],
    steps: [
      { text: 'Tap the bell.', target: { sel: '[aria-label="Notifications"], [title="Notifications"]' } },
    ],
  },
  {
    id: 'open-chat',
    title: 'Message a colleague',
    area: 'General',
    keywords: ['chat', 'message', 'discuss', 'talk', 'dm'],
    perms: ['chat.access'],
    steps: [
      { text: 'Tap chat, then pick the person or group.', target: { sel: '[aria-label="Toggle chat"]' } },
    ],
  },
  {
    id: 'account',
    title: 'Change my password or status',
    area: 'General',
    keywords: ['password', 'status', 'away', 'profile', 'account', 'logout', 'sign out'],
    perms: [],
    steps: [
      { text: 'Tap your picture. Password, status and sign out are in this menu.', target: { sel: '[title="Account Settings"]' } },
    ],
  },
  {
    id: 'hide-figures',
    title: 'Hide amounts while sharing my screen',
    area: 'General',
    keywords: ['hide', 'blur', 'privacy', 'screen share', 'figures', 'amounts'],
    perms: [],
    steps: [
      { text: 'Tap this to blur every amount. Tap again to show them.', target: [{ text: 'Figures visible' }, { text: 'Figures hidden' }], manual: true },
    ],
  },
]

/** Lower-case words, for matching. */
function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1)
}

/**
 * Rank guides against what the user typed. Plain word matching — title words
 * count double, a keyword or area hit counts once; prefixes match so "pay"
 * finds "payment". Returns [] for an empty query (caller shows the full list).
 */
export function searchGuides(guides: HelpGuide[], query: string): HelpGuide[] {
  const q = words(query)
  if (!q.length) return []
  const scored = guides.map(g => {
    const title = words(g.title)
    const rest = words(`${g.keywords.join(' ')} ${g.area}`)
    let score = 0
    for (const w of q) {
      if (title.some(t => t.startsWith(w) || w.startsWith(t))) score += 2
      else if (rest.some(t => t.startsWith(w) || w.startsWith(t))) score += 1
    }
    return { g, score }
  })
  return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).map(s => s.g)
}

/**
 * Permission keys — single source of truth.
 * Keep in sync with the permissions catalog seeded by migrations/001, 005, 009.
 * Use these constants in client/server code instead of raw strings.
 */
export const PERMS = {
  // Dashboard
  DASHBOARD_VIEW:           'dashboard.view',
  DASHBOARD_VIEW_ANALYTICS: 'dashboard.view_analytics',

  // Reports
  REPORTS_VIEW: 'reports.view',

  // Tasks
  TASKS_VIEW_OWN:     'tasks.view_own',
  TASKS_VIEW_ALL:     'tasks.view_all',
  TASKS_CREATE:       'tasks.create',
  TASKS_EDIT:         'tasks.edit',
  TASKS_DELETE:       'tasks.delete',
  TASKS_ASSIGN:       'tasks.assign',
  TASKS_EXPORT:       'tasks.export',
  TASKS_WORKLOAD:     'tasks.workload',
  TASKS_TRASH:        'tasks.trash',
  /** See billing_amount / billing_amount_inr / loss_amount / currency / billing_mode on tasks. */
  TASKS_VIEW_PRICING: 'tasks.view_pricing',

  // Contributions
  CONTRIBUTIONS_VIEW_OWN:      'contributions.view_own',
  CONTRIBUTIONS_VIEW_ALL:      'contributions.view_all',
  CONTRIBUTIONS_EDIT:          'contributions.edit',
  /** See ₹ earned per contribution row in addition to score percentage. */
  CONTRIBUTIONS_VIEW_EARNINGS: 'contributions.view_earnings',

  // Employees
  EMPLOYEES_VIEW:                   'employees.view',
  EMPLOYEES_VIEW_FULL:              'employees.view_full',
  EMPLOYEES_CREATE:                 'employees.create',
  EMPLOYEES_EDIT:                   'employees.edit',
  EMPLOYEES_ARCHIVE:                'employees.archive',
  EMPLOYEES_REVIEW_CHANGE_REQUESTS: 'employees.review_change_requests',
  EMPLOYEES_REVEAL_NAMES:           'employees.reveal_names',

  // Payroll
  PAYROLL_VIEW:         'payroll.view',
  /** Create / update / delete payroll records, advances, credits. */
  PAYROLL_EDIT:         'payroll.edit',
  /** Mark a payroll record as Paid or revert to Pending. */
  PAYROLL_MARK_PAID:    'payroll.mark_paid',
  /** See ₹ base/commission/net/advances/credits/deductions amounts on payroll rows. */
  PAYROLL_VIEW_AMOUNTS: 'payroll.view_amounts',

  // Billing — split into workflow + amounts + line pricing
  BILLING_VIEW_INVOICES:     'billing.view_invoices',
  BILLING_VIEW_QUOTATIONS:   'billing.view_quotations',
  /** Create / update / delete invoices and their line items. */
  BILLING_EDIT:              'billing.edit',
  /** Legacy: see billing_amount / commission % on tasks (kept for backwards compat). */
  BILLING_VIEW_PRICING:      'billing.view_pricing',
  /** Open invoices and change status (sent / paid / reviewed). */
  BILLING_VIEW_WORKFLOW:     'billing.view_workflow',
  /** See ₹ totals, paid totals, outstanding, payment amounts. */
  BILLING_VIEW_AMOUNTS:      'billing.view_amounts',
  /** See per-item / per-task pricing on invoice detail. */
  BILLING_VIEW_LINE_PRICING: 'billing.view_line_pricing',

  // Cashbook
  CASHBOOK_VIEW:         'cashbook.view',
  /** Create / update / delete cashbook entries. */
  CASHBOOK_EDIT:         'cashbook.edit',
  /** See ₹ inflow/outflow values and bank balance figures. */
  CASHBOOK_VIEW_AMOUNTS: 'cashbook.view_amounts',

  // Clients / Services — granular "add" perms (separate from settings.access)
  /** Create new clients (e.g. + Add client in the task form). */
  CLIENTS_CREATE:  'clients.create',
  /** Create new services (e.g. + Add service in the task form). */
  SERVICES_CREATE: 'services.create',

  // Settings
  SETTINGS_ACCESS:              'settings.access',
  SETTINGS_MANAGE_DESIGNATIONS: 'settings.manage_designations',
  SETTINGS_MANAGE_COMPANY:      'settings.manage_company',
} as const

export type PermKey = typeof PERMS[keyof typeof PERMS]

/**
 * Convenience: every "view amounts/earnings/pricing" perm that, when missing,
 * means the relevant ₹ fields must be stripped server-side before the data
 * reaches the client JS state.
 */
export const FINANCIAL_VISIBILITY_PERMS = [
  PERMS.TASKS_VIEW_PRICING,
  PERMS.CONTRIBUTIONS_VIEW_EARNINGS,
  PERMS.PAYROLL_VIEW_AMOUNTS,
  PERMS.BILLING_VIEW_AMOUNTS,
  PERMS.BILLING_VIEW_LINE_PRICING,
  PERMS.CASHBOOK_VIEW_AMOUNTS,
] as const

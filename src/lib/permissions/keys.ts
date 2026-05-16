/**
 * Permission keys — single source of truth.
 * Keep in sync with the permissions catalog seeded by migrations/001.
 * Use these constants in client/server code instead of raw strings.
 */
export const PERMS = {
  // Dashboard
  DASHBOARD_VIEW:           'dashboard.view',
  DASHBOARD_VIEW_ANALYTICS: 'dashboard.view_analytics',

  // Tasks
  TASKS_VIEW_OWN: 'tasks.view_own',
  TASKS_VIEW_ALL: 'tasks.view_all',
  TASKS_CREATE:   'tasks.create',
  TASKS_EDIT:     'tasks.edit',
  TASKS_DELETE:   'tasks.delete',
  TASKS_ASSIGN:   'tasks.assign',
  TASKS_EXPORT:   'tasks.export',

  // Contributions
  CONTRIBUTIONS_VIEW_OWN: 'contributions.view_own',
  CONTRIBUTIONS_VIEW_ALL: 'contributions.view_all',
  CONTRIBUTIONS_EDIT:     'contributions.edit',

  // Employees
  EMPLOYEES_VIEW:                   'employees.view',
  EMPLOYEES_VIEW_FULL:              'employees.view_full',
  EMPLOYEES_CREATE:                 'employees.create',
  EMPLOYEES_EDIT:                   'employees.edit',
  EMPLOYEES_ARCHIVE:                'employees.archive',
  EMPLOYEES_REVIEW_CHANGE_REQUESTS: 'employees.review_change_requests',
  EMPLOYEES_REVEAL_NAMES:           'employees.reveal_names',

  // Payroll
  PAYROLL_VIEW: 'payroll.view',
  PAYROLL_EDIT: 'payroll.edit',

  // Billing
  BILLING_VIEW_INVOICES:   'billing.view_invoices',
  BILLING_VIEW_QUOTATIONS: 'billing.view_quotations',
  BILLING_EDIT:            'billing.edit',
  BILLING_VIEW_PRICING:    'billing.view_pricing',

  // Cashbook
  CASHBOOK_VIEW: 'cashbook.view',
  CASHBOOK_EDIT: 'cashbook.edit',

  // Settings
  SETTINGS_ACCESS:              'settings.access',
  SETTINGS_MANAGE_DESIGNATIONS: 'settings.manage_designations',
  SETTINGS_MANAGE_COMPANY:      'settings.manage_company',
} as const

export type PermKey = typeof PERMS[keyof typeof PERMS]

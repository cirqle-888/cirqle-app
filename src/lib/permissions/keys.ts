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
  /**
   * Restrict task visibility to the services assigned to the employee
   * (employee_services junction), plus tasks they personally worked on.
   * Opt-in: with neither this nor view_all, legacy behaviour (all tasks) holds.
   */
  TASKS_VIEW_BY_SERVICE: 'tasks.view_by_service',
  TASKS_CREATE:       'tasks.create',
  // (Service Scope keys live in their own block below — see SCOPE_*.)
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
  /** See the per-task activity log + post log notes on the contribution detail. */
  CONTRIBUTIONS_VIEW_ACTIVITY: 'contributions.view_activity',

  // Employees
  EMPLOYEES_VIEW:                   'employees.view',
  EMPLOYEES_VIEW_FULL:              'employees.view_full',
  EMPLOYEES_CREATE:                 'employees.create',
  EMPLOYEES_EDIT:                   'employees.edit',
  EMPLOYEES_ARCHIVE:                'employees.archive',
  EMPLOYEES_REVIEW_CHANGE_REQUESTS: 'employees.review_change_requests',
  EMPLOYEES_REVEAL_NAMES:           'employees.reveal_names',
  /** Create / edit per-employee commission agreements (special client/service rates). */
  EMPLOYEES_MANAGE_AGREEMENTS:      'employees.manage_agreements',

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

  // Business Partners — referral/collection-partner statements (read-only over invoices)
  PARTNERS_VIEW:   'finance.partner.view',
  PARTNERS_CREATE: 'finance.partner.create',
  PARTNERS_EDIT:   'finance.partner.edit',
  PARTNERS_EXPORT: 'finance.partner.export',

  // External Request Portal
  REQUESTS_VIEW:          'requests.view',
  REQUESTS_REVIEW:        'requests.review',
  REQUESTS_START:         'requests.start',
  REQUESTS_MANAGE:        'requests.manage',
  REQUESTS_ACTIVITY_VIEW: 'requests.activity.view',
  INTAKE_LINKS_MANAGE:    'intake_links.manage',
  AGENCY_LINKS_MANAGE:    'agency_links.manage',

  // Social Media Calendar — content planner feeding the Requests inbox
  SOCIAL_VIEW:   'social.view',
  SOCIAL_MANAGE: 'social.manage',

  // Client Agreements — the parent commercial commitment record
  // (CLIENT_AGREEMENTS_DESIGN.md; migration 20260722120000)
  AGREEMENTS_VIEW:         'agreements.view',
  AGREEMENTS_MANAGE:       'agreements.manage',
  AGREEMENTS_VIEW_PRICING: 'agreements.view_pricing',

  // Service Scope — cross-module restriction (see src/lib/scope/service-scope.ts).
  // Dimension-qualified names so a future scope.by_branch sits beside these.
  /**
   * RESTRICTION: the holder only sees the services assigned to them
   * (employee_services) and only the clients who buy those services.
   * Leave OFF for admin / task-manager / finance designations — they see all.
   * Opt-in: without it, behaviour is unchanged.
   */
  SCOPE_BY_SERVICE: 'scope.by_service',
  /** Explicit escape hatch: overrides SCOPE_BY_SERVICE and shows everything. */
  SCOPE_VIEW_ALL:   'scope.view_all',

  // Advertising — paid-ads campaign management module
  ADVERTISING_VIEW:            'advertising.view',
  ADVERTISING_CREATE:          'advertising.create',
  ADVERTISING_EDIT:            'advertising.edit',
  ADVERTISING_DELETE:          'advertising.delete',
  /** Set the ad spend budget + agency service charge, and sync invoices. */
  ADVERTISING_MANAGE_BUDGET:   'advertising.manage_budget',
  /**
   * SEE the wallet layer: client/company wallet balances, credited top-ups
   * and transaction history. Campaign ALLOCATIONS are deliberately NOT behind
   * this key — an allocation is the campaign's working budget and every
   * advertising.view holder sees it. Stripped SERVER-SIDE without the key.
   * manage_budget and admin imply it.
   */
  ADVERTISING_VIEW_FINANCIALS: 'advertising.view_financials',
  /**
   * SEE what the agency bills the client: service charge type/value/%,
   * computed billing, task billing amounts, invoices and service rate cards.
   * Separate from view_financials so a wallet-watcher need not see margins
   * and a campaign handler sees neither. Stripped SERVER-SIDE without the
   * key. manage_budget and admin imply it.
   */
  ADVERTISING_VIEW_BILLING:    'advertising.view_billing',
  /** Add / edit daily performance entries for assigned campaigns. */
  ADVERTISING_ENTER_METRICS:   'advertising.enter_metrics',
  /** Approve daily metrics submitted by media buyers. */
  ADVERTISING_APPROVE_METRICS: 'advertising.approve_metrics',
  ADVERTISING_VIEW_REPORTS:    'advertising.view_reports',
  
  // Advertising - Enterprise ERP Permissions
  ADVERTISING_MANAGE_PROVIDERS:'advertising.manage_providers',
  ADVERTISING_MANAGE_OAUTH:    'advertising.manage_oauth',
  ADVERTISING_MAP_CAMPAIGNS:   'advertising.map_campaigns',
  ADVERTISING_MANUAL_SYNC:     'advertising.manual_sync',
  ADVERTISING_MANAGE_SETTINGS: 'advertising.manage_settings',
  ADVERTISING_VIEW_AI:         'advertising.view_ai',
  ADVERTISING_MANAGE_AI:       'advertising.manage_ai',
  ADVERTISING_RUN_AI:          'advertising.run_ai',
  ADVERTISING_VIEW_FORECASTS:  'advertising.view_forecasts',

  // Offer Flyer — internal offer preparation (staff paste → designer sheet)
  /** Open the internal Offer Preparation workspace: pick a client, paste their offer list, review products and generate the designer Google Sheet. */
  OFFER_PREPARE: 'offer.prepare',

  // Product Catalog — staff review of client-submitted products
  /** Approve / reject products submitted by clients through their product library link. */
  CATALOG_REVIEW_SUBMISSIONS: 'catalog.review_submissions',

  // Clients / Services — granular "add" perms (separate from settings.access)
  /** Open the Clients module (list + per-client dashboard). Admins bypass pre-migration. */
  CLIENTS_VIEW:    'clients.view',
  /** Create new clients (e.g. + Add client in the task form). */
  CLIENTS_CREATE:  'clients.create',
  /** Create new services (e.g. + Add service in the task form). */
  SERVICES_CREATE: 'services.create',

  // Settings
  SETTINGS_ACCESS:              'settings.access',
  SETTINGS_MANAGE_DESIGNATIONS: 'settings.manage_designations',
  SETTINGS_MANAGE_COMPANY:      'settings.manage_company',

  // Recruitment / Careers module
  RECRUITMENT_VIEW:      'recruitment.view',
  RECRUITMENT_EDIT:      'recruitment.edit',
  RECRUITMENT_DELETE:    'recruitment.delete',
  RECRUITMENT_INTERVIEW: 'recruitment.interview',
  RECRUITMENT_ADMIN:     'recruitment.admin',
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
  PERMS.AGREEMENTS_VIEW_PRICING,
] as const

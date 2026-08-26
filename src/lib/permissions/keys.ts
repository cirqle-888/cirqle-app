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
  /**
   * Base key: the Reports index and any report that carries no money.
   * NOT sufficient on its own for the financial reports below — those all sat
   * behind this single key, which meant granting a bookkeeper the client
   * profitability report also handed them Cirqle's burn rate, runway and every
   * employee's earnings. Split three ways so a finance role can be shaped.
   */
  REPORTS_VIEW: 'reports.view',
  /** Cirqle's OWN money: company P&L, burn rate, runway, department P&L, cost attribution. */
  REPORTS_VIEW_COMPANY_FINANCIALS: 'reports.view_company_financials',
  /** CLIENT money: profitability, department growth, billing reconciliation. */
  REPORTS_VIEW_CLIENT_FINANCIALS: 'reports.view_client_financials',
  /** PEOPLE money: earnings by role, contribution analysis, the commission what-if planner. */
  REPORTS_VIEW_PEOPLE_EARNINGS: 'reports.view_people_earnings',

  // Tasks
  TASKS_VIEW_OWN:     'tasks.view_own',
  TASKS_VIEW_ALL:     'tasks.view_all',
  /**
   * Restrict task visibility to the services assigned to the employee
   * (employee_services junction), plus tasks they personally worked on.
   * Opt-in: with neither this nor view_all, legacy behaviour (all tasks) holds.
   */
  TASKS_VIEW_BY_SERVICE: 'tasks.view_by_service',
  /**
   * Restrict task visibility to the viewer's own org unit — their department,
   * team, branch or region and everything beneath it (org_unit_members +
   * org_unit_scopes). Opt-in; see SCOPE_BY_UNIT for the cross-module version.
   */
  TASKS_VIEW_BY_UNIT: 'tasks.view_by_unit',
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
  /**
   * The middle rung between view_own and view_all: see the contributions of
   * everyone in the viewer's own org unit — department, team, branch or region
   * — and every unit beneath it. Ignored when view_all is also held.
   */
  CONTRIBUTIONS_VIEW_UNIT:     'contributions.view_unit',
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
  /**
   * A designer's own queue (the My Work board) — see requests ASSIGNED TO YOU
   * and advance them through To Do → Working → Delivered → Done.
   *
   * Deliberately not a weaker REQUESTS_MANAGE: it grants no sight of anyone
   * else's requests, and the action behind it re-checks assignment per row and
   * refuses cancel / reject / archive / reassign. Holding this does NOT imply
   * requests.view — the inbox stays closed.
   */
  REQUESTS_WORK_OWN:      'requests.work_own',
  REQUESTS_ACTIVITY_VIEW: 'requests.activity.view',
  INTAKE_LINKS_MANAGE:    'intake_links.manage',
  AGENCY_LINKS_MANAGE:    'agency_links.manage',

  // Social Media Calendar — content planner feeding the Requests inbox
  SOCIAL_VIEW:   'social.view',
  SOCIAL_MANAGE: 'social.manage',

  // Social Hub — connected Meta assets (Pages/Instagram), insights, publishing
  /** Connect/disconnect Meta assets (Pages, Instagram accounts) for clients. */
  SOCIAL_CONNECT:       'social.connect',
  /** View social dashboards: reach, views, engagement, content performance. */
  SOCIAL_VIEW_INSIGHTS: 'social.view_insights',
  /** Create/edit social posts and send them for approval. */
  SOCIAL_PUBLISH:       'social.publish',
  /** Approve posts and schedule/publish them to Meta. */
  SOCIAL_APPROVE:       'social.approve',
  /** Arrange creatives in the Instagram feed grid and share it for approval. */
  SOCIAL_PLAN_FEED:     'social.plan_feed',

  // Leads CRM — Meta Lead Ads land here (migration 20260812123000)
  /** Open the Leads module (list + client lead sections). */
  LEADS_VIEW:   'leads.view',
  /** Create/edit/assign leads, change status, configure automation rules. */
  LEADS_MANAGE: 'leads.manage',

  // Field Marketing — door-to-door territory map + visits (migration 20260821120000)
  /** Open the Field Marketing module: territory map, place list, visit history. */
  FIELD_VIEW:   'field.view',
  /** Add/edit places, log visits, change status, assign reps, manage territories, convert. */
  FIELD_MANAGE: 'field.manage',

  // Packages — a committed bundle of work: one agreed price, a list of what's
  // included, and a bulk invoice line. Replaces the retired Client Agreements
  // module (migration 20260814110000).
  /** Open the Packages module: what's committed, delivered and still owed. */
  PACKAGES_VIEW:   'packages.view',
  /** Create/edit/close packages and set their price and extra-work rate. */
  PACKAGES_MANAGE: 'packages.manage',

  // Marketing asset ownership (migration 20260814140000). Assigning an asset
  // moves reporting, leads and billing between parties, so it is its own key
  // rather than riding on social.manage.
  /** Change which client owns a Page, IG account, ad account or lead form. */
  ASSETS_ASSIGN:      'assets.assign',
  /** See Cirqle's own accounts and internal marketing performance. */
  ASSETS_VIEW_CIRQLE: 'assets.view_cirqle',

  // Service Scope — cross-module restriction (see src/lib/scope/service-scope.ts).
  // Dimension-qualified names so a future scope.by_branch sits beside these.
  /**
   * RESTRICTION: the holder only sees the services assigned to them
   * (employee_services) and only the clients who buy those services.
   * Leave OFF for admin / task-manager / finance designations — they see all.
   * Opt-in: without it, behaviour is unchanged.
   */
  SCOPE_BY_SERVICE: 'scope.by_service',
  /**
   * RESTRICTION: the holder only sees their own org unit — the department,
   * team, branch or region they are a member of, plus every unit beneath it,
   * and the clients/services those units are mapped to. The cross-module form
   * of TASKS_VIEW_BY_UNIT / CONTRIBUTIONS_VIEW_UNIT.
   * Opt-in: without it, behaviour is unchanged.
   */
  SCOPE_BY_UNIT:    'scope.by_unit',
  /** Explicit escape hatch: overrides SCOPE_BY_SERVICE / SCOPE_BY_UNIT and shows everything. */
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
  /** Departments, teams, branches, regions, client groups + their managers,
   *  members and revenue scopes (migration 20260807100000). */
  SETTINGS_MANAGE_ORG:          'settings.manage_org',

  // Ownership Platform — the second earning stream, alongside contributions.
  /** Create/edit ownership programs and rules (revenue share, profit share,
   *  incentives, bonuses). Exposes company profit and everyone's share. */
  PAYROLL_MANAGE_OWNERSHIP:     'payroll.manage_ownership',

  // Recruitment / Careers module
  RECRUITMENT_VIEW:      'recruitment.view',
  RECRUITMENT_EDIT:      'recruitment.edit',
  RECRUITMENT_DELETE:    'recruitment.delete',
  RECRUITMENT_INTERVIEW: 'recruitment.interview',
  RECRUITMENT_ADMIN:     'recruitment.admin',

  // Performance Scorecards (migration 028)
  /** Open the Performance page, score employees/applicants, edit criteria and apply ratings. */
  PERFORMANCE_MANAGE:    'performance.manage',
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

/**
 * CRITICAL permissions — grants that expose confidential money or personal
 * data (client pricing, per-employee earnings & performance, salaries, agency
 * margins, private names) or that can grant further access. The designations
 * editor shows a red "Critical" badge on these and asks for confirmation
 * before enabling one, and the employee form warns when the chosen
 * designation carries any — so a mis-assigned role (the "gave a client-success
 * exec the Reviewer role and leaked pricing" incident) is caught at a glance.
 *
 * PURELY ADVISORY: membership here changes labeling only, never enforcement.
 */
export const CRITICAL_PERMS: ReadonlySet<string> = new Set<string>([
  // Client pricing & billing amounts
  PERMS.TASKS_VIEW_PRICING,
  PERMS.BILLING_VIEW_AMOUNTS,
  PERMS.BILLING_VIEW_PRICING,
  PERMS.BILLING_VIEW_LINE_PRICING,
  // A package's whole point is its agreed price, so there is no field-level
  // split here — seeing the page means seeing what the client pays.
  PERMS.PACKAGES_VIEW,
  PERMS.CASHBOOK_VIEW_AMOUNTS,
  // Report money layers — the company's own P&L and everyone's earnings are at
  // least as sensitive as the figures they aggregate.
  PERMS.REPORTS_VIEW_COMPANY_FINANCIALS,
  PERMS.REPORTS_VIEW_PEOPLE_EARNINGS,
  // Advertising money layers (migration 027)
  PERMS.ADVERTISING_VIEW_FINANCIALS,
  PERMS.ADVERTISING_VIEW_BILLING,
  PERMS.ADVERTISING_MANAGE_BUDGET,
  // Per-employee earnings & performance
  PERMS.CONTRIBUTIONS_VIEW_EARNINGS,
  PERMS.CONTRIBUTIONS_VIEW_ALL,
  // Narrower than view_all, but still other people's performance data.
  PERMS.CONTRIBUTIONS_VIEW_UNIT,
  // Salaries
  PERMS.PAYROLL_VIEW_AMOUNTS,
  PERMS.PAYROLL_EDIT,
  // Ownership: sets what everyone earns from company revenue and profit, and
  // exposes the profit figure itself.
  PERMS.PAYROLL_MANAGE_OWNERSHIP,
  // Personal data (names are private by design; full profiles include them)
  PERMS.EMPLOYEES_REVEAL_NAMES,
  PERMS.EMPLOYEES_VIEW_FULL,
  // Power to grant everything above
  PERMS.SETTINGS_MANAGE_DESIGNATIONS,
])

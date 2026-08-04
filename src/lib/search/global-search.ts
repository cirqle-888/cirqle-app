'use server'

/**
 * Global search (⌘K) — the server-scoped replacement for the palette's old
 * browser-side queries.
 *
 * WHY SERVER-SIDE: the palette used the anon-key client to search tasks,
 * invoices, clients, employees, ad projects, quotations, PAYROLL and CASHBOOK
 * with no gating at all. Search is the discovery layer — an unscoped search
 * undermines every module's own filtering, because a restricted employee could
 * surface hidden clients or payroll rows by name even when the module pages
 * would refuse to show them.
 *
 * TWO GATES, applied per category, mirroring the module the result links to:
 *   1. PERMISSION — a category is queried only when the viewer could open its
 *      module (billing.view_invoices, payroll.view, cashbook.view, …). Search
 *      must never surface what the destination page would refuse to render.
 *   2. DEPARTMENT (service scope) — client-linked rows are filtered through
 *      the shared Service Scope engine: out-of-department clients and their
 *      tasks/invoices/quotations/projects disappear. Rows with no client stay
 *      visible (internal work), unconfigured clients stay visible — identical
 *      conventions to every scoped module.
 *
 * ARCHITECTURE RULE: no visibility logic lives here. Everything delegates to
 * src/lib/scope/service-scope.ts + the permission model.
 *
 * NOTE ('use server'): only async functions may be exported from this module —
 * a type re-export compiles into a value reference and crashes the whole
 * action module at evaluation.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import {
  loadServiceScope, isServiceRestricted, scopeRowsByService,
} from '@/lib/scope/service-scope'

interface GlobalSearchResults {
  tasks: any[]
  invoices: any[]
  clients: any[]
  employees: any[]
  projects: any[]
  quotations: any[]
  payroll: any[]
  cashbook: any[]
}

const EMPTY: GlobalSearchResults = {
  tasks: [], invoices: [], clients: [], employees: [],
  projects: [], quotations: [], payroll: [], cashbook: [],
}

export async function globalSearch(q: string): Promise<GlobalSearchResults> {
  const term = q.trim().toLowerCase()
  if (!term) return EMPTY

  const me = await loadCurrentUser().catch(() => null)
  // Unlike page loaders (which fail open behind the auth middleware), a bare
  // server action can be invoked without a session — return nothing.
  if (!me) return EMPTY

  const admin = createAdminClient()
  const scope = await loadServiceScope(admin, me, 'global')
  const restricted = isServiceRestricted(scope)

  // Category gates mirror the destination module's own view permission.
  const canInvoices   = me.isAdmin || hasPermission(me, PERMS.BILLING_VIEW_INVOICES)
  const canQuotations = me.isAdmin || hasPermission(me, PERMS.BILLING_VIEW_QUOTATIONS)
  const canClients    = me.isAdmin || hasPermission(me, PERMS.CLIENTS_VIEW)
  const canEmployees  = me.isAdmin || hasPermission(me, PERMS.EMPLOYEES_VIEW)
  const canPayroll    = me.isAdmin || hasPermission(me, PERMS.PAYROLL_VIEW)
  const canCashbook   = me.isAdmin || hasPermission(me, PERMS.CASHBOOK_VIEW)
  const canAdvertising = me.isAdmin || hasPermission(me, PERMS.ADVERTISING_VIEW)

  // Department rule for client-linked rows: no client → internal, visible;
  // client with no pricing rows → unconfigured, visible; otherwise must
  // intersect the viewer's departments.
  const clientOk = (clientId: string | null | undefined) =>
    !restricted || !clientId || !scope.clientServices.has(clientId) || scope.visibleClientIds.has(clientId)

  // Over-fetch scoped categories so post-filtering can still fill 5 slots.
  const LIMIT = 5
  const FETCH = restricted ? 25 : LIMIT

  const none = Promise.resolve({ data: [] as any[] })
  const [tasksRes, invoicesRes, clientsRes, employeesRes, projectsRes, quotationsRes, payrollRes, cashbookRes] = await Promise.all([
    admin.from('tasks')
      .select('id, title, status, task_date, client_id, service_id, client:clients(name)')
      .ilike('title', `%${term}%`).is('deleted_at', null).limit(FETCH),
    canInvoices
      ? admin.from('invoices')
          .select('id, invoice_number, status, total_amount, client_id, client:clients(name)')
          .or(`invoice_number.ilike.%${term}%,notes.ilike.%${term}%`).limit(FETCH)
      : none,
    canClients
      ? admin.from('clients')
          .select('id, name, code')
          .or(`name.ilike.%${term}%,code.ilike.%${term}%`).limit(FETCH)
      : none,
    canEmployees
      ? admin.from('employees')
          .select('id, name, email')
          .or(`name.ilike.%${term}%,email.ilike.%${term}%`).limit(LIMIT)
      : none,
    canAdvertising
      ? admin.from('ad_projects')
          .select('id, campaign_name, client_id, client:clients(name)')
          .ilike('campaign_name', `%${term}%`).limit(FETCH)
      : none,
    canQuotations
      ? admin.from('quotations')
          .select('id, quotation_number, status, client_id, client:clients(name)')
          .ilike('quotation_number', `%${term}%`).limit(FETCH)
      : none,
    canPayroll
      ? admin.from('payroll')
          .select('id, payslip_number, month, year, status, employee:employees(name)')
          .ilike('payslip_number', `%${term}%`).limit(LIMIT)
      : none,
    canCashbook
      ? admin.from('cashbook_entries')
          .select('id, description, amount, entry_date')
          .ilike('description', `%${term}%`).limit(LIMIT)
      : none,
  ])

  return {
    tasks: scopeRowsByService((tasksRes.data ?? []) as any[], scope, t => t.service_id)
      .filter(t => clientOk(t.client_id)).slice(0, LIMIT),
    invoices: ((invoicesRes.data ?? []) as any[]).filter(i => clientOk(i.client_id)).slice(0, LIMIT),
    clients: ((clientsRes.data ?? []) as any[]).filter(c => clientOk(c.id)).slice(0, LIMIT),
    employees: (employeesRes.data ?? []) as any[],
    projects: ((projectsRes.data ?? []) as any[]).filter(p => clientOk(p.client_id)).slice(0, LIMIT),
    quotations: ((quotationsRes.data ?? []) as any[]).filter(qt => clientOk(qt.client_id)).slice(0, LIMIT),
    payroll: (payrollRes.data ?? []) as any[],
    cashbook: (cashbookRes.data ?? []) as any[],
  }
}

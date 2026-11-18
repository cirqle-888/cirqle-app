/**
 * Which clients an employee works with, by DEPARTMENT.
 *
 * A department is a service category (Settings → Departments). An employee's
 * departments are the ones assigned to them in Settings, plus the department
 * of any single service assigned to them directly — the same two assignment
 * levels lib/scope/service-scope.ts reads. A client's departments are its
 * manual override when it has one, otherwise the departments of the services
 * it buys — `clientDepartmentIds` in lib/clients/department-filter.ts, the rule
 * the Clients page already files clients by. Nothing new is stored.
 *
 * A client is visible when its departments and the employee's overlap.
 *
 * Who is NOT restricted (sees every client):
 *   · admins, and anyone holding `scope.view_all` (Settings can grant it to a
 *     role that should see every client);
 *   · an employee with no departments assigned at all. A half-configured
 *     rollout must never lock anybody out; it shows everything instead, the
 *     same product rule as service scope.
 * A read failure also falls back to unrestricted, never to an empty list.
 *
 * A client with NO department (buys nothing yet, no override) is hidden from a
 * restricted employee: it is in nobody's department until someone files it.
 */
import { hasPermission, type CurrentUser } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { clientDepartmentIds } from '@/lib/clients/department-filter'
import type { createAdminClient } from '@/lib/supabase/admin'

type Admin = ReturnType<typeof createAdminClient>

export interface DepartmentClientScope {
  /** False = sees every client; `clientIds` is then empty and unused. */
  restricted: boolean
  /** The employee's departments (service category ids). */
  departmentIds: Set<string>
  /** Clients visible when restricted. */
  clientIds: Set<string>
}

const UNRESTRICTED: DepartmentClientScope = { restricted: false, departmentIds: new Set(), clientIds: new Set() }

/** Pure: client id → its departments, override first, else what it buys. */
export function departmentsByClient(
  clients: readonly { id: string; department_id?: string | null }[],
  pricing: readonly { client_id: string | null; service_id: string | null }[],
  serviceDepartment: ReadonlyMap<string, string | null>,
): Map<string, string[]> {
  const derived: Record<string, string[]> = {}
  for (const p of pricing) {
    if (!p.client_id || !p.service_id) continue
    const dept = serviceDepartment.get(p.service_id)
    if (!dept) continue
    const list = (derived[p.client_id] ||= [])
    if (!list.includes(dept)) list.push(dept)
  }
  return new Map(clients.map(c => [c.id, clientDepartmentIds(c, derived)]))
}

/** Pure: the clients whose departments overlap the employee's. */
export function clientsInDepartments(
  clientDepartments: ReadonlyMap<string, readonly string[]>,
  employeeDepartments: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>()
  for (const [clientId, depts] of clientDepartments) {
    if (depts.some(d => employeeDepartments.has(d))) out.add(clientId)
  }
  return out
}

/** Pure: does this viewer skip the restriction entirely? */
export function isDepartmentUnrestricted(me: CurrentUser | null): boolean {
  if (!me) return true
  if (me.isAdmin) return true
  return hasPermission(me, PERMS.SCOPE_VIEW_ALL)
}

/** The employee's departments; null on a read failure. */
async function employeeDepartmentIds(admin: Admin, employeeId: string): Promise<Set<string> | null> {
  const [cats, direct] = await Promise.all([
    admin.from('employee_service_categories').select('category_id').eq('employee_id', employeeId),
    admin.from('employee_services').select('service_id').eq('employee_id', employeeId),
  ])
  if (cats.error || direct.error) return null
  const ids = new Set<string>((cats.data || []).map((r: { category_id: string }) => r.category_id))
  const serviceIds = (direct.data || []).map((r: { service_id: string }) => r.service_id)
  if (serviceIds.length) {
    const { data, error } = await admin.from('services').select('category_id').in('id', serviceIds)
    if (error) return null
    for (const s of (data || []) as { category_id: string | null }[]) if (s.category_id) ids.add(s.category_id)
  }
  return ids
}

/** Load the scope once per request. */
export async function loadDepartmentClientScope(
  admin: Admin,
  me: CurrentUser | null,
): Promise<DepartmentClientScope> {
  if (isDepartmentUnrestricted(me) || !me?.employeeId) return UNRESTRICTED
  const departmentIds = await employeeDepartmentIds(admin, me.employeeId)
  if (!departmentIds || departmentIds.size === 0) return UNRESTRICTED

  const [clients, services, pricing] = await Promise.all([
    admin.from('clients').select('id, department_id'),
    admin.from('services').select('id, category_id'),
    (async () => {
      // Paginated: client_service_pricing is close to PostgREST's 1000-row cap.
      const all: { client_id: string | null; service_id: string | null }[] = []
      for (let page = 0; page < 100; page++) {
        const { data, error } = await admin.from('client_service_pricing')
          .select('client_id, service_id').eq('is_active', true)
          .range(page * 1000, page * 1000 + 999)
        if (error) return null
        all.push(...((data || []) as { client_id: string | null; service_id: string | null }[]))
        if ((data || []).length < 1000) break
      }
      return all
    })(),
  ])
  if (clients.error || services.error || !pricing) return UNRESTRICTED

  const serviceDepartment = new Map(
    ((services.data || []) as { id: string; category_id: string | null }[]).map(s => [s.id, s.category_id]),
  )
  const byClient = departmentsByClient(
    (clients.data || []) as { id: string; department_id: string | null }[], pricing, serviceDepartment)
  return { restricted: true, departmentIds, clientIds: clientsInDepartments(byClient, departmentIds) }
}

/** Filter a client list by the scope; unrestricted returns it unchanged. */
export function scopeClientsByDepartment<T extends { id: string }>(rows: T[], scope: DepartmentClientScope): T[] {
  return scope.restricted ? rows.filter(r => scope.clientIds.has(r.id)) : rows
}

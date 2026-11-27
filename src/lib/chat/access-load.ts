import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CurrentUser } from '@/lib/permissions/check'
import { loadServiceScope } from '@/lib/scope/service-scope'
import { visibleEmployeeIds } from '@/lib/scope/employee-scope'
import type { ChatAccessContext, ChatAccessRule, ChatAccessMode } from './access'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, 'public', any>

/** The admin's rules. A database without the table yet simply has none. */
export async function loadChatAccessRules(admin: Admin): Promise<ChatAccessRule[]> {
  const { data, error } = await admin
    .from('chat_access_rules')
    .select('subject_type, subject_id, mode, department_ids, employee_ids')
  if (error) return []
  return (data ?? []).map(r => ({
    subjectType: r.subject_type as 'department' | 'employee',
    subjectId: r.subject_id as string,
    mode: r.mode as ChatAccessMode,
    departmentIds: (r.department_ids as string[] | null) ?? [],
    employeeIds: (r.employee_ids as string[] | null) ?? [],
  }))
}

/**
 * employee → departments. A department is a service category; a person is in
 * the categories assigned to them and in the category of every service
 * assigned to them directly — the same reading the rest of the app uses.
 */
export async function loadDepartmentsByEmployee(admin: Admin): Promise<Map<string, Set<string>>> {
  const [cats, direct, services] = await Promise.all([
    admin.from('employee_service_categories').select('employee_id, category_id'),
    admin.from('employee_services').select('employee_id, service_id'),
    admin.from('services').select('id, category_id'),
  ])
  const out = new Map<string, Set<string>>()
  const add = (emp: string, dept: string) => {
    let set = out.get(emp)
    if (!set) { set = new Set(); out.set(emp, set) }
    set.add(dept)
  }
  for (const r of (cats.data ?? []) as { employee_id: string; category_id: string }[]) {
    if (r.employee_id && r.category_id) add(r.employee_id, r.category_id)
  }
  const categoryOf = new Map(((services.data ?? []) as { id: string; category_id: string | null }[]).map(s => [s.id, s.category_id]))
  for (const r of (direct.data ?? []) as { employee_id: string; service_id: string }[]) {
    const dept = categoryOf.get(r.service_id)
    if (r.employee_id && dept) add(r.employee_id, dept)
  }
  return out
}

export async function loadAdminIds(admin: Admin): Promise<Set<string>> {
  const { data } = await admin.from('employees').select('id, designation:designation_id(is_admin)')
  const out = new Set<string>()
  for (const e of (data ?? []) as { id: string; designation: { is_admin?: boolean } | { is_admin?: boolean }[] | null }[]) {
    const d = Array.isArray(e.designation) ? e.designation[0] : e.designation
    if (d?.is_admin === true) out.add(e.id)
  }
  return out
}

export interface UnitLines {
  unitsByEmployee: Map<string, Set<string>>
  unitDepartmentsByEmployee: Map<string, Set<string>>
}

/**
 * Business-unit teams (lib/units): non-admin members of ACTIVE units → their
 * units, and those units' departments. Empty before the units migration.
 * A read failure other than "not installed" throws — a unit line must not
 * silently disappear.
 */
export async function loadUnitLines(admin: Admin, adminIds: ReadonlySet<string>): Promise<UnitLines> {
  const out: UnitLines = { unitsByEmployee: new Map(), unitDepartmentsByEmployee: new Map() }
  const { data: members, error } = await admin.from('business_unit_members').select('unit_id, employee_id')
  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01' || /does not exist|schema cache/i.test(error.message ?? '')) return out
    throw new Error(`Could not read unit teams: ${error.message}`)
  }
  if (!members?.length) return out
  const { data: units, error: uErr } = await admin.from('business_units').select('id, category_ids').eq('is_active', true)
  if (uErr) throw new Error(`Could not read units: ${uErr.message}`)
  const departmentsOf = new Map(((units ?? []) as { id: string; category_ids: string[] | null }[]).map(u => [u.id, u.category_ids ?? []]))
  for (const m of members as { unit_id: string; employee_id: string }[]) {
    if (adminIds.has(m.employee_id) || !departmentsOf.has(m.unit_id)) continue
    const u = out.unitsByEmployee.get(m.employee_id) ?? new Set<string>()
    u.add(m.unit_id)
    out.unitsByEmployee.set(m.employee_id, u)
    const d = out.unitDepartmentsByEmployee.get(m.employee_id) ?? new Set<string>()
    for (const c of departmentsOf.get(m.unit_id) ?? []) d.add(c)
    out.unitDepartmentsByEmployee.set(m.employee_id, d)
  }
  return out
}

/** Everything canChat() needs, for the person asking. */
export async function loadChatAccess(admin: Admin, me: CurrentUser, preloadedRules?: ChatAccessRule[]): Promise<ChatAccessContext> {
  const [rules, departmentsByEmployee, adminIds, scope] = await Promise.all([
    preloadedRules ? Promise.resolve(preloadedRules) : loadChatAccessRules(admin),
    loadDepartmentsByEmployee(admin),
    loadAdminIds(admin),
    loadServiceScope(admin, me, 'global'),
  ])
  if (me.isAdmin) adminIds.add(me.employeeId)
  const [mine, lines] = await Promise.all([visibleEmployeeIds(admin, scope), loadUnitLines(admin, adminIds)])
  return {
    rules,
    departmentsByEmployee,
    adminIds,
    defaultVisible: viewerId => (viewerId === me.employeeId ? mine : null),
    ...lines,
  }
}

/**
 * Just the unit lines and what they depend on — for checks made on behalf of
 * someone other than the signed-in person (who gets a push, who may read a
 * conversation). No default-visibility: unit lines never need it.
 */
export async function loadUnitLineContext(admin: Admin): Promise<ChatAccessContext> {
  const [rules, adminIds] = await Promise.all([loadChatAccessRules(admin), loadAdminIds(admin)])
  const lines = await loadUnitLines(admin, adminIds)
  return { rules, departmentsByEmployee: new Map(), adminIds, defaultVisible: () => null, ...lines }
}

/** Does anyone stand behind a unit line? One small query, for the fast paths. */
export async function anyUnitLines(admin: Admin): Promise<boolean> {
  const { count, error } = await admin.from('business_unit_members').select('employee_id', { count: 'exact', head: true })
  return !error && (count ?? 0) > 0
}

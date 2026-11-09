/**
 * Which department a piece of WORK belongs to, and filtering work lists by it.
 *
 * A department in this app is a service category (`service_categories`) — the
 * same thing Settings → Departments edits, the Clients page groups by and the
 * department P&L reports sum over. Nothing new is stored here: a task's
 * department is its service's category, exactly as lib/dashboard/department-facts
 * and lib/reports/contribution-analysis already derive it. One derivation, one
 * place, so Tasks, Contributions and the money reports can never disagree about
 * which department a job sat in.
 *
 * Why a filter at all: the Tasks and Contributions boards could already be
 * narrowed to one SERVICE, which is a finer question than anyone running a
 * department asks. "Show me Social Media" means a dozen services, and picking
 * them one at a time is not an answer to it.
 *
 * Pure and dependency-free, so both the server pages and the client components
 * can share it and the tests need no DB.
 */

/** A department, as the filter needs it. `service_categories` row, trimmed. */
export interface Department {
  id: string
  name: string
}

/**
 * Stands for "no department" — work whose service sits in no category, or that
 * carries no service at all (internal jobs, imported rows).
 *
 * A real id can never collide with it: category ids are uuids. Without the
 * sentinel, unclassified work would be unreachable through the filter, and
 * unclassified work is exactly what somebody auditing a department goes
 * looking for. Same sentinel value as lib/clients/department-filter so the two
 * filters read the same in a URL.
 */
export const NO_DEPARTMENT = '__none__'

/** service id → its department id (null when the service has no category). */
export function serviceDepartmentMap(
  services: readonly { id: string; category_id?: string | null }[],
): Map<string, string | null> {
  return new Map(services.map(s => [s.id, s.category_id ?? null]))
}

/**
 * The department a task counts as being in — never null, so callers can
 * compare straight against a selection.
 *
 * A service the map has never heard of (inactive, or outside a restricted
 * viewer's service scope) resolves to NO_DEPARTMENT rather than silently
 * matching whichever department was asked for.
 */
export function taskDepartmentId(
  serviceId: string | null | undefined,
  serviceDepartments: Map<string, string | null>,
): string {
  if (!serviceId) return NO_DEPARTMENT
  return serviceDepartments.get(serviceId) ?? NO_DEPARTMENT
}

/**
 * Does this task belong to any of the selected departments?
 *
 * ANY, not ALL — a task has exactly one department, so stacking two means
 * "either". An empty selection is not a filter: everything matches.
 */
export function matchesDepartments(
  selected: readonly string[],
  serviceId: string | null | undefined,
  serviceDepartments: Map<string, string | null>,
): boolean {
  if (selected.length === 0) return true
  return selected.includes(taskDepartmentId(serviceId, serviceDepartments))
}

/** Options for the department dropdown, in the order Settings displays them. */
export function departmentFilterOptions(
  departments: readonly Department[],
  /** Drop the "No department" row — for a list that has no unclassified work. */
  includeNone = true,
): { value: string; label: string }[] {
  const opts = departments.map(d => ({ value: d.id, label: d.name }))
  return includeNone ? [...opts, { value: NO_DEPARTMENT, label: 'No department' }] : opts
}

/** A department's label, for a filter chip. '' when the id is unknown. */
export function departmentLabel(
  id: string,
  departments: readonly Department[],
): string {
  if (id === NO_DEPARTMENT) return 'No department'
  return departments.find(d => d.id === id)?.name ?? ''
}

/**
 * The service ids inside a department — what a server-side query filters on,
 * since `tasks` carries a service, not a department.
 *
 * NO_DEPARTMENT returns the services belonging to no category; a task with a
 * null service_id is not a service id and is the caller's business (see the
 * Tasks page's DB-search mode).
 */
export function servicesInDepartment(
  departmentId: string,
  services: readonly { id: string; category_id?: string | null }[],
): string[] {
  const want = departmentId === NO_DEPARTMENT ? null : departmentId
  return services.filter(s => (s.category_id ?? null) === want).map(s => s.id)
}

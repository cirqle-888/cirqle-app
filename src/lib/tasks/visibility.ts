/**
 * Task-visibility resolution.
 *
 * COMPATIBILITY SHIM. The real implementation now lives in
 * src/lib/scope/service-scope.ts, which generalises this beyond tasks (it also
 * scopes clients, service pickers and any other list). These exports are kept
 * so the existing Tasks and Contributions call sites keep working unchanged;
 * they migrate to the new API in Phase 2, after which this file is deleted.
 *
 *   'all'      — tasks.view_all / scope.view_all (or admin): every task
 *   'services' — restricted to assigned services, plus tasks personally worked on
 *   'legacy'   — neither: unchanged historical behaviour (all tasks)
 */

import type { CurrentUser } from '@/lib/permissions/check'
import type { createAdminClient } from '@/lib/supabase/admin'
import {
  resolveServiceScopeMode,
  type ServiceScopeMode,
} from '@/lib/scope/service-scope'

export type TaskVisibilityMode = ServiceScopeMode

export function resolveTaskVisibilityMode(me: CurrentUser | null): TaskVisibilityMode {
  return resolveServiceScopeMode(me, 'tasks')
}

/**
 * Service ids assigned to an employee via the employee_services junction.
 * Graceful pre-migration: a missing table yields an empty list, which callers
 * treat as "no services assigned".
 *
 * NOTE: loadServiceScope() distinguishes a read FAILURE (degrade to
 * unrestricted) from a genuine empty set; this legacy helper cannot. New code
 * should use loadServiceScope instead.
 */
export async function fetchEmployeeServiceIds(
  supabase: ReturnType<typeof createAdminClient>,
  employeeId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from('employee_services')
    .select('service_id')
    .eq('employee_id', employeeId)
  if (error) return []
  return (data || []).map((r: { service_id: string }) => r.service_id)
}

/**
 * Apply the visibility mode to an already-fetched task list.
 * `ownTaskIds` keeps tasks the viewer has personal history on visible even if
 * the task's service isn't (or no longer is) assigned to them.
 */
export function filterTasksByVisibility<T extends { id?: string; service_id?: string | null }>(
  tasks: T[],
  mode: TaskVisibilityMode,
  myServiceIds: Iterable<string>,
  ownTaskIds: Iterable<string> = [],
): T[] {
  if (mode !== 'services') return tasks
  const svc = new Set(myServiceIds)
  // An employee with no assignments sees everything — a half-configured
  // rollout must never lock anyone out (mirrors isServiceRestricted()).
  if (svc.size === 0) return tasks
  const own = new Set(ownTaskIds)
  return tasks.filter(t =>
    (t.service_id != null && svc.has(t.service_id)) || (t.id != null && own.has(t.id)),
  )
}

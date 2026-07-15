import { PERMS } from '@/lib/permissions/keys'
import type { CurrentUser } from '@/lib/permissions/check'
import { userCanSee } from '@/lib/permissions/strip'
import type { createAdminClient } from '@/lib/supabase/admin'

/**
 * Task-visibility resolution — single source of truth used by the Tasks page,
 * Contributions page and anything else that lists tasks.
 *
 *   'all'      — tasks.view_all (or admin): every task
 *   'services' — tasks.view_by_service: only tasks whose service is assigned
 *                to the viewer (employee_services), plus tasks they personally
 *                worked on (assignments / contributions / scores)
 *   'legacy'   — neither perm: unchanged historical behaviour (all tasks),
 *                so nothing changes until the restriction is explicitly granted
 */
export type TaskVisibilityMode = 'all' | 'services' | 'legacy'

export function resolveTaskVisibilityMode(me: CurrentUser | null): TaskVisibilityMode {
  if (!me || me.isAdmin || userCanSee(me, PERMS.TASKS_VIEW_ALL)) return 'all'
  if (userCanSee(me, PERMS.TASKS_VIEW_BY_SERVICE)) return 'services'
  return 'legacy'
}

/**
 * Service ids assigned to an employee via the employee_services junction.
 * Graceful pre-migration: a missing table yields an empty list, which callers
 * treat as "no services assigned".
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
  const own = new Set(ownTaskIds)
  return tasks.filter(t =>
    (t.service_id != null && svc.has(t.service_id)) || (t.id != null && own.has(t.id)),
  )
}

/**
 * Which workspaces an employee sees, and whether "All Workspace" is still
 * theirs. Pure, so the rule can be tested without a database — actions.ts is
 * 'use server' and may only export async functions.
 */

export interface WorkspaceRow {
  id: string
  is_system: boolean
  /** Set = a personal workspace. The column is absent before its migration. */
  owner_employee_id?: string | null
}

const ownerOf = (r: WorkspaceRow) => r.owner_employee_id ?? null

/**
 * Whether someone has been ASSIGNED to a workspace. Only a shared one counts:
 * a personal workspace is something the employee made, and making it must not
 * take away the "All Workspace" view they had before.
 */
export function hasAssignment(memberOf: WorkspaceRow[]): boolean {
  return memberOf.some(r => ownerOf(r) === null)
}

/**
 * The rows `employeeId` may see, in the order given.
 *
 * Another employee's personal workspace is their private arrangement, so it is
 * in nobody else's list. Managers otherwise see everything (they administer
 * the shared ones). Someone assigned to shared workspaces lives in those, with
 * their own personal ones beside them. Someone assigned nowhere keeps "All
 * Workspace", plus whatever they made themselves.
 */
export function visibleWorkspaces<T extends WorkspaceRow>(
  rows: T[],
  memberIdsByWorkspace: ReadonlyMap<string, string[]>,
  employeeId: string,
  manager: boolean,
): T[] {
  const usable = rows.filter(r => ownerOf(r) === null || ownerOf(r) === employeeId)
  if (manager) return usable
  const mine = usable.filter(r => (memberIdsByWorkspace.get(r.id) ?? []).includes(employeeId))
  return hasAssignment(mine) ? mine : usable.filter(r => r.is_system || mine.includes(r))
}

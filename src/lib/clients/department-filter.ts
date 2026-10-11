/**
 * Which departments a client belongs to, and filtering the list by them.
 *
 * The Clients page could already GROUP by department — headings over the full
 * list — but not narrow to one. Grouping answers "who belongs where?";
 * filtering answers "show me only the Social Media clients", which is the
 * question somebody running one department actually has, and scrolling past
 * four other headings to reach their own section is not an answer to it.
 *
 * A client's departments come from one of two places — an override stored on
 * the client, or, by default, the services it buys (`clientDepartments`,
 * derived server-side). Either way one client can sit in several, so the
 * match is an intersection rather than an equality. Precedence between the
 * two lives in `clientDepartmentIds` below and nowhere else.
 *
 * Pure and dependency-free.
 */

/**
 * The departments a client counts as being in.
 *
 * Two sources, and the override wins:
 *
 *   · `department_id` on the client — set by hand, for the ownership question
 *     the services cannot answer (a brand-new client buys nothing yet; a
 *     Social Media client that bought one Print job derives into both).
 *   · otherwise the DERIVED set, from the services the client buys. This is
 *     the original behaviour and still the default: every client has a NULL
 *     override until somebody deliberately sets one.
 *
 * Override means override, not "and also": a client set to Branding is in
 * Branding, full stop. The derived set is still computed and shown beside it
 * in the UI, so a disagreement between what a client is filed under and what
 * it actually buys is visible rather than silent.
 */
export function clientDepartmentIds(
  client: { id: string; department_id?: string | null },
  clientDepartments: Record<string, string[]>,
): string[] {
  if (client.department_id) return [client.department_id]
  return clientDepartments[client.id] ?? []
}

/**
 * Is this client filed somewhere other than where its services say?
 *
 * Only ever true for a client with an override AND services outside it —
 * which is the case worth showing, because one of the two is wrong.
 */
export function departmentOverrideDiffers(
  client: { id: string; department_id?: string | null },
  clientDepartments: Record<string, string[]>,
): boolean {
  if (!client.department_id) return false
  const derived = clientDepartments[client.id] ?? []
  if (derived.length === 0) return false
  return !(derived.length === 1 && derived[0] === client.department_id)
}

/**
 * Stands for "buys nothing from any department".
 *
 * A real id can never collide with it: department ids are uuids. Without it
 * the clients with no services at all — new ones, mostly — would be
 * unreachable through the filter, and those are exactly the ones somebody
 * goes looking for.
 */
export const NO_DEPARTMENT = '__none__'

/**
 * Keep the clients that belong to any of the selected departments.
 *
 * ANY, not ALL: selecting Social Media and Print means "either", because a
 * client that buys from both is still a Social Media client. An empty
 * selection is not a filter — it returns everything, rather than nothing.
 */
export function filterByDepartments<T extends { id: string; department_id?: string | null }>(
  clients: readonly T[],
  selected: readonly string[],
  clientDepartments: Record<string, string[]>,
): T[] {
  if (selected.length === 0) return [...clients]
  const want = new Set(selected)
  const wantNone = want.has(NO_DEPARTMENT)
  return clients.filter(c => {
    const deps = clientDepartmentIds(c, clientDepartments)
    if (deps.length === 0) return wantNone
    return deps.some(d => want.has(d))
  })
}

/** Options for the department dropdown, in the order Settings displays them. */
export function departmentFilterOptions(
  departments: readonly { id: string; name: string }[],
): { value: string; label: string }[] {
  return [
    ...departments.map(d => ({ value: d.id, label: d.name })),
    { value: NO_DEPARTMENT, label: 'No department' },
  ]
}

/**
 * Labels for the selected ids, for the removable chips above the list.
 *
 * An id with no matching department — a department archived since the filter
 * was set — is dropped rather than shown as a blank chip.
 */
export function selectedDepartmentLabels(
  selected: readonly string[],
  departments: readonly { id: string; name: string }[],
): { value: string; label: string }[] {
  const byId = new Map(departments.map(d => [d.id, d.name]))
  return selected
    .map(value => ({
      value,
      label: value === NO_DEPARTMENT ? 'No department' : byId.get(value) ?? '',
    }))
    .filter(chip => chip.label !== '')
}

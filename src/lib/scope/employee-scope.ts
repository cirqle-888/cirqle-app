/**
 * Which COLLEAGUES a viewer may see.
 *
 * Task scoping answers "whose work is this?"; this answers "who else exists?".
 * They are different questions and were previously unrelated: an employee
 * restricted to their own services still received the entire staff list — every
 * CQID, and every real name in the page payload — in the Tasks assignee filter,
 * the contribution pickers and chat.
 *
 * THE RULE: you see the people you could actually work with, i.e. anyone whose
 * effective services intersect yours. A designer doing Offer Flyers and one
 * doing Social Media share nothing, so neither appears to the other.
 *
 * WHY SERVICES AND NOT A DEPARTMENT FIELD: org_units exists but is empty, and
 * no employee row carries a unit. Assigned services (direct ∪ category) are the
 * only populated signal for "what part of the business is this person in", and
 * they are already the basis for task visibility — so the two agree by
 * construction instead of drifting.
 *
 * FAIL-OPEN, deliberately, matching filterTasksByVisibility:
 *   • mode 'all' (admins, tasks.view_all) → everyone
 *   • viewer with NO assigned services    → everyone, so a half-configured
 *                                            account is never left alone in an
 *                                            empty org
 * You are always visible to yourself.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ServiceScope } from './service-scope'

// Matches the loose client type the rest of the scope layer accepts — the
// service-role client is constructed in several places with slightly different
// generics, and pinning it tighter here only rejects valid callers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, 'public', any>

/**
 * effective services per employee = direct assignments ∪ every service inside
 * an assigned category. The category half is resolved at READ time for the same
 * reason service-scope does it: adding a service to a category must reach
 * everyone in that category without re-assignment.
 */
async function loadEffectiveServicesByEmployee(admin: Admin): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  const add = (empId: string, svcId: string) => {
    let set = out.get(empId)
    if (!set) { set = new Set(); out.set(empId, set) }
    set.add(svcId)
  }

  const [direct, cats, services] = await Promise.all([
    admin.from('employee_services').select('employee_id, service_id'),
    admin.from('employee_service_categories').select('employee_id, category_id'),
    admin.from('services').select('id, category_id'),
  ])

  for (const r of (direct.data ?? []) as { employee_id: string; service_id: string }[]) {
    if (r.employee_id && r.service_id) add(r.employee_id, r.service_id)
  }

  const byCategory = new Map<string, string[]>()
  for (const s of (services.data ?? []) as { id: string; category_id: string | null }[]) {
    if (!s.category_id) continue
    const list = byCategory.get(s.category_id) ?? []
    list.push(s.id)
    byCategory.set(s.category_id, list)
  }
  for (const r of (cats.data ?? []) as { employee_id: string; category_id: string }[]) {
    for (const svcId of byCategory.get(r.category_id) ?? []) add(r.employee_id, svcId)
  }

  return out
}

/**
 * Ids of the employees `scope`'s viewer may see, or `null` for "no restriction"
 * — which callers should treat as "show everyone" rather than "show nobody".
 * Null rather than a full set so a caller cannot accidentally narrow to a
 * stale snapshot of the roster.
 */
export async function visibleEmployeeIds(
  admin: Admin,
  scope: ServiceScope,
): Promise<Set<string> | null> {
  if (scope.mode !== 'services') return null
  if (scope.serviceIds.size === 0) return null      // half-configured → no narrowing
  if (!scope.employeeId) return null

  const effective = await loadEffectiveServicesByEmployee(admin)
  const mine = scope.serviceIds

  const visible = new Set<string>([scope.employeeId])   // always yourself
  for (const [empId, theirs] of effective) {
    for (const svc of theirs) {
      if (mine.has(svc)) { visible.add(empId); break }
    }
  }
  return visible
}

/** Narrow a list of employee rows to those the viewer may see. */
export function scopeEmployeeList<T extends { id: string }>(
  rows: T[],
  visible: Set<string> | null,
): T[] {
  if (!visible) return rows
  return rows.filter(r => visible.has(r.id))
}

/**
 * Remove `name` unless the viewer may reveal names.
 *
 * The house standard, stated in the social calendar's designer picker: "the
 * name never reaches the browser in the first place — a stronger guarantee
 * than masking it at render time." Tasks and contributions were masking at
 * render (dn() shows the CQID) while still shipping every name in the payload,
 * readable from devtools.
 */
export function stripEmployeeNames<T extends { name?: string | null }>(
  rows: T[],
  canRevealNames: boolean,
): T[] {
  if (canRevealNames) return rows
  return rows.map(r => ({ ...r, name: null }))
}

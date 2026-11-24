/**
 * Who may chat with whom — the admin's rules, decided in one pure place.
 *
 * A rule belongs to a department or to one person. A person's own rule wins
 * over their departments' rules; several department rules merge to the most
 * generous one. With no rule at all the old behaviour stays: you can reach the
 * people you share work with (see lib/scope/employee-scope.ts).
 *
 * Admins are never cut off: anyone can reach an admin and an admin can reach
 * anyone, so a rule can never leave a person with no route to the owner.
 *
 * A direct chat needs BOTH sides to be allowed. The reverse direction is only
 * checked against an explicit rule — the no-rule default was always one-way.
 */

export type ChatAccessMode = 'everyone' | 'own_department' | 'custom' | 'none'

export interface ChatAccessRule {
  subjectType: 'department' | 'employee'
  subjectId: string
  mode: ChatAccessMode
  departmentIds: string[]
  employeeIds: string[]
}

export interface ChatAccessContext {
  rules: readonly ChatAccessRule[]
  /** employee id → departments they work in */
  departmentsByEmployee: ReadonlyMap<string, ReadonlySet<string>>
  adminIds: ReadonlySet<string>
  /**
   * The no-rule default for a viewer: the colleagues they share work with, or
   * null for "no restriction". Only ever consulted for the person asking.
   */
  defaultVisible: (viewerId: string) => ReadonlySet<string> | null
}

export interface EffectiveRule {
  mode: ChatAccessMode
  departmentIds: Set<string>
  employeeIds: Set<string>
  /** Where it came from — shown to the admin. */
  source: 'employee' | 'department'
}

const GENEROSITY: Record<ChatAccessMode, number> = { none: 0, own_department: 1, custom: 2, everyone: 3 }

/** The rule that applies to one person, or null when nothing was set for them. */
export function effectiveRule(ctx: ChatAccessContext, employeeId: string): EffectiveRule | null {
  const own = ctx.rules.find(r => r.subjectType === 'employee' && r.subjectId === employeeId)
  if (own) {
    return { mode: own.mode, departmentIds: new Set(own.departmentIds), employeeIds: new Set(own.employeeIds), source: 'employee' }
  }
  const depts = ctx.departmentsByEmployee.get(employeeId) ?? new Set<string>()
  const mine = ctx.rules.filter(r => r.subjectType === 'department' && depts.has(r.subjectId))
  if (!mine.length) return null
  const out: EffectiveRule = { mode: 'none', departmentIds: new Set(), employeeIds: new Set(), source: 'department' }
  for (const r of mine) {
    if (GENEROSITY[r.mode] > GENEROSITY[out.mode]) out.mode = r.mode
    if (r.mode === 'custom') {
      r.departmentIds.forEach(d => out.departmentIds.add(d))
      r.employeeIds.forEach(e => out.employeeIds.add(e))
    }
  }
  return out
}

function sharesDepartment(ctx: ChatAccessContext, a: string, b: string): boolean {
  const da = ctx.departmentsByEmployee.get(a), db = ctx.departmentsByEmployee.get(b)
  if (!da || !db) return false
  for (const d of da) if (db.has(d)) return true
  return false
}

/** May `from` reach `to` under `from`'s own rule (one direction)? */
function reaches(ctx: ChatAccessContext, from: string, to: string, useDefault: boolean): boolean {
  const rule = effectiveRule(ctx, from)
  if (!rule) {
    if (!useDefault) return true
    const visible = ctx.defaultVisible(from)
    return !visible || visible.has(to)
  }
  switch (rule.mode) {
    case 'everyone': return true
    case 'none': return false
    case 'own_department': return sharesDepartment(ctx, from, to)
    case 'custom': {
      if (sharesDepartment(ctx, from, to) || rule.employeeIds.has(to)) return true
      for (const d of ctx.departmentsByEmployee.get(to) ?? []) if (rule.departmentIds.has(d)) return true
      return false
    }
  }
}

/** May these two hold a direct chat, and may `viewer` see / add `other`? */
export function canChat(ctx: ChatAccessContext, viewer: string, other: string): boolean {
  if (viewer === other) return true
  if (ctx.adminIds.has(viewer) || ctx.adminIds.has(other)) return true
  return reaches(ctx, viewer, other, true) && reaches(ctx, other, viewer, false)
}

/** Narrow a list of people to those `viewer` may chat with. */
export function reachable<T extends { id: string }>(ctx: ChatAccessContext, viewer: string, people: readonly T[]): T[] {
  return people.filter(p => p.id !== viewer && canChat(ctx, viewer, p.id))
}

/** A department channel is for that department's people, and admins. */
export function canSeeDepartmentChannel(ctx: ChatAccessContext, viewer: string, departmentId: string | null): boolean {
  if (!departmentId) return true
  if (ctx.adminIds.has(viewer)) return true
  return ctx.departmentsByEmployee.get(viewer)?.has(departmentId) ?? false
}

export const ACCESS_MODE_LABEL: Record<ChatAccessMode, string> = {
  everyone: 'Everyone',
  own_department: 'Own department only',
  custom: 'Own department + chosen',
  none: 'No direct chats',
}

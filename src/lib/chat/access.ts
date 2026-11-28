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
 *
 * BUSINESS UNITS (lib/units) sit on top of all of this: a non-admin on a
 * unit's team chats only with their own unit and with admins. Crossing that
 * line needs a PERSON-level rule on either side — "Everyone", or the other
 * person named. Department-level rules never cross it. The database applies
 * the same line to every chat read (chat_unit_blocked() in migration
 * 20261128100000), so live updates obey it too; keep the two in step.
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
  /**
   * Non-admin members of active business units → their unit ids. Absent or
   * empty = no unit boundary (before the units migration, or nobody on a team).
   */
  unitsByEmployee?: ReadonlyMap<string, ReadonlySet<string>>
  /** Those members' units' departments, for department channels. */
  unitDepartmentsByEmployee?: ReadonlyMap<string, ReadonlySet<string>>
  /** Cirqle's office team: no unit line stands between them and a unit's team. */
  officeIds?: ReadonlySet<string>
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

/** A person-level rule on `from` that lets them reach `to` across a unit line. */
function personRuleAllows(ctx: ChatAccessContext, from: string, to: string): boolean {
  const own = ctx.rules.find(r => r.subjectType === 'employee' && r.subjectId === from)
  return !!own && (own.mode === 'everyone' || own.employeeIds.includes(to))
}

/**
 * Do these two (neither an admin) stand on opposite sides of a unit line?
 * Two people outside every unit never do; people on the same unit never do;
 * nor does anyone on Cirqle's office team, with anyone.
 */
export function crossesUnitLine(ctx: ChatAccessContext, a: string, b: string): boolean {
  const units = ctx.unitsByEmployee
  if (!units?.size) return false
  if (ctx.officeIds?.has(a) || ctx.officeIds?.has(b)) return false
  const ua = units.get(a), ub = units.get(b)
  if (!ua?.size && !ub?.size) return false
  if (ua && ub) for (const u of ua) if (ub.has(u)) return false
  return !personRuleAllows(ctx, a, b) && !personRuleAllows(ctx, b, a)
}

/** May these two hold a direct chat, and may `viewer` see / add `other`? */
export function canChat(ctx: ChatAccessContext, viewer: string, other: string): boolean {
  if (viewer === other) return true
  if (ctx.adminIds.has(viewer) || ctx.adminIds.has(other)) return true
  if (crossesUnitLine(ctx, viewer, other)) return false
  return reaches(ctx, viewer, other, true) && reaches(ctx, other, viewer, false)
}

/** Is the viewer on a business unit's team (and so behind a unit line)? */
export function isUnitMember(ctx: ChatAccessContext, viewer: string): boolean {
  return !!ctx.unitsByEmployee?.get(viewer)?.size
}

export interface ConversationFacts {
  departmentId: string | null
  posting: 'all' | 'admins'
  memberIds: readonly string[]
}

/**
 * Is a conversation closed to this viewer by a unit line? Mirrors the
 * database's chat_unit_blocked() exactly:
 *   · not on a unit's team            → never
 *   · admins-only posting (announcements) → never
 *   · a department channel            → closed unless it is one of their unit's departments
 *   · anything else                   → closed when any other non-admin member
 *                                       stands across the line from them (the
 *                                       office team never does)
 */
export function blockedByUnitLine(ctx: ChatAccessContext, viewer: string, conv: ConversationFacts): boolean {
  if (ctx.adminIds.has(viewer) || !isUnitMember(ctx, viewer)) return false
  if (conv.posting === 'admins') return false
  if (conv.departmentId) return !(ctx.unitDepartmentsByEmployee?.get(viewer)?.has(conv.departmentId) ?? false)
  return conv.memberIds.some(m => m !== viewer && !ctx.adminIds.has(m) && crossesUnitLine(ctx, viewer, m))
}

/** Narrow a list of people to those `viewer` may chat with. */
export function reachable<T extends { id: string }>(ctx: ChatAccessContext, viewer: string, people: readonly T[]): T[] {
  return people.filter(p => p.id !== viewer && canChat(ctx, viewer, p.id))
}

/** A department channel is for that department's people, and admins. */
export function canSeeDepartmentChannel(ctx: ChatAccessContext, viewer: string, departmentId: string | null): boolean {
  if (!departmentId) return true
  if (ctx.adminIds.has(viewer)) return true
  // A unit's team: only their unit's departments, whatever else they are assigned.
  if (isUnitMember(ctx, viewer)) return ctx.unitDepartmentsByEmployee?.get(viewer)?.has(departmentId) ?? false
  return ctx.departmentsByEmployee.get(viewer)?.has(departmentId) ?? false
}

export const ACCESS_MODE_LABEL: Record<ChatAccessMode, string> = {
  everyone: 'Everyone',
  own_department: 'Own department only',
  custom: 'Own department + chosen',
  none: 'No direct chats',
}

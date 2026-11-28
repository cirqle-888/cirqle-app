/**
 * Cirqle's office team (pure) — the people who work for the parent company
 * rather than one unit, and what each of them can open.
 *
 * Permissions stay on the person's role (designation): the one set that both
 * the app (lib/permissions/check) and the database (has_permission) enforce,
 * and the one ownership programs, chat access, approvals and notifications
 * are tied to. Giving someone a new role would quietly move them in all of
 * those, so this never does; it only lays the role out per person and says
 * when a role is shared, so a change is never made to someone unseen.
 */

/** Data reach: sees every unit's clients and work. Without it, only what is assigned. */
export const REACH_KEY = 'scope.view_all'

export interface CatalogPerm {
  id: string
  module: string
  key: string
  label: string | null
  description: string | null
  order: number
}

export interface PermGroup {
  module: string
  label: string
  /** Money about people, or control over the app — worth a second look. */
  sensitive: boolean
  perms: CatalogPerm[]
  on: number
}

const MODULE_ORDER = [
  'dashboard', 'capture', 'clients', 'requests', 'tasks', 'contributions', 'social', 'prompt_studio', 'packages',
  'quotations', 'billing', 'invoices', 'cashbook', 'finance', 'bank_reconciliation', 'card_reconciliation',
  'payroll', 'employees', 'recruitment', 'profit_sharing', 'reports', 'assets', 'chat', 'settings',
]

const MODULE_LABEL: Record<string, string> = {
  dashboard: 'Dashboard', capture: 'AI Capture', clients: 'Clients', requests: 'Requests', tasks: 'Tasks',
  contributions: 'Contributions', social: 'Social', prompt_studio: 'Prompt Studio', packages: 'Packages',
  quotations: 'Quotations', billing: 'Billing & invoices', invoices: 'Invoices', cashbook: 'Cash Book',
  finance: 'Finance', bank_reconciliation: 'Bank reconciliation', card_reconciliation: 'Card statements',
  payroll: 'Payroll', employees: 'Employees', recruitment: 'Hiring', profit_sharing: 'Profit sharing',
  reports: 'Reports', assets: 'Marketing assets', chat: 'Chat', settings: 'Settings',
}

const SENSITIVE = new Set(['payroll', 'employees', 'profit_sharing', 'settings'])

const titleCase = (s: string) => s.replace(/[_.]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

export function moduleLabel(module: string): string {
  return MODULE_LABEL[module] ?? titleCase(module)
}

/**
 * The permission catalogue in groups, with how many of each are on. Data-reach
 * keys (scope.*) are left out: reach is shown on its own, as one choice.
 */
export function groupPermissions(catalog: readonly CatalogPerm[], on: ReadonlySet<string>): PermGroup[] {
  const by = new Map<string, CatalogPerm[]>()
  for (const p of catalog) {
    if (p.key.startsWith('scope.')) continue
    by.set(p.module, [...(by.get(p.module) ?? []), p])
  }
  const rank = (m: string) => { const i = MODULE_ORDER.indexOf(m); return i < 0 ? MODULE_ORDER.length : i }
  return [...by.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || moduleLabel(a).localeCompare(moduleLabel(b)))
    .map(([module, perms]) => {
      const sorted = [...perms].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
      return {
        module, label: moduleLabel(module), sensitive: SENSITIVE.has(module) || sorted.some(p => p.key === 'reports.view_people_earnings'),
        perms: sorted, on: sorted.filter(p => on.has(p.key)).length,
      }
    })
}

export interface RosterEmployee { id: string; cqid: string; designationId: string | null }
export interface RosterRole { id: string; name: string; isAdmin: boolean }

export interface OfficePerson {
  employeeId: string
  cqid: string
  roleId: string | null
  roleName: string | null
  isAdmin: boolean
  /** Other people holding the same role — a change to it changes theirs too. */
  sharedWith: string[]
  /** The units whose team they are on. */
  unitIds: string[]
  /** On the office team. */
  office: boolean
  /** On no team and not marked — probably office staff, not yet placed. */
  unplaced: boolean
}

/**
 * Everyone, with who is on the office team. `officeIds` null = the office list
 * is not installed yet: then anyone on no unit's team counts as office.
 */
export function officeRoster(
  employees: readonly RosterEmployee[],
  roles: readonly RosterRole[],
  officeIds: ReadonlySet<string> | null,
  unitsOf: ReadonlyMap<string, readonly string[]>,
): OfficePerson[] {
  const role = new Map(roles.map(r => [r.id, r]))
  const holders = new Map<string, string[]>()
  for (const e of employees) if (e.designationId) holders.set(e.designationId, [...(holders.get(e.designationId) ?? []), e.cqid])
  return employees.map(e => {
    const r = e.designationId ? role.get(e.designationId) : undefined
    const unitIds = [...(unitsOf.get(e.id) ?? [])]
    const office = officeIds ? officeIds.has(e.id) : unitIds.length === 0
    return {
      employeeId: e.id, cqid: e.cqid, roleId: r?.id ?? null, roleName: r?.name ?? null, isAdmin: !!r?.isAdmin,
      sharedWith: r ? (holders.get(r.id) ?? []).filter(c => c !== e.cqid).sort() : [],
      unitIds, office, unplaced: !office && unitIds.length === 0 && !r?.isAdmin,
    }
  }).sort((a, b) => Number(b.office) - Number(a.office) || a.cqid.localeCompare(b.cqid))
}

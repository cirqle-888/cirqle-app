'use server'

/**
 * Departments & Brands (business units) — server actions. Admin only, like Profit Sharing: every
 * action re-checks isAdmin, and nothing is taken from the browser that the
 * server can work out itself. None of these edit a Cash Book entry or an
 * invoice — tags and assignments live in their own tables.
 *
 * Nothing here calls logActivity: the activity feed is visible to people who
 * must not see department results.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/permissions/check'
import { round2 } from '@/lib/calculations/currency'
import { slugify, validateDepartment, type RevenueBasis } from '@/lib/units/engine'
import { loadDepartments, searchInvoices } from '@/lib/units/load'
import { unitsOfEmployee } from '@/lib/units/membership'
import { loadServiceScope } from '@/lib/scope/service-scope'
import { isNavItemVisible, navSections } from '@/lib/nav-sections'
import type { CurrentUser } from '@/lib/permissions/check'

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string }

const ROOT = '/dashboard/units'
const MIGRATION = 'supabase/migrations/20261127100000_business_units.sql'
const UUID = /^[0-9a-f-]{36}$/i

function fail(e: unknown): { ok: false; error: string } {
  const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e)
  if (/business_unit\w*.*(does not exist|schema cache)|PGRST205/i.test(msg)) {
    return { ok: false, error: `Departments & Brands needs its database migration first (${MIGRATION}).` }
  }
  return { ok: false, error: msg }
}

const done = () => revalidatePath(ROOT, 'layout')

// ═══ Departments ════════════════════════════════════════════════════════════

export interface DepartmentInput {
  id?: string | null
  name: string
  kind: 'department' | 'brand'
  color: string | null
  categoryIds: string[]
  revenueBasis: RevenueBasis
  sharesGeneralCosts: boolean
  /** YYYY-MM */
  startMonth: string
  /** YYYY-MM or null */
  endMonth: string | null
  notes: string | null
  isActive: boolean
  teamSeesResults: boolean
  /** Empty = no profit-and-loss agreement; the result stays with Cirqle. */
  partners: { employeeId: string; sharePct: number }[]
  members: { employeeId: string; role: 'lead' | 'member' }[]
}

function lastDay(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

export async function saveDepartment(input: DepartmentInput): Promise<Result<{ slug: string }>> {
  const g = await requireAdmin()
  if (!g.ok) return g
  try {
    const admin = createAdminClient()
    const existing = await loadDepartments(admin)
    const id = input.id && UUID.test(input.id) ? input.id : null
    if (input.id && !id) return { ok: false, error: 'Unknown department.' }
    if (!/^\d{4}-\d{2}$/.test(input.startMonth)) return { ok: false, error: 'Pick the month the agreement starts.' }
    if (input.endMonth && !/^\d{4}-\d{2}$/.test(input.endMonth)) return { ok: false, error: 'The end month is not valid.' }

    const employeeIds = [...new Set([...input.partners, ...input.members].map(p => p.employeeId).filter(e => UUID.test(e)))]
    const { data: emps, error: empErr } = employeeIds.length
      ? await admin.from('employees').select('id, cqid').in('id', employeeIds)
      : { data: [], error: null }
    if (empErr) return fail(empErr)
    const cqid = new Map(((emps ?? []) as { id: string; cqid: string | null }[]).map(e => [e.id, e.cqid ?? '']))
    const partners = input.partners
      .filter(p => UUID.test(p.employeeId))
      .map(p => ({ employeeId: p.employeeId, cqid: cqid.get(p.employeeId) ?? '', sharePct: round2(Number(p.sharePct)) }))
    if (partners.some(p => !cqid.has(p.employeeId))) return { ok: false, error: 'A partner is not a known employee.' }
    const members = [...new Map(input.members.filter(m => UUID.test(m.employeeId)).map(m => [m.employeeId, m])).values()]
      .map(m => ({ employeeId: m.employeeId, role: m.role === 'lead' ? 'lead' as const : 'member' as const }))
    if (members.some(m => !cqid.has(m.employeeId))) return { ok: false, error: 'A team member is not a known employee.' }

    const { data: cats } = await admin.from('service_categories').select('id')
    const known = new Set(((cats ?? []) as { id: string }[]).map(c => c.id))
    const categoryIds = [...new Set(input.categoryIds)].filter(c => known.has(c))

    const draft = {
      id: id ?? 'new', name: input.name.trim(), categoryIds, partners,
      startsOn: `${input.startMonth}-01`, endsOn: input.endMonth ? lastDay(input.endMonth) : null, isActive: input.isActive,
    }
    const v = validateDepartment(draft, existing)
    if (!v.ok) return { ok: false, error: v.errors.join(' ') }
    // A team confined to a unit with no work would see nothing at all.
    if (members.length && !categoryIds.length) return { ok: false, error: 'Pick the work this unit covers before adding its team.' }

    // A slug that is unique and stays put once made (bookmarks, focus links).
    const current = id ? existing.find(d => d.id === id) : undefined
    let slug = current?.slug ?? slugify(draft.name)
    if (!current) {
      const taken = new Set(existing.map(d => d.slug))
      for (let n = 2; taken.has(slug); n++) slug = `${slugify(draft.name)}-${n}`
    }

    const row = {
      name: draft.name, slug, kind: input.kind === 'brand' ? 'brand' : 'department',
      color: input.color?.trim() || null, category_ids: categoryIds, team_sees_results: !!input.teamSeesResults,
      revenue_basis: input.revenueBasis === 'invoiced' ? 'invoiced' : 'collected',
      shares_general_costs: !!input.sharesGeneralCosts, starts_on: draft.startsOn, ends_on: draft.endsOn,
      notes: input.notes?.trim() || null, is_active: !!input.isActive, updated_at: new Date().toISOString(),
    }
    let deptId = id
    if (deptId) {
      const { error } = await admin.from('business_units').update(row).eq('id', deptId)
      if (error) return fail(error)
    } else {
      const { data, error } = await admin.from('business_units')
        .insert({ ...row, created_by: g.employeeId, display_order: existing.length }).select('id').single()
      if (error) return fail(error)
      deptId = data.id as string
    }

    // Replace the partners: delete then insert, so a removed partner goes.
    const { error: delErr } = await admin.from('business_unit_partners').delete().eq('unit_id', deptId)
    if (delErr) return fail(delErr)
    if (partners.length) {
      const { error: insErr } = await admin.from('business_unit_partners').insert(partners.map((p, i) => ({
        unit_id: deptId, employee_id: p.employeeId, share_pct: p.sharePct, display_order: i,
      })))
      if (insErr) return fail(insErr)
    }

    // The team: replaced the same way. Who is on it decides who is confined.
    const { error: memDel } = await admin.from('business_unit_members').delete().eq('unit_id', deptId)
    if (memDel) return fail(memDel)
    if (members.length) {
      const { error: memIns } = await admin.from('business_unit_members').insert(members.map(m => ({
        unit_id: deptId, employee_id: m.employeeId, role: m.role,
      })))
      if (memIns) return fail(memIns)
    }

    done()
    return { ok: true, data: { slug } }
  } catch (e) {
    return fail(e)
  }
}

export async function deleteDepartment(id: string): Promise<Result> {
  const g = await requireAdmin()
  if (!g.ok) return g
  if (!UUID.test(id)) return { ok: false, error: 'Unknown department.' }
  try {
    const admin = createAdminClient()
    const { error } = await admin.from('business_units').delete().eq('id', id)
    if (error) return fail(error)
    done()
    return { ok: true }
  } catch (e) {
    return fail(e)
  }
}

// ═══ Invoices ═══════════════════════════════════════════════════════════════

/**
 * Put a whole invoice in one department, leave it out of every department
 * (`null`), or go back to the automatic split by its lines (`'auto'`).
 */
export async function assignInvoice(invoiceId: string, departmentId: string | null | 'auto'): Promise<Result> {
  const g = await requireAdmin()
  if (!g.ok) return g
  if (!UUID.test(invoiceId)) return { ok: false, error: 'Unknown invoice.' }
  if (departmentId && departmentId !== 'auto' && !UUID.test(departmentId)) return { ok: false, error: 'Unknown department.' }
  try {
    const admin = createAdminClient()
    if (departmentId === 'auto') {
      const { error } = await admin.from('business_unit_invoices').delete().eq('invoice_id', invoiceId)
      if (error) return fail(error)
    } else {
      const { error } = await admin.from('business_unit_invoices').upsert({
        invoice_id: invoiceId, unit_id: departmentId, created_by: g.employeeId, created_at: new Date().toISOString(),
      }, { onConflict: 'invoice_id' })
      if (error) return fail(error)
    }
    done()
    return { ok: true }
  } catch (e) {
    return fail(e)
  }
}

export async function findInvoices(q: string): Promise<Result<Awaited<ReturnType<typeof searchInvoices>>>> {
  const g = await requireAdmin()
  if (!g.ok) return g
  try {
    return { ok: true, data: await searchInvoices(createAdminClient(), String(q ?? '')) }
  } catch (e) {
    return fail(e)
  }
}

// ═══ Cash Book tags ═════════════════════════════════════════════════════════

export type EntryTagChoice = { departmentId: string } | 'general' | 'exclude' | 'auto'

/** Tag Cash Book entries: to a department, General (split equally), excluded, or back to automatic. */
export async function tagEntries(entryIds: string[], choice: EntryTagChoice): Promise<Result> {
  const g = await requireAdmin()
  if (!g.ok) return g
  const ids = [...new Set(entryIds)].filter(id => UUID.test(id)).slice(0, 500)
  if (!ids.length) return { ok: false, error: 'Pick at least one entry.' }
  if (typeof choice === 'object' && !UUID.test(choice.departmentId)) return { ok: false, error: 'Unknown department.' }
  try {
    const admin = createAdminClient()
    if (choice === 'auto') {
      const { error } = await admin.from('business_unit_entries').delete().in('entry_id', ids)
      if (error) return fail(error)
      done()
      return { ok: true }
    }
    // A payment received against an invoice is income already counted from
    // the invoice; tagging it as well would count it twice.
    const { data: allocated } = await admin.from('cashbook_invoice_allocations')
      .select('cashbook_entry_id').is('deleted_at', null).in('cashbook_entry_id', ids)
    if ((allocated ?? []).length) return { ok: false, error: 'An invoice payment is already counted through its invoice. Assign the invoice instead.' }

    const rows = ids.map(entry_id => ({
      entry_id,
      unit_id: typeof choice === 'object' ? choice.departmentId : null,
      is_general: choice === 'general',
      is_excluded: choice === 'exclude',
      created_by: g.employeeId,
      created_at: new Date().toISOString(),
    }))
    const { error } = await admin.from('business_unit_entries').upsert(rows, { onConflict: 'entry_id' })
    if (error) return fail(error)
    done()
    return { ok: true }
  } catch (e) {
    return fail(e)
  }
}

/** Cash Book categories whose company payments are General automatically. */
export async function saveGeneralCategories(categoryIds: string[]): Promise<Result> {
  const g = await requireAdmin()
  if (!g.ok) return g
  try {
    const admin = createAdminClient()
    const { data: cats } = await admin.from('cashbook_categories').select('id')
    const known = new Set(((cats ?? []) as { id: string }[]).map(c => c.id))
    const ids = [...new Set(categoryIds)].filter(c => known.has(c))
    const { error } = await admin.from('business_unit_settings')
      .upsert({ id: 1, general_category_ids: ids, updated_at: new Date().toISOString() }, { onConflict: 'id' })
    if (error) return fail(error)
    done()
    return { ok: true }
  } catch (e) {
    return fail(e)
  }
}

// ═══ Access map ═════════════════════════════════════════════════════════════

/** Put a person on a unit's team (as lead or member), or take them off it (null). */
export async function setUnitMember(unitId: string, employeeId: string, role: 'lead' | 'member' | null): Promise<Result> {
  const g = await requireAdmin()
  if (!g.ok) return g
  if (!UUID.test(unitId) || !UUID.test(employeeId)) return { ok: false, error: 'Unknown unit or person.' }
  try {
    const admin = createAdminClient()
    if (role === null) {
      const { error } = await admin.from('business_unit_members').delete().eq('unit_id', unitId).eq('employee_id', employeeId)
      if (error) return fail(error)
    } else {
      const { data: unit, error: uErr } = await admin.from('business_units').select('category_ids').eq('id', unitId).maybeSingle()
      if (uErr) return fail(uErr)
      if (!unit) return { ok: false, error: 'Unknown unit.' }
      if (!((unit as { category_ids?: string[] | null }).category_ids ?? []).length) {
        return { ok: false, error: 'Pick the work this unit covers before adding its team.' }
      }
      const { error } = await admin.from('business_unit_members')
        .upsert({ unit_id: unitId, employee_id: employeeId, role }, { onConflict: 'unit_id,employee_id' })
      if (error) return fail(error)
    }
    done()
    return { ok: true }
  } catch (e) {
    return fail(e)
  }
}

/** Pin a client to one department (it then belongs there alone), or back to "by what it buys" (null). */
export async function setClientDepartment(clientId: string, departmentId: string | null): Promise<Result> {
  const g = await requireAdmin()
  if (!g.ok) return g
  if (!UUID.test(clientId) || (departmentId !== null && !UUID.test(departmentId))) return { ok: false, error: 'Unknown client or department.' }
  try {
    const admin = createAdminClient()
    const { error } = await admin.from('clients').update({ department_id: departmentId }).eq('id', clientId)
    if (error) return fail(error)
    done()
    revalidatePath('/dashboard/clients')
    return { ok: true }
  } catch (e) {
    return fail(e)
  }
}

export interface PersonCheck {
  cqid: string
  designation: string | null
  reach: string
  pages: string[]
  /** null = every client. */
  clients: string[] | null
  clientCount: number
}

/** What one person will see: their reach, the pages they can open, the clients they see. */
export async function checkPerson(employeeId: string): Promise<Result<PersonCheck>> {
  const g = await requireAdmin()
  if (!g.ok) return g
  if (!UUID.test(employeeId)) return { ok: false, error: 'Pick a person.' }
  try {
    const admin = createAdminClient()
    const { data: emp, error } = await admin.from('employees')
      .select('id, cqid, designation_id, designation:designation_id(name, is_admin)').eq('id', employeeId).maybeSingle()
    if (error || !emp) return { ok: false, error: 'Person not found.' }
    const e = emp as unknown as { id: string; cqid: string | null; designation_id: string | null; designation: { name: string; is_admin: boolean } | { name: string; is_admin: boolean }[] | null }
    const d = Array.isArray(e.designation) ? e.designation[0] : e.designation
    const isAdmin = d?.is_admin === true
    const { data: dp } = e.designation_id && !isAdmin
      ? await admin.from('designation_permissions').select('permission:permission_id(key)').eq('designation_id', e.designation_id).eq('allowed', true)
      : { data: [] }
    const keys = new Set(((dp ?? []) as { permission: { key: string } | { key: string }[] | null }[])
      .map(r => (Array.isArray(r.permission) ? r.permission[0] : r.permission)?.key).filter((k): k is string => !!k))
    const person = {
      authId: '', employeeId: e.id, cqid: e.cqid ?? '', email: '', designationId: e.designation_id,
      designationName: d?.name ?? null, isAdmin, isArchived: false, permissions: keys, dateOfBirth: null,
    } as CurrentUser

    const [units, scope] = await Promise.all([unitsOfEmployee(admin, e.id), loadServiceScope(admin, person, 'global')])
    const confined = !isAdmin && units.length > 0
    const can = (k: string) => isAdmin || keys.has(k)
    const pages = navSections.flatMap(s => s.items).filter(i => isNavItemVisible(i, can, isAdmin, confined)).map(i => i.label)

    let clients: string[] | null = null
    let clientCount = 0
    if (scope.mode === 'services') {
      const ids = [...scope.visibleClientIds]
      const { data: names } = ids.length ? await admin.from('clients').select('name').in('id', ids).order('name') : { data: [] }
      clients = ((names ?? []) as { name: string }[]).map(c => c.name)
      clientCount = clients.length
    } else {
      const { count } = await admin.from('clients').select('id', { count: 'exact', head: true }).eq('is_active', true)
      clientCount = count ?? 0
    }
    const reach = isAdmin ? 'Admin — everything'
      : confined ? `Unit team: ${units.map(u => u.name).join(', ')} — only those units, and only the unit-team pages`
      : scope.mode === 'all' ? 'View all — every client and all work'
      : scope.mode === 'legacy' ? 'Org unit — narrowed by their org unit'
      : scope.serviceIds.size ? 'Assigned departments only' : 'Nothing yet — no unit, no View all, nothing assigned'
    return { ok: true, data: { cqid: e.cqid ?? '', designation: d?.name ?? null, reach, pages, clients, clientCount } }
  } catch (err) {
    return fail(err)
  }
}

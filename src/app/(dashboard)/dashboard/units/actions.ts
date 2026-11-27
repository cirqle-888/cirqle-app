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

import 'server-only'
/* eslint-disable @typescript-eslint/no-explicit-any -- rows arrive untyped from PostgREST (see load.ts) */

/**
 * The Cash Book allocation audit (server-only): every company entry in a month,
 * how it is allocated to Cirqle's units now, and — for the ones still waiting —
 * a suggestion with its reason (./suggest).
 *
 * Invoice payments, transfers and rebilled/pass-through money are not shown:
 * they are counted elsewhere or are not a unit's cost. People by CQID only.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAll, fetchAllIn } from '@/lib/supabase/server'
import type { EngineEntry, EntryKind, SplitPart } from './engine'
import { loadShares, type SharesData } from './load'
import { normaliseDescription, phrasesFor, suggestAllocation, type Allocation, type SuggestContext, type Suggestion } from './suggest'

type Admin = SupabaseClient<any, any, any>

export type AllocationStatus = 'unit' | 'split' | 'general' | 'excluded' | 'waiting'

export interface AllocationRow {
  entry: EngineEntry
  status: AllocationStatus
  /** How it is allocated now, in one line. */
  current: string
  /** Was it set by hand (tag or split), or worked out automatically? */
  manual: boolean
  /** The split as entered, for the editor. */
  split: { parts: SplitPart[]; basis: 'percent' | 'amount' } | null
  /** The unit it is tagged to, for the editor. */
  unitId: string | null
  suggestion: Suggestion | null
}

export interface AllocationData {
  month: string
  units: { id: string; name: string; color: string | null; sharesGeneralCosts: boolean }[]
  rows: AllocationRow[]
  shares: SharesData
}

function statusOf(k: EntryKind | undefined): AllocationStatus {
  if (!k) return 'waiting'
  if (k.kind === 'dept') return 'unit'
  if (k.kind === 'split') return 'split'
  if (k.kind === 'general') return 'general'
  return k.how === 'untagged' ? 'waiting' : 'excluded'
}

/** How a tag or split reads as an Allocation (for learning from past entries). */
function allocationOf(entryId: string, shares: SharesData): Allocation | null {
  const split = shares.splits.get(entryId)
  if (split?.parts.length) return { kind: 'split', parts: split.parts }
  const tag = shares.tags.get(entryId)
  if (!tag) return null
  if (tag.isExcluded) return { kind: 'exclude' }
  if (tag.isGeneral) return { kind: 'general' }
  return tag.departmentId ? { kind: 'unit', unitId: tag.departmentId } : null
}

export async function loadAllocation(admin: Admin, month: string): Promise<AllocationData> {
  const shares = await loadShares(admin, { fromMonth: month, toMonth: month })
  const units = shares.departments.filter(d => d.isActive)
  const unitName = new Map(units.map(u => [u.id, u.name]))
  const unitOfCategory = new Map<string, string>()
  for (const u of units) for (const c of u.categoryIds) if (!unitOfCategory.has(c)) unitOfCategory.set(c, u.id)

  // Who is on which unit; CQIDs.
  const unitsOfEmployee = new Map<string, string[]>()
  for (const u of units) for (const m of u.members) unitsOfEmployee.set(m.employeeId, [...(unitsOfEmployee.get(m.employeeId) ?? []), u.id])
  const [emps, clients, pricing, services, catAssign, svcAssign, brandAssign, catBrands] = await Promise.all([
    fetchAll(admin.from('employees').select('id, cqid').order('id')),
    fetchAll(admin.from('clients').select('id, name, department_id').order('id')),
    fetchAll(admin.from('client_service_pricing').select('client_id, service_id').eq('is_active', true).order('client_id')),
    fetchAll(admin.from('services').select('id, category_id').order('id')),
    fetchAll(admin.from('employee_service_categories').select('employee_id, category_id').order('employee_id')),
    fetchAll(admin.from('employee_services').select('employee_id, service_id').order('employee_id')),
    fetchAll(admin.from('employee_brands').select('employee_id, brand_id').order('employee_id')),
    fetchAll(admin.from('service_categories').select('id, name, brand_id').order('id')),
  ])
  const departmentName = new Map(((catBrands.data ?? []) as any[]).map(c => [c.id as string, c.name as string]))
  const cqidOf = new Map(((emps.data ?? []) as any[]).filter(e => e.cqid).map(e => [e.id as string, e.cqid as string]))

  // Which units a client belongs to: its pin, else what it buys.
  const serviceDept = new Map(((services.data ?? []) as any[]).map(s => [s.id as string, s.category_id as string | null]))
  const bought = new Map<string, Set<string>>()
  for (const p of (pricing.data ?? []) as any[]) {
    const d = p.service_id ? serviceDept.get(p.service_id) : null
    if (!p.client_id || !d) continue
    bought.set(p.client_id, (bought.get(p.client_id) ?? new Set()).add(d))
  }
  const unitsOfClient = new Map<string, string[]>()
  const clientName = new Map<string, string>()
  for (const c of (clients.data ?? []) as any[]) {
    clientName.set(c.id, c.name)
    const depts = c.department_id ? [c.department_id as string] : [...(bought.get(c.id) ?? [])]
    const ids = [...new Set(depts.map(d => unitOfCategory.get(d)).filter((u): u is string => !!u))]
    if (ids.length) unitsOfClient.set(c.id, ids)
  }

  // People on no team: the units their assigned departments fall in.
  const deptsOfBrand = new Map<string, string[]>()
  for (const c of (catBrands.data ?? []) as any[]) if (c.brand_id) deptsOfBrand.set(c.brand_id, [...(deptsOfBrand.get(c.brand_id) ?? []), c.id])
  const assignedDepts = new Map<string, Set<string>>()
  const addDept = (emp: string, d: string | null | undefined) => { if (emp && d) assignedDepts.set(emp, (assignedDepts.get(emp) ?? new Set()).add(d)) }
  for (const r of (catAssign.data ?? []) as any[]) addDept(r.employee_id, r.category_id)
  for (const r of (svcAssign.data ?? []) as any[]) addDept(r.employee_id, serviceDept.get(r.service_id))
  for (const r of (brandAssign.data ?? []) as any[]) for (const d of deptsOfBrand.get(r.brand_id) ?? []) addDept(r.employee_id, d)
  const assignedUnitsOfEmployee = new Map<string, string[]>()
  for (const [emp, depts] of assignedDepts) {
    const ids = [...new Set([...depts].map(d => unitOfCategory.get(d)).filter((u): u is string => !!u))]
    if (ids.length) assignedUnitsOfEmployee.set(emp, ids)
  }

  // Learn from every entry allocated by hand so far (any month).
  const manualIds = [...new Set([...shares.tags.keys(), ...shares.splits.keys()])]
  const described = manualIds.length
    ? await fetchAllIn((chunk: string[]) => admin.from('cashbook_entries').select('id, description').in('id', chunk), manualIds)
    : { data: [] }
  const learned = new Map<string, { allocation: Allocation; count: number }>()
  for (const r of (described.data ?? []) as any[]) {
    const key = normaliseDescription(r.description)
    const a = allocationOf(r.id, shares)
    if (!key || !a) continue
    const cur = learned.get(key)
    learned.set(key, { allocation: a, count: (cur?.count ?? 0) + 1 })
  }

  const ctx: SuggestContext = {
    unitName, unitsOfEmployee, cqidOf, unitsOfClient, clientName, learned,
    assignedUnitsOfEmployee, generalUnitIds: units.filter(u => u.sharesGeneralCosts).map(u => u.id),
    unitPhrases: new Map(units.map(u => [u.id, phrasesFor([u.name, ...u.categoryIds.map(c => departmentName.get(c) ?? '')])])),
  }
  const rows: AllocationRow[] = shares.entries
    .filter(e => e.date.slice(0, 7) === month && !e.isTransfer && !e.isInvoiceReceipt && !(e.isPassThrough && !shares.tags.has(e.id) && !shares.splits.has(e.id)))
    .map(e => {
      const k = shares.result.classified.get(e.id)
      const status = statusOf(k)
      const split = shares.splits.get(e.id) ?? null
      const tag = shares.tags.get(e.id)
      const current = status === 'waiting' ? 'Waiting'
        : status === 'excluded' ? (k?.how === 'pass_through' ? 'Pass-through' : 'Left out')
        : status === 'general' ? `General${k?.how === 'category' ? ' (by category)' : ''}`
        : status === 'unit' && k?.kind === 'dept' ? `${unitName.get(k.departmentId) ?? 'A unit'}${k.how === 'service' ? ' (by service)' : ''}`
        : status === 'split' && k?.kind === 'split'
          ? k.parts.map(p => `${unitName.get(p.unitId) ?? 'A unit'} ${Math.round((p.share / (k.parts.reduce((t, x) => t + x.share, 0) || 1)) * 1000) / 10}%`).join(' · ')
          : '—'
      return {
        entry: e, status, current,
        manual: !!tag || !!split,
        split, unitId: tag?.departmentId ?? null,
        suggestion: status === 'waiting'
          ? suggestAllocation({ id: e.id, type: e.type, description: e.description, categoryName: e.categoryName, employeeId: e.employeeId ?? null, clientId: e.clientId }, ctx)
          : null,
      }
    })
    .sort((a, b) => b.entry.date.localeCompare(a.entry.date))

  return {
    month,
    units: units.map(u => ({ id: u.id, name: u.name, color: u.color, sharesGeneralCosts: u.sharesGeneralCosts })),
    rows,
    shares,
  }
}

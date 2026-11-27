import 'server-only'
/* eslint-disable @typescript-eslint/no-explicit-any -- rows arrive untyped from PostgREST: the generated
   database types are stale (see docs/PROFIT-SHARING-DESIGN.md F9), so each read is shaped by hand below. */

/**
 * Business units — read everything the engine needs (server-only).
 *
 * Income is Cirqle's own revenue only. Each invoice's composition (fees and
 * markups vs pass-through and tax) and the order a payment fills it in are the
 * company Profit Sharing module's own rules (lib/profit-sharing/composition),
 * so the two modules can never disagree about what a rupee was.
 *
 * Employees are read by CQID only — never a name.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAll, fetchAllIn } from '@/lib/supabase/server'
import { deriveComposition, laterOf, splitAllocations } from '@/lib/profit-sharing/composition'
import type { Composition, InvoiceAllocation, InvoiceRaw } from '@/lib/profit-sharing/types'
import { lastDayOfMonthISO, monthStartISO } from '@/lib/utils/local-date'
import {
  computeDepartmentShares, monthsBetween, type DeptConfig, type EngineCollection, type EngineEntry,
  type EngineInvoice, type EngineResult, type EntryTag, type RevenueBasis,
} from './engine'

type Admin = SupabaseClient<any, any, any>

const num = (v: unknown) => Number(v ?? 0) || 0
const day = (v: unknown) => String(v ?? '').slice(0, 10)

async function rows<T = any>(p: Promise<{ data: any[] | null; error?: any }>, what: string): Promise<T[]> {
  const r = await p
  if (r.error) throw new Error(`Could not read ${what}: ${r.error.message ?? r.error}`)
  return (r.data ?? []) as T[]
}

/** Has migration 20261127100000_business_units been applied? */
export async function isInstalled(admin: Admin): Promise<boolean> {
  const { error } = await admin.from('business_units').select('id').limit(1)
  return !error
}

export interface Lookups {
  /** Settings → Departments (service categories), with their brand. */
  categories: { id: string; name: string; brand: string | null; isActive: boolean }[]
  /** Cash Book categories, for the General rule. */
  cashbookCategories: { id: string; name: string; type: string | null; group: string | null }[]
  /** Active employees, by CQID. */
  employees: { id: string; cqid: string }[]
}

export async function loadDepartments(admin: Admin): Promise<DeptConfig[]> {
  const [depts, partners, members] = await Promise.all([
    rows(fetchAll(admin.from('business_units').select('*').order('display_order').order('created_at')), 'units'),
    rows(fetchAll(admin.from('business_unit_partners').select('unit_id, employee_id, share_pct, display_order').order('display_order')), 'partners'),
    rows(fetchAll(admin.from('business_unit_members').select('unit_id, employee_id, role').order('unit_id')), 'teams'),
  ])
  const ids = [...new Set([...partners, ...members].map(p => p.employee_id as string))]
  const emps = ids.length
    ? await rows(fetchAllIn((chunk: string[]) => admin.from('employees').select('id, cqid').in('id', chunk), ids), 'CQIDs')
    : []
  const cqid = new Map(emps.map(e => [e.id as string, (e.cqid as string) ?? '']))
  return depts.map(d => ({
    id: d.id, name: d.name, slug: d.slug, kind: (d.kind === 'brand' ? 'brand' : 'department') as DeptConfig['kind'],
    color: d.color ?? null,
    categoryIds: (d.category_ids ?? []) as string[],
    revenueBasis: (d.revenue_basis === 'invoiced' ? 'invoiced' : 'collected') as RevenueBasis,
    sharesGeneralCosts: !!d.shares_general_costs, teamSeesResults: !!d.team_sees_results,
    startsOn: day(d.starts_on), endsOn: d.ends_on ? day(d.ends_on) : null, isActive: !!d.is_active,
    partners: partners.filter(p => p.unit_id === d.id).map(p => ({
      employeeId: p.employee_id, cqid: cqid.get(p.employee_id) ?? '', sharePct: num(p.share_pct),
    })),
    members: members.filter(m => m.unit_id === d.id).map(m => ({
      employeeId: m.employee_id, cqid: cqid.get(m.employee_id) ?? '', role: (m.role === 'lead' ? 'lead' : 'member') as 'lead' | 'member',
    })).sort((x, y) => (x.role === y.role ? x.cqid.localeCompare(y.cqid) : x.role === 'lead' ? -1 : 1)),
  }))
}

export async function loadGeneralCategoryIds(admin: Admin): Promise<string[]> {
  const { data } = await admin.from('business_unit_settings').select('general_category_ids').eq('id', 1).maybeSingle()
  return ((data as { general_category_ids?: string[] } | null)?.general_category_ids ?? []) as string[]
}

export async function loadLookups(admin: Admin): Promise<Lookups> {
  const [cats, brands, cbCats, emps] = await Promise.all([
    rows(fetchAll(admin.from('service_categories').select('id, name, brand_id, is_active, display_order').order('display_order').order('name')), 'departments'),
    rows(fetchAll(admin.from('brands').select('id, name').order('name')), 'brands').catch(() => []),
    rows(fetchAll(admin.from('cashbook_categories').select('id, name, type, category_group, is_active').order('display_order').order('name')), 'Cash Book categories'),
    rows(fetchAll(admin.from('employees').select('id, cqid, is_active').eq('is_active', true).order('cqid')), 'employees'),
  ])
  const brandName = new Map(brands.map(b => [b.id as string, b.name as string]))
  return {
    categories: cats.map(c => ({ id: c.id, name: c.name, brand: c.brand_id ? brandName.get(c.brand_id) ?? null : null, isActive: c.is_active !== false })),
    cashbookCategories: cbCats.filter(c => c.is_active !== false).map(c => ({ id: c.id, name: c.name, type: c.type ?? null, group: c.category_group ?? null })),
    employees: emps.filter(e => e.cqid).map(e => ({ id: e.id, cqid: e.cqid })),
  }
}

export interface SharesData {
  departments: DeptConfig[]
  months: string[]
  result: EngineResult
  generalCategoryIds: string[]
  /** Invoice id → assignment, for the controls. */
  assignments: Map<string, string | null>
}

/**
 * Compute every department from `fromMonth` (YYYY-MM, default: the earliest
 * agreement start) to `toMonth` (default: this month).
 */
export async function loadShares(admin: Admin, opts: { fromMonth?: string; toMonth?: string } = {}): Promise<SharesData> {
  const departments = await loadDepartments(admin)
  const thisMonth = monthStartISO(0).slice(0, 7)
  const earliest = departments.map(d => d.startsOn.slice(0, 7)).sort()[0] ?? thisMonth
  const fromMonth = opts.fromMonth ?? earliest
  const toMonth = opts.toMonth ?? (thisMonth >= fromMonth ? thisMonth : fromMonth)
  const months = monthsBetween(`${fromMonth}-01`, `${toMonth}-01`)
  const start = `${fromMonth}-01`
  const [ty, tm] = toMonth.split('-').map(Number)
  const end = lastDayOfMonthISO(ty, tm)

  const [generalCategoryIds, tagRows, assignRows, services, cbCats] = await Promise.all([
    loadGeneralCategoryIds(admin),
    rows(fetchAll(admin.from('business_unit_entries').select('entry_id, unit_id, is_general, is_excluded').order('entry_id')), 'Cash Book tags'),
    rows(fetchAll(admin.from('business_unit_invoices').select('invoice_id, unit_id').order('invoice_id')), 'invoice assignments'),
    rows(fetchAll(admin.from('services').select('id, category_id').order('id')), 'services'),
    rows(fetchAll(admin.from('cashbook_categories').select('id, name').order('id')), 'Cash Book categories'),
  ])
  const serviceCategory = new Map(services.map(s => [s.id as string, (s.category_id as string | null) ?? null]))
  const cbCatName = new Map(cbCats.map(c => [c.id as string, c.name as string]))
  const tags = new Map<string, EntryTag>(tagRows.map(t => [t.entry_id, {
    departmentId: t.unit_id ?? null, isGeneral: !!t.is_general, isExcluded: !!t.is_excluded,
  }]))
  const assignments = new Map<string, string | null>(assignRows.map(a => [a.invoice_id as string, (a.unit_id as string | null) ?? null]))

  // ── Payments on invoices: every live allocation, dated by its receipt ──
  const allocRows = await rows(fetchAll(admin.from('cashbook_invoice_allocations')
    .select('id, cashbook_entry_id, invoice_id, allocated_amount, created_at').is('deleted_at', null).order('id')), 'invoice payments')
  const receiptIds = [...new Set(allocRows.map(a => a.cashbook_entry_id as string))]
  const receipts = receiptIds.length
    ? await rows(fetchAllIn((chunk: string[]) => admin.from('cashbook_entries').select('id, entry_date').is('deleted_at', null).in('id', chunk), receiptIds), 'receipts')
    : []
  const receiptDate = new Map(receipts.map(r => [r.id as string, day(r.entry_date)]))
  const allocations: InvoiceAllocation[] = allocRows
    .filter(a => receiptDate.has(a.cashbook_entry_id))
    .map(a => ({ entryId: a.cashbook_entry_id, invoiceId: a.invoice_id, amountInr: num(a.allocated_amount), allocatedOn: day(a.created_at) }))

  // Invoices that matter: issued in the range, or paid in it.
  const paidInRange = new Set(allocations
    .filter(a => { const on = laterOf(receiptDate.get(a.entryId) ?? a.allocatedOn, a.allocatedOn); return on >= start && on <= end })
    .map(a => a.invoiceId))
  const issued = await rows(fetchAll(admin.from('invoices').select('id').gte('issue_date', start).lte('issue_date', end).order('id')), 'invoices')
  const invoiceIds = [...new Set([...issued.map(i => i.id as string), ...paidInRange, ...assignments.keys()])]

  const byInvoice = <T>(table: string, cols: string, what: string) => invoiceIds.length
    ? rows<T>(fetchAllIn((chunk: string[]) => admin.from(table).select(cols).in('invoice_id', chunk), invoiceIds), what)
    : Promise.resolve([] as T[])
  const [invRows, itemRows, expenseRows, adRows] = await Promise.all([
    invoiceIds.length
      ? rows(fetchAllIn((chunk: string[]) => admin.from('invoices')
          .select('id, invoice_number, client_id, issue_date, status, exchange_rate, total_amount, total_amount_inr, tax_amount, discount_amount, previous_balance, updated_at, client:clients(name)')
          .in('id', chunk), invoiceIds), 'invoices')
      : Promise.resolve([] as any[]),
    byInvoice<any>('invoice_items', 'invoice_id, total, task_id, service_id', 'invoice lines'),
    byInvoice<any>('invoice_expense_items', 'invoice_id, markup_amount, original_amount_inr', 'invoice expenses'),
    byInvoice<any>('invoice_ad_spend_items', 'invoice_id, amount_inr', 'invoice ad spend'),
  ])
  const taskIds = [...new Set(itemRows.map(i => i.task_id).filter(Boolean) as string[])]
  const tasks = taskIds.length
    ? await rows(fetchAllIn((chunk: string[]) => admin.from('tasks').select('id, service_id').in('id', chunk), taskIds), 'tasks')
    : []
  const taskService = new Map(tasks.map(t => [t.id as string, (t.service_id as string | null) ?? null]))

  const sum = (list: any[], key: string) => {
    const m = new Map<string, number>()
    for (const r of list) m.set(r.invoice_id, (m.get(r.invoice_id) ?? 0) + num(r[key]))
    return m
  }
  const items = sum(itemRows, 'total'), markup = sum(expenseRows, 'markup_amount')
  const originals = sum(expenseRows, 'original_amount_inr'), adSpend = sum(adRows, 'amount_inr')

  const compositions = new Map<string, Composition>()
  const invoices: EngineInvoice[] = invRows.map(r => {
    const raw: InvoiceRaw = {
      id: r.id, clientId: r.client_id ?? null, status: r.status ?? '', exchangeRate: num(r.exchange_rate) || 1,
      totalAmount: num(r.total_amount), totalAmountInr: r.total_amount_inr == null ? null : num(r.total_amount_inr),
      taxAmount: num(r.tax_amount), discountAmount: num(r.discount_amount), previousBalance: num(r.previous_balance),
      updatedOn: r.updated_at ? day(r.updated_at) : null, itemsTotal: items.get(r.id) ?? 0, markupTotal: markup.get(r.id) ?? 0,
      adSpendInr: adSpend.get(r.id) ?? 0, expenseOriginalInr: originals.get(r.id) ?? 0,
    }
    const { composition } = deriveComposition(raw)
    compositions.set(r.id, composition)
    const lines = itemRows.filter(i => i.invoice_id === r.id).map(i => {
      const svc = i.service_id ?? (i.task_id ? taskService.get(i.task_id) ?? null : null)
      return { categoryId: svc ? serviceCategory.get(svc) ?? null : null, amount: num(i.total) }
    })
    const client = Array.isArray(r.client) ? r.client[0] : r.client
    return {
      id: r.id, number: r.invoice_number ?? null, clientId: r.client_id ?? null, clientName: client?.name ?? null,
      issueDate: r.issue_date ? day(r.issue_date) : null, status: r.status ?? '',
      ownInr: Math.max(0, composition.ownInr), totalInr: composition.totalInr, lines,
      override: assignments.has(r.id) ? { departmentId: assignments.get(r.id) ?? null } : undefined,
    }
  })

  const splits = splitAllocations(allocations.filter(a => compositions.has(a.invoiceId)), receiptDate, compositions)
  const collections: EngineCollection[] = splits.map(s => ({ invoiceId: s.invoiceId, entryId: s.entryId, on: s.recognisedOn, ownInr: s.ownInr }))

  // ── Cash Book entries in the range, and the originals of any reversals ──
  const ENTRY_COLS = 'id, entry_date, type, amount_inr, description, category_id, client_id, service_id, transfer_ref, reversal_of, is_billable, scope'
  const entryRows = await rows(fetchAll(admin.from('cashbook_entries').select(ENTRY_COLS)
    .is('deleted_at', null).gte('entry_date', start).lte('entry_date', end).order('id')), 'Cash Book')
  const missing = [...new Set(entryRows.map(e => e.reversal_of).filter((id): id is string => !!id && !entryRows.some(x => x.id === id)))]
  const originalsRows = missing.length
    ? await rows(fetchAllIn((chunk: string[]) => admin.from('cashbook_entries').select(ENTRY_COLS).is('deleted_at', null).in('id', chunk), missing), 'Cash Book originals')
    : []
  const allEntries = [...entryRows, ...originalsRows]
  const ids = allEntries.map(e => e.id as string)

  const [rebilled, wallet] = await Promise.all([
    ids.length ? rows(fetchAllIn((chunk: string[]) => admin.from('invoice_expense_items').select('cashbook_entry_id').in('cashbook_entry_id', chunk), ids), 'rebilled costs') : [],
    ids.length ? rows(fetchAllIn((chunk: string[]) => admin.from('ad_wallet_ledger').select('cashbook_entry_id').eq('direction', 'credit').is('deleted_at', null).in('cashbook_entry_id', chunk), ids), 'ad wallet').catch(() => []) : [],
  ])
  const passIds = new Set([...rebilled, ...wallet].map(r => r.cashbook_entry_id as string))
  const receiptSet = new Set(receiptIds)

  const entries: EngineEntry[] = allEntries.map(e => ({
    id: e.id, date: day(e.entry_date), type: e.type === 'inflow' ? 'inflow' : 'outflow', amountInr: Math.abs(num(e.amount_inr)),
    description: e.description ?? null, categoryId: e.category_id ?? null,
    categoryName: e.category_id ? cbCatName.get(e.category_id) ?? null : null,
    serviceCategoryId: e.service_id ? serviceCategory.get(e.service_id) ?? null : null,
    clientId: e.client_id ?? null, reversalOf: e.reversal_of ?? null, isTransfer: !!e.transfer_ref,
    isInvoiceReceipt: receiptSet.has(e.id) || (e.type === 'inflow' && !!e.client_id && e.scope === 'client'),
    isPassThrough: passIds.has(e.id) || !!e.is_billable,
  }))

  const result = computeDepartmentShares({
    departments, months, invoices, collections, entries, tags, generalCategoryIds: new Set(generalCategoryIds),
  })
  return { departments, months, result, generalCategoryIds, assignments }
}

/** Invoices an admin can assign to a department, newest first (search by number or client name). */
export async function searchInvoices(admin: Admin, q: string): Promise<{ id: string; number: string | null; client: string | null; issueDate: string | null; totalInr: number; status: string }[]> {
  const term = q.trim().replace(/[%,()*]/g, ' ').trim().slice(0, 60)
  const base = () => admin.from('invoices')
    .select('id, invoice_number, issue_date, total_amount_inr, status, client:clients(name)')
    .not('status', 'in', '(draft,cancelled,void)')
    .order('issue_date', { ascending: false }).limit(25)
  let data: any[] = []
  if (!term) {
    const r = await base(); if (r.error) throw new Error(r.error.message); data = r.data ?? []
  } else {
    const { data: clients } = await admin.from('clients').select('id').ilike('name', `%${term}%`).limit(50)
    const clientIds = (clients ?? []).map((c: any) => c.id as string)
    const [byNumber, byClient] = await Promise.all([
      base().ilike('invoice_number', `%${term}%`),
      clientIds.length ? base().in('client_id', clientIds) : Promise.resolve({ data: [], error: null }),
    ])
    if (byNumber.error) throw new Error(byNumber.error.message)
    const seen = new Set<string>()
    data = [...(byNumber.data ?? []), ...((byClient as any).data ?? [])].filter(r => !seen.has(r.id) && seen.add(r.id))
      .sort((x, y) => String(y.issue_date ?? '').localeCompare(String(x.issue_date ?? ''))).slice(0, 25)
  }
  return data.map((r: any) => {
    const client = Array.isArray(r.client) ? r.client[0] : r.client
    return { id: r.id, number: r.invoice_number ?? null, client: client?.name ?? null, issueDate: r.issue_date ? day(r.issue_date) : null, totalInr: num(r.total_amount_inr), status: r.status ?? '' }
  })
}

export interface DeptWork {
  tasks: { id: string; number: string | null; title: string | null; client: string | null; service: string | null; status: string | null; date: string; billingInr: number }[]
  clients: { id: string; name: string; invoices: number; ownInr: number; tasks: number }[]
}

/** The department's tasks in a date range, by its service categories. */
export async function loadDeptTasks(admin: Admin, dept: DeptConfig, from: string, to: string): Promise<DeptWork['tasks']> {
  if (!dept.categoryIds.length) return []
  const svcs = await rows(fetchAll(admin.from('services').select('id, name, category_id').in('category_id', dept.categoryIds).order('id')), 'services')
  if (!svcs.length) return []
  const svcName = new Map(svcs.map(s => [s.id as string, s.name as string]))
  const list = await rows(fetchAllIn((chunk: string[]) => admin.from('tasks')
    .select('id, task_number, title, client_id, service_id, status, task_date, billing_amount_inr, client:clients(name)')
    .is('deleted_at', null).gte('task_date', from).lte('task_date', to).in('service_id', chunk), svcs.map(s => s.id)), 'tasks')
  return list.map(t => {
    const client = Array.isArray(t.client) ? t.client[0] : t.client
    return {
      id: t.id, number: t.task_number != null ? String(t.task_number) : null, title: t.title ?? null,
      client: client?.name ?? null, service: t.service_id ? svcName.get(t.service_id) ?? null : null,
      status: t.status ?? null, date: day(t.task_date), billingInr: num(t.billing_amount_inr),
    }
  }).sort((a, b) => b.date.localeCompare(a.date))
}

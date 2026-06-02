'use client'

import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Download } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { buildHeader, buildExampleRow, buildColumnDefs, parseRowFromSchema, buildInsertRecord, norm as sNorm } from '@/lib/import/engine'
import {
  FIELD_SCHEMA, EMPLOYEE_FIELDS, CLIENT_FIELDS, GROUP_FIELDS, PARAMETER_FIELDS, TOOL_FIELDS,
  EMPLOYEE_EXTRA_EXAMPLES, CLIENT_EXTRA_EXAMPLES, SERVICE_EXTRA_EXAMPLES, JOB_EXTRA_EXAMPLES,
  getContribFields,
} from '@/lib/import/schemas'
import type { ParseContext } from '@/lib/import/types'

// ─── Types ────────────────────────────────────────────────────────────────────
interface RefClient    { id: string; name: string; code: string }
interface RefService   { id: string; name: string }
interface RefEmployee  { id: string; cqid: string; name: string }
interface RefGroup     { id: string; name: string; weight: number }
interface RefParameter { id: string; name: string; group_id: string; weight: number; display_order: number }

interface RefBankAccount  { id: string; name: string }
interface RefCashCategory { id: string; name: string; type: string }

interface Props {
  clients:         RefClient[]
  services:        RefService[]
  employees:       RefEmployee[]
  groups:          RefGroup[]
  parameters:      RefParameter[]
  bankAccounts:    RefBankAccount[]
  cashCategories:  RefCashCategory[]
}

export type ContribSubMode = 'earnings_only' | 'score_pct' | 'param_detail'

export type ImportMode =
  | 'employees'
  | 'clients'
  | 'services'
  | 'groups'
  | 'parameters'
  | 'tools'
  | 'pricing_matrix'
  | 'jobs'
  | 'contributions'
  | 'cashbook_entries'
  | 'invoices'
  | 'invoice_status'
  | 'discounts'

interface ParsedRow {
  _line:    number
  errors:   string[]
  warnings: string[]
  status:   'ok' | 'warn' | 'error'
  [key: string]: any
}

// ─── Mode metadata ────────────────────────────────────────────────────────────
// Flat list kept for backward compatibility (cleanup tab, TABLE_FOR_MODE, etc.)
const MODES: { key: ImportMode; label: string; emoji: string }[] = [
  { key: 'employees',      label: 'Employees',           emoji: '👤' },
  { key: 'clients',        label: 'Clients',             emoji: '🏢' },
  { key: 'services',       label: 'Services',            emoji: '⚙️' },
  { key: 'groups',         label: 'Contribution Groups', emoji: '🗂️' },
  { key: 'parameters',     label: 'Parameters',          emoji: '📊' },
  { key: 'tools',          label: 'Tools',               emoji: '🔧' },
  { key: 'pricing_matrix', label: 'Pricing Matrix',      emoji: '💰' },
  { key: 'jobs',           label: 'Jobs (Tasks)',         emoji: '✅' },
  { key: 'cashbook_entries', label: 'Cashbook Entries',  emoji: '📒' },
  { key: 'contributions',  label: 'Contributions',       emoji: '📈' },
  { key: 'invoices',       label: 'Invoices',            emoji: '🧾' },
  { key: 'invoice_status', label: 'Invoice Status Update', emoji: '🔄' },
  { key: 'discounts',      label: 'Discount History',    emoji: '🎁' },
]

// Tiered grouping — shown in the import UI to guide the user on order
const IMPORT_TIERS: { tier: number; label: string; color: string; hint: string; modes: ImportMode[] }[] = [
  {
    tier: 1,
    label: 'Foundation',
    color: 'emerald',
    hint: 'No dependencies — import these first',
    modes: ['employees', 'clients', 'services', 'groups', 'parameters', 'tools'],
  },
  {
    tier: 2,
    label: 'Pricing',
    color: 'blue',
    hint: 'Needs Clients + Services to exist first',
    modes: ['pricing_matrix'],
  },
  {
    tier: 3,
    label: 'Operations',
    color: 'amber',
    hint: 'Needs Clients + Services. Tasks must exist before cashbook entries that reference them',
    modes: ['jobs', 'cashbook_entries'],
  },
  {
    tier: 4,
    label: 'Financial Records',
    color: 'violet',
    hint: 'Needs Jobs/Tasks + Employees to exist first',
    modes: ['contributions', 'invoices', 'invoice_status', 'discounts'],
  },
]

// ─── Templates ───────────────────────────────────────────────────────────────
// Schema-driven: template header, example row, and column docs all derive from
// FIELD_SCHEMA. To add a field, edit the relevant schema file — no changes here.
const TEMPLATES: Record<ImportMode, { header: string; example: string }> = Object.fromEntries(
  (Object.keys(FIELD_SCHEMA) as ImportMode[]).map(m => [m, {
    header:  buildHeader(FIELD_SCHEMA[m]),
    example: buildExampleRow(FIELD_SCHEMA[m]),
  }])
) as Record<ImportMode, { header: string; example: string }>

// ─── Export configuration ─────────────────────────────────────────────────────
// `orderBy` is tried first; if the column does not exist in the DB schema the
// export falls back to an unordered query so it still succeeds.
const EXPORT_CONFIG: Record<ImportMode, { table: string; orderBy?: string }> = {
  employees:      { table: 'employees',                orderBy: 'cqid' },
  clients:        { table: 'clients',                  orderBy: 'name' },
  services:       { table: 'services',                 orderBy: 'display_order' },
  groups:         { table: 'contribution_groups',      orderBy: 'display_order' },
  parameters:     { table: 'parameters',               orderBy: 'display_order' },
  tools:          { table: 'tools',                    orderBy: 'name' },
  pricing_matrix: { table: 'client_service_pricing',   orderBy: 'client_id' },
  jobs:           { table: 'tasks',                    orderBy: 'task_date' },
  contributions:  { table: 'contribution_scores',      orderBy: 'task_id' },
  cashbook_entries: { table: 'cashbook_entries', orderBy: 'entry_date' },
  invoices:         { table: 'invoices',          orderBy: 'issue_date' },
  invoice_status:   { table: 'invoices',          orderBy: 'invoice_number' },
  discounts:        { table: 'discount_logs',     orderBy: 'created_at' },
}

// ─── CSV output helpers ───────────────────────────────────────────────────────
function csvEscape(v: unknown): string {
  if (v == null) return ''
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}
function toCsv(headers: string[], rows: any[]): string {
  const head = headers.join(',')
  const body = rows.map(r => headers.map(h => csvEscape(r[h])).join(',')).join('\n')
  return head + '\n' + body
}
function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

// ─── Column definitions ───────────────────────────────────────────────────────
// Schema-driven: derived from FIELD_SCHEMA. No manual list needed.
// Kept as a typed alias for any legacy code that still uses COLUMNS[mode].
type ColDef = { col: string; req: boolean; notes: string }
const COLUMNS: Record<ImportMode, ColDef[]> = Object.fromEntries(
  (Object.keys(FIELD_SCHEMA) as ImportMode[]).map(m => [m, buildColumnDefs(FIELD_SCHEMA[m])])
) as Record<ImportMode, ColDef[]>

// ─── CSV helpers ──────────────────────────────────────────────────────────────
function parseCSV(text: string): string[][] {
  const lines: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuote = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuote) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (ch === '"') inQuote = false
      else field += ch
    } else {
      if (ch === '"') inQuote = true
      else if (ch === ',') { row.push(field.trim()); field = '' }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++
        row.push(field.trim()); field = ''
        if (row.some(c => c !== '')) lines.push(row)
        row = []
      } else field += ch
    }
  }
  if (field !== '' || row.length) { row.push(field.trim()); if (row.some(c => c !== '')) lines.push(row) }
  return lines
}

function norm(s: string) { return (s || '').toLowerCase().trim() }

/** Normalise any common date format to YYYY-MM-DD.
 *  Handles: YYYY-MM-DD, M/D/YY, M/D/YYYY, DD-MM-YYYY */
function normalizeDate(raw: string): string {
  const s = raw.trim()
  if (!s) return s
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  // YYYY/MM/DD
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(s)) return s.replace(/\//g, '-')
  // Slash-delimited: D/M/YYYY or M/D/YYYY — default to D/M/YYYY (Indian convention)
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (slash) {
    let [, a, b, y] = slash
    if (y.length === 2) y = (parseInt(y) >= 50 ? '19' : '20') + y
    const aNum = parseInt(a), bNum = parseInt(b)
    let d: string, m: string
    if (aNum > 12) {
      // First part > 12 → must be day (D/M/YYYY)
      d = a; m = b
    } else if (bNum > 12) {
      // Second part > 12 → must be day, so first is month (M/D/YYYY)
      m = a; d = b
    } else {
      // Ambiguous — use D/M/YYYY (Indian convention)
      d = a; m = b
    }
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  // DD-MM-YYYY (e.g. 01-05-2026)
  const dmy = s.match(/^(\d{2})-(\d{2})-(\d{4})$/)
  if (dmy) {
    const [, d, m, y] = dmy
    return `${y}-${m}-${d}`
  }
  
  // Attempt standard JS Date parse (handles "04-December-2023, Monday")
  const parsed = new Date(s)
  if (!isNaN(parsed.getTime())) {
    const y = parsed.getFullYear()
    const m = String(parsed.getMonth() + 1).padStart(2, '0')
    const d = String(parsed.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }

  return s  // return as-is; validation will catch it
}


function downloadTemplate(mode: ImportMode) {
  const { header, example } = TEMPLATES[mode]
  const blob = new Blob([header + '\n' + example], { type: 'text/csv;charset=utf-8;' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${mode}_import_template.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

// ─── Shared UI pieces ─────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: 'ok' | 'warn' | 'error' }) {
  if (status === 'ok')    return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400 font-semibold">OK</span>
  if (status === 'warn')  return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400 font-semibold">WARN</span>
  return                         <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400 font-semibold">ERR</span>
}

function IssueCell({ row }: { row: ParsedRow }) {
  return (
    <td className="px-3 py-2 max-w-[220px]">
      {[...row.errors, ...row.warnings].map((msg, i) => (
        <div key={i} className={`text-[10px] leading-tight ${row.errors.includes(msg) ? 'text-red-400' : 'text-yellow-400'}`}>{msg}</div>
      ))}
    </td>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function ImportClient({ clients, services, employees, groups, parameters, bankAccounts, cashCategories }: Props) {
  const router = useRouter()
  const supabase = createClient()
  const { toasts, dismiss, success, error: toastError } = useToast()

  const [pageTab, setPageTab] = useState<'import' | 'cleanup'>('import')

  // ── Import state ───────────────────────────────────────────────────────────
  const [mode, setMode]     = useState<ImportMode>('employees')
  const [operation, setOperation] = useState<'insert' | 'update' | 'delete'>('insert')
  const [step, setStep]     = useState<'upload' | 'preview' | 'done'>('upload')
  const [rows, setRows]     = useState<ParsedRow[]>([])
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<{ inserted: number; skipped: number; errors: string[] } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Reset operation when changing modes
  useEffect(() => { setOperation('insert') }, [mode])

  // ── Contribution sub-mode ──────────────────────────────────────────────────
  const [contribSubMode, setContribSubMode] = useState<ContribSubMode>('score_pct')

  // ── Discount template generator ────────────────────────────────────────────
  const [discountFilter, setDiscountFilter] = useState({
    clientId:  '',
    dateFrom:  '',
    dateTo:    '',
    status:    '',
  })
  const [discountTemplateLoading, setDiscountTemplateLoading] = useState(false)
  const [contribTemplateLoading, setContribTemplateLoading] = useState(false)

  // ── Export filters (per-mode, shared state — reset on mode change) ──────────
  const [exportFilterOpen, setExportFilterOpen] = useState(false)
  const [exportFilters, setExportFilters] = useState({
    clientId:   '',
    status:     '',
    dateFrom:   '',
    dateTo:     '',
    isActive:   '',    // '' | 'true' | 'false'
    entryType:  '',    // cashbook: 'income' | 'expense'
  })
  // Reset export filters when mode changes
  useEffect(() => {
    setExportFilters({ clientId: '', status: '', dateFrom: '', dateTo: '', isActive: '', entryType: '' })
    setExportFilterOpen(false)
  }, [mode])

  // ── Clean-up state ─────────────────────────────────────────────────────────
  const [cleanupMode, setCleanupMode] = useState<ImportMode>('employees')
  const [cleanupRecords, setCleanupRecords] = useState<any[]>([])
  const [selectedIds, setSelectedIds]   = useState<Set<string>>(new Set())
  const [cleanupLoading, setCleanupLoading] = useState(false)
  const [deleting, setDeleting]         = useState(false)

  // Lookup maps
  const clientMap  = useMemo(() => { const m: Record<string, string> = {}; clients.forEach(c => { m[norm(c.name)] = c.id; m[norm(c.code)] = c.id }); return m }, [clients])
  const serviceMap = useMemo(() => { const m: Record<string, string> = {}; services.forEach(s => { m[norm(s.name)] = s.id }); return m }, [services])
  const empMap     = useMemo(() => { const m: Record<string, string> = {}; employees.forEach(e => { m[norm(e.cqid)] = e.id }); return m }, [employees])
  const groupMap   = useMemo(() => { const m: Record<string, string> = {}; groups.forEach(g => { m[norm(g.name)] = g.id }); return m }, [groups])
  const bankAccountMap = useMemo(() => { const m: Record<string, string> = {}; bankAccounts.forEach(b => { m[norm(b.name)] = b.id }); return m }, [bankAccounts])
  const cashCategoryMap = useMemo(() => { const m: Record<string, string> = {}; cashCategories.forEach(c => { m[norm(c.name)] = c.id }); return m }, [cashCategories])

  // ── ParseContext builder ────────────────────────────────────────────────────
  // Passes all reference data and lookup maps to the schema engine.
  function buildParseCtx(): ParseContext {
    return {
      clients, services, employees,
      groups: groups as ParseContext['groups'],
      parameters: parameters as ParseContext['parameters'],
      bankAccounts, cashCategories,
      clientMap, serviceMap, empMap, groupMap, bankAccountMap, cashCategoryMap,
    }
  }

  // ── Export current data ────────────────────────────────────────────────────
  async function exportCurrentData(m: ImportMode) {
    const cfg = EXPORT_CONFIG[m]
    const PAGE = 1000
    const allData: any[] = []
    let lastError: any = null
    let orderingWorks = !!cfg.orderBy

    // Date column per mode — used for dateFrom/dateTo filters
    const dateColMap: Partial<Record<ImportMode, string>> = {
      jobs:             'task_date',
      invoices:         'issue_date',
      invoice_status:   'issue_date',
      cashbook_entries: 'entry_date',
      discounts:        'created_at',
      contributions:    'created_at',
    }
    const dateCol = dateColMap[m]

    // Modes that have client_id column directly
    const hasClientId: ImportMode[] = ['jobs', 'invoices', 'invoice_status', 'discounts', 'pricing_matrix', 'contributions']
    // Modes that have status column
    const hasStatus: ImportMode[] = ['jobs', 'invoices', 'invoice_status']
    // Modes that have is_active column
    const hasIsActive: ImportMode[] = ['employees', 'clients', 'services']

    for (let page = 0; page < 100; page++) {   // hard ceiling: 100k rows
      let q = supabase.from(cfg.table).select('*').range(page * PAGE, (page + 1) * PAGE - 1)
      if (orderingWorks && cfg.orderBy) q = q.order(cfg.orderBy, { ascending: true, nullsFirst: false })

      // Apply export filters
      if (exportFilters.clientId  && hasClientId.includes(m))  q = q.eq('client_id', exportFilters.clientId)
      if (exportFilters.status    && hasStatus.includes(m))    q = q.eq('status', exportFilters.status)
      if (exportFilters.dateFrom  && dateCol)                  q = q.gte(dateCol, exportFilters.dateFrom)
      if (exportFilters.dateTo    && dateCol)                  q = q.lte(dateCol, exportFilters.dateTo)
      if (exportFilters.isActive !== '' && hasIsActive.includes(m)) q = q.eq('is_active', exportFilters.isActive === 'true')
      if (exportFilters.entryType && m === 'cashbook_entries') q = q.eq('type', exportFilters.entryType)

      const { data, error } = await q
      if (error) {
        if (page === 0 && orderingWorks) {
          // orderBy column may not exist — retry this page without ordering
          orderingWorks = false
          lastError = error
          page--   // retry same page
          continue
        }
        toastError(`Export failed: ${error.message}`)
        return
      }
      if (data) allData.push(...data)
      if (!data || data.length < PAGE) break   // last page reached
    }

    if (lastError) console.warn(`Export ordering by "${cfg.orderBy}" skipped: ${lastError.message}`)
    if (allData.length === 0) { toastError('No data to export'); return }
    let data = allData

    // ── Enrichment per mode ──
    // Services: append a `group_names` column (pipe-separated) so the export
    // is round-trippable through import (which now accepts group_names).
    if (m === 'services') {
      const [gsRes, grpRes] = await Promise.all([
        supabase.from('group_services').select('group_id, service_id'),
        supabase.from('contribution_groups').select('id, name'),
      ])
      if (!gsRes.error && !grpRes.error) {
        const groupNameById: Record<string, string> = {}
        ;(grpRes.data || []).forEach((g: any) => { groupNameById[g.id] = g.name })
        const groupsByService: Record<string, string[]> = {}
        ;(gsRes.data || []).forEach((row: any) => {
          if (!groupsByService[row.service_id]) groupsByService[row.service_id] = []
          if (groupNameById[row.group_id]) groupsByService[row.service_id].push(groupNameById[row.group_id])
        })
        data = data.map((r: any) => ({ ...r, group_names: (groupsByService[r.id] || []).join(' | ') }))
      }
    }

    // Discounts: enrich with invoice_number + client_name_or_code for human-readable export
    if (m === 'discounts') {
      const invIds = [...new Set(data.map((r: any) => r.invoice_id).filter(Boolean))]
      const clIds  = [...new Set(data.map((r: any) => r.client_id).filter(Boolean))]
      const [invRes, clRes] = await Promise.all([
        invIds.length ? supabase.from('invoices').select('id, invoice_number').in('id', invIds) : Promise.resolve({ data: [] as any[], error: null }),
        clIds.length  ? supabase.from('clients').select('id, name, code').in('id', clIds)        : Promise.resolve({ data: [] as any[], error: null }),
      ])
      const invByid = new Map<string, string>(); ((invRes as any).data || []).forEach((i: any) => invByid.set(i.id, i.invoice_number))
      const clByid  = new Map<string, string>(); ((clRes  as any).data || []).forEach((c: any) => clByid.set(c.id,  c.code || c.name))
      data = data.map((r: any) => ({
        ...r,
        invoice_number_or_id: r.invoice_id ? (invByid.get(r.invoice_id) || r.invoice_id) : '',
        client_name_or_code:  r.client_id  ? (clByid.get(r.client_id)   || '')           : '',
        discount_date:        r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : '',
      }))
    }

    const allKeys = new Set<string>()
    data.forEach((r: Record<string, unknown>) => Object.keys(r).forEach(k => allKeys.add(k)))
    const headers = ['id', ...[...allKeys].filter(k => k !== 'id').sort()]
    const csv = toCsv(headers, data)
    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
    downloadCsv(`${m}_export_${ts}.csv`, csv)
    success(`Exported ${data.length} row${data.length !== 1 ? 's' : ''}`)
  }

  // ── Contributions template generator ───────────────────────────────────────
  async function generateContribTemplate() {
    setContribTemplateLoading(true)
    try {
      const allData: any[] = []
      const PAGE = 1000
      for (let page = 0; page < 100; page++) {
        const q = supabase
          .from('tasks')
          .select('id, task_number, title, task_date')
          .neq('status', 'cancelled')
          .order('task_date', { ascending: true })
          .range(page * PAGE, (page + 1) * PAGE - 1)
        
        const { data, error } = await q
        if (error) { toastError(`Failed to load tasks: ${error.message}`); return }
        if (data) allData.push(...data)
        if (!data || data.length < PAGE) break
      }
      if (allData.length === 0) { toastError('No tasks available'); return }
      const data = allData

      let header = ''
      let paramHeaders: string[] = []
      if (contribSubMode === 'earnings_only') {
        header = 'id,task_id,task_number,task_title,task_date,employee_cqid,earnings_inr'
      } else if (contribSubMode === 'score_pct') {
        header = 'id,task_id,task_number,task_title,task_date,employee_cqid,score_percentage,earnings_inr'
      } else {
        paramHeaders = parameters.map(p => p.name)
        header = `id,task_id,task_number,task_title,task_date,employee_cqid,${paramHeaders.join(',')}`
      }

      const rows = data.map((t: any) => {
        let baseRow = [
          '', // id
          t.id, // task_id
          t.task_number || '', // task_number
          t.title || '',
          t.task_date || '',
          '', // employee_cqid
        ]
        if (contribSubMode === 'earnings_only') {
          baseRow.push('') 
        } else if (contribSubMode === 'score_pct') {
          baseRow.push('', '') 
        } else {
          paramHeaders.forEach(() => baseRow.push(''))
        }
        return baseRow.map(v => (String(v).includes(',') ? `"${v}"` : v)).join(',')
      })

      const ts = new Date().toISOString().slice(0, 10)
      downloadCsv(`contributions_${contribSubMode}_prefilled_${ts}.csv`, header + '\n' + rows.join('\n'))
      success(`Generated pre-filled template with ${data.length} task${data.length !== 1 ? 's' : ''}`)
    } finally {
      setContribTemplateLoading(false)
    }
  }

  // ── Discount template generator ────────────────────────────────────────────
  async function generateDiscountTemplate() {
    setDiscountTemplateLoading(true)
    try {
      const allData: any[] = []
      const PAGE = 1000
      for (let page = 0; page < 100; page++) {
        let q = supabase
          .from('invoices')
          .select('invoice_number, issue_date, total_amount, status, client:clients(name, code)')
          .order('issue_date', { ascending: true })

        if (discountFilter.clientId) q = q.eq('client_id', discountFilter.clientId)
        if (discountFilter.dateFrom)  q = q.gte('issue_date', discountFilter.dateFrom)
        if (discountFilter.dateTo)    q = q.lte('issue_date', discountFilter.dateTo)
        if (discountFilter.status)    q = q.eq('status', discountFilter.status)

        const { data, error } = await q.range(page * PAGE, (page + 1) * PAGE - 1)
        if (error) { toastError(`Failed to load invoices: ${error.message}`); return }
        if (data) allData.push(...data)
        if (!data || data.length < PAGE) break
      }
      if (allData.length === 0) { toastError('No invoices match the selected filters'); return }
      const data = allData

      const today = new Date().toISOString().slice(0, 10)
      const header = 'invoice_number,client_name_or_code,invoice_total,discount_amount,discount_percentage,reason,discount_date'
      const rows = data.map((inv: any) => {
        const clientCode = inv.client?.code || inv.client?.name || ''
        const total = inv.total_amount || ''
        return [
          inv.invoice_number,
          clientCode,
          total,
          '',   // discount_amount — to be filled
          '',   // discount_percentage — to be filled
          '',   // reason — to be filled
          today,
        ].map(v => (String(v).includes(',') ? `"${v}"` : v)).join(',')
      })

      const ts = new Date().toISOString().slice(0, 10)
      downloadCsv(`discount_template_${ts}.csv`, header + '\n' + rows.join('\n'))
      success(`Generated template with ${data.length} invoice${data.length !== 1 ? 's' : ''}`)
    } finally {
      setDiscountTemplateLoading(false)
    }
  }

  // ── Parsers ────────────────────────────────────────────────────────────────
  function baseRow(i: number): ParsedRow { return { _line: i + 2, errors: [], warnings: [], status: 'ok' } }
  function finalize(r: ParsedRow): ParsedRow {
    r.status = r.errors.length ? 'error' : r.warnings.length ? 'warn' : 'ok'
    return r
  }

  function parseEmployees(lines: string[][]): ParsedRow[] {
    const headers = lines[0]
    const ctx = buildParseCtx()
    return lines.slice(1).map((cells, i) => {
      const r = parseRowFromSchema(EMPLOYEE_FIELDS, cells, headers, i + 2, ctx)
      r.row_id = r.id  // preserve row_id alias for update/delete operations
      return r
    })
  }

  function parseClients(lines: string[][]): ParsedRow[] {
    const headers = lines[0]
    const ctx = buildParseCtx()
    return lines.slice(1).map((cells, i) => {
      const r = parseRowFromSchema(CLIENT_FIELDS, cells, headers, i + 2, ctx)
      r.row_id = r.id
      return r
    })
  }

  function parseServices(lines: string[][]): ParsedRow[] {
    const h = lines[0].map(norm)
    // Use EXACT match for 'name' to avoid matching 'group_names'
    const iId = h.findIndex(c => c === 'id')
    const iName = h.findIndex(c => c === 'name')        // exact — not group_names
    const iPricing = h.findIndex(c => c.includes('pricing'))
    const iDesc = h.findIndex(c => c.includes('desc'))
    const iOrd  = h.findIndex(c => c.includes('order'))
    const iDefaultPrice = h.findIndex(c => c === 'default_price' || c === 'defaultprice')
    const iDefaultCurr  = h.findIndex(c => c === 'default_currency' || (c.includes('currency') && !c.includes('default') ? false : c.includes('currency')))
    const iGroupNames   = h.findIndex(c => c === 'group_names' || c === 'groups' || c === 'contribution_groups')
    const iActive = h.findIndex(c => c === 'is_active' || c === 'active')

    return lines.slice(1).map((c, i) => {
      const g = (j: number) => j >= 0 ? c[j]?.trim() || '' : ''
      const activeRaw = g(iActive)
      const groupNamesRaw = g(iGroupNames)
      // Split on | or , and trim — supports "Design Group | Variable Group" or "Design Group, Variable Group"
      const groupNames = groupNamesRaw
        ? groupNamesRaw.split(/[|,]/).map(s => s.trim()).filter(Boolean)
        : []
      const groupIds: string[] = []
      const missingGroups: string[] = []
      for (const gn of groupNames) {
        const gid = groupMap[norm(gn)]
        if (gid) groupIds.push(gid)
        else missingGroups.push(gn)
      }
      const r: ParsedRow = { ...baseRow(i), row_id: g(iId), name: g(iName), pricing_type: g(iPricing) || 'fixed_per_creative',
        description: g(iDesc), display_order: g(iOrd) || '0',
        default_price: g(iDefaultPrice), default_currency: g(iDefaultCurr) || 'INR',
        group_names: groupNames, group_ids: groupIds,
        is_active: activeRaw === '' || activeRaw === 'true' || activeRaw === 'TRUE' || activeRaw === '1',
      }
      if (!r.name) r.errors.push('name is required')
      const valid = ['fixed_per_creative','percentage_of_spend','retainer','hourly']
      if (!valid.includes(r.pricing_type)) r.errors.push(`pricing_type "${r.pricing_type}" invalid`)
      if (r.default_price && isNaN(parseFloat(r.default_price))) r.errors.push('default_price must be a number')
      if (missingGroups.length > 0) r.warnings.push(`Group(s) not found: ${missingGroups.join(', ')} — these will be skipped`)
      return finalize(r)
    })
  }

  function parseGroups(lines: string[][]): ParsedRow[] {
    const headers = lines[0]
    const ctx = buildParseCtx()
    return lines.slice(1).map((cells, i) => {
      const r = parseRowFromSchema(GROUP_FIELDS, cells, headers, i + 2, ctx)
      r.row_id = r.id
      return r
    })
  }

  function parseParameters(lines: string[][]): ParsedRow[] {
    const headers = lines[0]
    const ctx = buildParseCtx()
    return lines.slice(1).map((cells, i) => {
      const r = parseRowFromSchema(PARAMETER_FIELDS, cells, headers, i + 2, ctx)
      r.row_id = r.id
      // Resolve group_id from group_name for downstream insert logic
      if (r.group_name) r.group_id = groupMap[norm(r.group_name)]
      return r
    })
  }

  function parseTools(lines: string[][]): ParsedRow[] {
    const headers = lines[0]
    const ctx = buildParseCtx()
    return lines.slice(1).map((cells, i) => {
      const r = parseRowFromSchema(TOOL_FIELDS, cells, headers, i + 2, ctx)
      r.row_id = r.id
      // Resolve group_id from group_name for downstream insert logic
      if (r.group_name) r.group_id = groupMap[norm(r.group_name)]
      return r
    })
  }

  function parsePricingMatrix(lines: string[][]): ParsedRow[] {
    const h = lines[0].map(norm)
    const iId      = h.findIndex(c => c === 'id')
    const iClient  = h.findIndex(c => c.includes('client'))
    const iService = h.findIndex(c => c.includes('service'))
    const iPrice   = h.findIndex(c => c === 'price' || c === 'fixed_price')
    const iPct     = h.findIndex(c => c.includes('percentage_rate') || c === 'pct_rate')
    const iComm    = h.findIndex(c => c.includes('commission'))
    const iCurr    = h.findIndex(c => c.includes('currency'))

    return lines.slice(1).map((c, i) => {
      const g = (j: number) => j >= 0 ? c[j]?.trim() || '' : ''
      const r: ParsedRow = {
        ...baseRow(i),
        row_id: g(iId),
        client_ref: g(iClient), service_ref: g(iService),
        price: g(iPrice), percentage_rate: g(iPct),
        commission_percentage: g(iComm), currency: g(iCurr) || 'INR',
      }
      const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
      if (!r.client_ref) r.errors.push('client_name_or_code is required')
      else if (isUuid(r.client_ref)) { r.client_id = r.client_ref }
      else {
        r.client_id = clientMap[norm(r.client_ref)]
        if (!r.client_id) r.errors.push(`Client "${r.client_ref}" not found`)
      }
      if (!r.service_ref) r.errors.push('service_name is required')
      else if (isUuid(r.service_ref)) { r.service_id = r.service_ref }
      else {
        r.service_id = serviceMap[norm(r.service_ref)]
        if (!r.service_id) r.errors.push(`Service "${r.service_ref}" not found`)
      }
      if (!r.commission_percentage) r.errors.push('commission_percentage is required')
      else if (isNaN(parseFloat(r.commission_percentage))) r.errors.push('commission_percentage must be a number')
      if (!r.price && !r.percentage_rate) r.warnings.push('No price or percentage_rate — row will be saved with zero pricing')
      if (r.price && isNaN(parseFloat(r.price))) r.errors.push('price must be a number')
      if (r.percentage_rate && isNaN(parseFloat(r.percentage_rate))) r.errors.push('percentage_rate must be a number')
      const validCurrencies = ['INR','AED','SAR','USD','QAR','GBP','EUR']
      if (r.currency && !validCurrencies.includes(r.currency.toUpperCase())) r.warnings.push(`Currency "${r.currency}" not recognised — defaulting to INR`)
      return finalize(r)
    })
  }

  function parseJobs(lines: string[][]): ParsedRow[] {
    const h = lines[0].map(norm)
    const idx = (k: string) => h.findIndex(c => c.includes(k))
    const iId = h.findIndex(c => c === 'id')
    const iNumber = h.findIndex(c => c === 'task_number' || c === 'number' || c === 'task#' || c === 'no' || c === 'task_no')
    const iTitle = idx('title'), iClient = h.findIndex(c => c.includes('client'))
    const iService = h.findIndex(c => c.includes('service')), iDate = h.findIndex(c => c.includes('date'))
    const iAmountInr = h.findIndex(c => c === 'billing_amount_inr' || c === 'billing_amount_inr')
    const iAmount    = h.findIndex(c => c === 'billing_amount')
    const iCurr      = h.findIndex(c => c === 'currency')
    const iQty       = h.findIndex(c => c === 'quantity' || c === 'qty')
    const iStatus    = idx('status'), iDesc = h.findIndex(c => c.includes('desc'))
    const iRecurring = h.findIndex(c => c === 'is_recurring' || c === 'recurring')
    const iRecInt    = h.findIndex(c => c === 'recurring_interval')
    const iRecEnd    = h.findIndex(c => c === 'recurring_end_date')

    return lines.slice(1).map((c, i) => {
      const g = (j: number) => j >= 0 ? c[j]?.trim() || '' : ''
      const tnRaw = g(iNumber).replace(/^#/, '').trim()
      // billing_amount_inr takes precedence; fall back to billing_amount
      const billingInr = g(iAmountInr) || g(iAmount)
      const billingAmt = g(iAmount) || g(iAmountInr)
      const recurringRaw = g(iRecurring)
      const r: ParsedRow = {
        ...baseRow(i),
        row_id: g(iId), task_number: tnRaw, title: g(iTitle), client_ref: g(iClient),
        service_ref: g(iService), task_date: normalizeDate(g(iDate)),
        billing_amount_inr: billingInr, billing_amount: billingAmt,
        currency: g(iCurr) || 'INR',
        quantity: g(iQty) || '1',
        task_status: g(iStatus) || 'done', description: g(iDesc),
        is_recurring: recurringRaw === 'true' || recurringRaw === 'TRUE' || recurringRaw === '1',
        recurring_interval: g(iRecInt) || null,
        recurring_end_date: g(iRecEnd) ? normalizeDate(g(iRecEnd)) : null,
      }
      if (!r.title)     r.errors.push('title is required')
      if (!r.task_date) r.errors.push('task_date is required')
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(r.task_date)) r.errors.push('task_date must be DD-MM-YYYY (e.g. 18-05-2026)')
      if (tnRaw && !/^\d+$/.test(tnRaw)) r.errors.push('task_number must be a whole number')
      if (r.client_ref) { r.client_id = clientMap[norm(r.client_ref)]; if (!r.client_id) r.warnings.push(`Client "${r.client_ref}" not found`) }
      if (r.service_ref) { r.service_id = serviceMap[norm(r.service_ref)]; if (!r.service_id) r.warnings.push(`Service "${r.service_ref}" not found`) }
      if (r.billing_amount_inr && isNaN(parseFloat(r.billing_amount_inr))) r.errors.push('billing_amount_inr must be a number')
      if (r.quantity && isNaN(parseFloat(r.quantity))) r.errors.push('quantity must be a number')
      const validSt = ['pending','in_progress','done','invoiced','cancelled']
      if (r.task_status && !validSt.includes(r.task_status)) r.errors.push(`status "${r.task_status}" invalid`)
      const validIntervals = ['daily','weekly','biweekly','monthly']
      if (r.recurring_interval && !validIntervals.includes(r.recurring_interval)) r.errors.push(`recurring_interval "${r.recurring_interval}" invalid`)
      if (r.recurring_end_date && !/^\d{4}-\d{2}-\d{2}$/.test(r.recurring_end_date)) r.errors.push('recurring_end_date must be DD-MM-YYYY (e.g. 18-05-2026)')
      return finalize(r)
    })
  }

  async function parseContributions(lines: string[][]): Promise<ParsedRow[]> {
    const h = lines[0].map(norm)
    const iRowId = h.findIndex(c => c === 'id')
    const iId    = h.findIndex(c => c === 'task_id')
    const iTaskNum = h.findIndex(c => c === 'task_number')
    const iTaskTitle = h.findIndex(c => c === 'task_title')
    const iTask  = h.findIndex(c => c.includes('task') && !['task_id', 'id', 'task_number', 'task_title', 'task_date'].includes(c))
    const iDate  = h.findIndex(c => c.includes('date'))
    const iCqid  = h.findIndex(c => c.includes('cqid') || c === 'employee_cqid')
    const iScore = h.findIndex(c => c.includes('score') || c.includes('pct') || c.includes('percent'))
    const iEarn  = h.findIndex(c => c.includes('earn'))

    // Build task lookup from number or title+date for rows without direct task_id
    const numsToFetch = [...new Set(
      lines.slice(1).filter(c => !c[iId]?.trim()).map(c => iTaskNum >= 0 ? c[iTaskNum]?.trim() : '').filter(Boolean)
    )]
    const titlesToFetch = [...new Set(
      lines.slice(1)
        .filter(c => !c[iId]?.trim() && (iTaskNum < 0 || !c[iTaskNum]?.trim()))
        .map(c => (iTaskTitle >= 0 ? c[iTaskTitle] : (iTask >= 0 ? c[iTask] : ''))?.trim())
        .filter(Boolean)
    )]

    const taskMapNum: Record<string, string> = {}
    if (numsToFetch.length) {
      const { data: tasksData } = await supabase.from('tasks').select('id, task_number').in('task_number', numsToFetch)
      ;(tasksData || []).forEach(t => { taskMapNum[String(t.task_number)] = t.id })
    }

    const taskMapTitle: Record<string, string> = {}
    if (titlesToFetch.length) {
      const { data: tasksData } = await supabase.from('tasks').select('id, title, task_date').in('title', titlesToFetch)
      ;(tasksData || []).forEach(t => { taskMapTitle[`${t.title}|||${t.task_date}`] = t.id })
    }

    // For param_detail: map CSV column → parameter
    const paramColMap: { idx: number; param: RefParameter }[] = []
    if (contribSubMode === 'param_detail') {
      for (let ci = 0; ci < h.length; ci++) {
        const matched = parameters.find(p => norm(p.name) === h[ci])
        if (matched) paramColMap.push({ idx: ci, param: matched })
      }
    }

    return lines.slice(1).map((c, i) => {
      const g = (j: number) => j >= 0 ? c[j]?.trim() || '' : ''
      const taskDate = normalizeDate(g(iDate))
      const r: ParsedRow = {
        ...baseRow(i),
        row_id: g(iRowId),
        task_id_direct: g(iId),
        task_number: iTaskNum >= 0 ? g(iTaskNum) : '',
        task_ref: iTaskTitle >= 0 ? g(iTaskTitle) : (iTask >= 0 ? g(iTask) : ''),
        task_date: taskDate,
        employee_cqid: g(iCqid),
        score_percentage: g(iScore),
        earnings: g(iEarn),
        _paramValues: {} as Record<string, string>,
      }

      // ── Resolve task ──────────────────────────────────────────────────────
      if (r.task_id_direct) {
        r.task_id = r.task_id_direct
      } else if (r.task_number) {
        r.task_id = taskMapNum[r.task_number]
        if (!r.task_id) r.warnings.push(`Task not matched — check task_number`)
      } else {
        if (!r.task_ref)  r.errors.push('task_number or task_title is required (or provide task_id column)')
        if (!r.task_date) r.errors.push('task_date is required')
        else if (!/^\d{4}-\d{2}-\d{2}$/.test(r.task_date)) r.errors.push('task_date must be DD-MM-YYYY (e.g. 18-05-2026)')
        if (r.task_ref && r.task_date) {
          r.task_id = taskMapTitle[`${r.task_ref}|||${r.task_date}`]
          if (!r.task_id) r.warnings.push(`Task not matched — check title & date match exactly`)
        }
      }

      // ── Resolve employee ─────────────────────────────────────────────────
      if (!r.employee_cqid) r.errors.push('employee_cqid is required')
      else {
        r.employee_id = empMap[norm(r.employee_cqid)]
        if (!r.employee_id) r.errors.push(`Employee "${r.employee_cqid}" not found`)
      }

      // ── Mode-specific validation ─────────────────────────────────────────
      if (contribSubMode === 'earnings_only') {
        if (!r.earnings) r.errors.push('earnings_inr is required')
        else if (isNaN(parseFloat(r.earnings))) r.errors.push('earnings_inr must be a number')
      } else if (contribSubMode === 'score_pct') {
        if (!r.score_percentage) r.errors.push('score_percentage is required')
        const s = parseFloat(r.score_percentage)
        if (r.score_percentage && (isNaN(s) || s < 0 || s > 100)) r.errors.push('score_percentage must be 0–100')
        if (r.earnings && isNaN(parseFloat(r.earnings))) r.errors.push('earnings_inr must be a number')
      } else {
        // param_detail — collect per-parameter values
        for (const { idx, param } of paramColMap) {
          const val = c[idx]?.trim() || '0'
          r._paramValues[param.id] = val
        }
        if (paramColMap.length === 0) r.warnings.push('No parameter columns matched — headers must equal parameter names exactly')
      }

      return finalize(r)
    })
  }

  async function parseCashbookEntries(lines: string[][]): Promise<ParsedRow[]> {
    const h = lines[0].map(norm)
    const iId       = h.findIndex(c => c === 'id')
    const iDate     = h.findIndex(c => c.includes('entry_date') || c.includes('date'))
    const iType     = h.findIndex(c => c === 'type')
    const iCat      = h.findIndex(c => c.includes('category'))
    const iBank     = h.findIndex(c => c.includes('bank') || c.includes('account'))
    const iAmt      = h.findIndex(c => c === 'amount')
    const iCurr     = h.findIndex(c => c === 'currency')
    const iAmtInr   = h.findIndex(c => c.includes('amount_inr') || c.includes('inr'))
    const iDesc     = h.findIndex(c => c.includes('description') || c.includes('desc'))
    const iRef      = h.findIndex(c => c.includes('reference') || c.includes('ref'))
    const iInvNum   = h.findIndex(c => c.includes('invoicenumber') || c.includes('invoice_number'))

    const { data: invRows } = await supabase.from('invoices').select('id, invoice_number')
    const invMap: Record<string, string> = {}
    ;(invRows || []).forEach(inv => { invMap[inv.invoice_number.toUpperCase()] = inv.id })

    return lines.slice(1).map((c, i) => {
      const g = (j: number) => j >= 0 ? c[j]?.trim() || '' : ''
      const catName  = g(iCat)
      const bankName = g(iBank)
      const currency = g(iCurr) || 'INR'
      const amount   = g(iAmt)
      const amtInr   = g(iAmtInr) || (currency === 'INR' ? amount : '')
      const refStr = g(iRef).trim()
      const r: ParsedRow = {
        ...baseRow(i), row_id: g(iId),
        entry_date: normalizeDate(g(iDate)),
        type: g(iType) || 'inflow',
        category_name: catName,
        category_id: catName ? cashCategoryMap[norm(catName)] : undefined,
        bank_account_name: bankName,
        bank_account_id: bankName ? bankAccountMap[norm(bankName)] : undefined,
        amount, currency, amount_inr: amtInr,
        description: g(iDesc), reference: refStr || null,
      }

      // ── Resolve reference → client_id / employee_id ───────────────────────
      // "Company" = internal expense, leave both null (no entity allocation).
      // CQID pattern   → employee_id (salary / commission payments).
      // Anything else  → try client name or code → client_id.
      if (refStr && norm(refStr) !== 'company') {
        const empId = empMap[norm(refStr)]
        if (empId) {
          r.employee_id = empId
        } else {
          const clientId = clientMap[norm(refStr)]
          if (clientId) {
            r.client_id = clientId
          } else {
            r.warnings.push(`Reference "${refStr}" not matched to any client or employee — entry imported without entity link`)
          }
        }
      }

      const providedInvNum = g(iInvNum)
      
      if (providedInvNum) {
        // Strict lookup
        const strictMatch = invMap[providedInvNum.toUpperCase()]
        if (strictMatch) {
          r.invoice_id = strictMatch
        } else {
          r.warnings.push(`Invoice number "${providedInvNum}" not found in database. Entry will be imported unlinked.`)
        }
      } else {
        // Legacy fallback to reference parsing
        if (r.reference) {
          const refUpper = r.reference.toUpperCase()
          const matchedInv = Object.keys(invMap).find(num => refUpper.includes(num))
          if (matchedInv) {
            r.invoice_id = invMap[matchedInv]
          }
        }
        
        // Warn if invoice category but no invoice number provided
        if (norm(catName) === 'invoice' && !r.invoice_id) {
          r.warnings.push('Invoice payment detected without invoice_number. Auto-linking may be unreliable.')
        }
      }
      if (!r.entry_date) r.errors.push('entry_date is required')
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(r.entry_date)) r.errors.push('entry_date must be DD-MM-YYYY')
      if (!['inflow', 'outflow'].includes(r.type)) r.errors.push('type must be inflow or outflow')
      if (!r.amount) r.errors.push('amount is required')
      else if (isNaN(parseFloat(r.amount))) r.errors.push('amount must be a number')
      if (catName && !r.category_id) r.warnings.push(`Category "${catName}" not found — will leave blank`)
      if (bankName && !r.bank_account_id) r.warnings.push(`Bank account "${bankName}" not found — will leave blank`)
      return finalize(r)
    })
  }

  function parseInvoices(lines: string[][]): ParsedRow[] {
    const h = lines[0].map(norm)
    const iId       = h.findIndex(c => c === 'id')
    const iNum      = h.findIndex(c => c.includes('invoice_number') || c.includes('number'))
    const iClient   = h.findIndex(c => c.includes('client'))
    const iIssue    = h.findIndex(c => c.includes('issue'))
    const iDue      = h.findIndex(c => c.includes('due'))
    const iPStart   = h.findIndex(c => c.includes('period_start') || c.includes('start'))
    const iPEnd     = h.findIndex(c => c.includes('period_end') || c.includes('end'))
    const iCurr     = h.findIndex(c => c === 'currency')
    const iSub      = h.findIndex(c => c.includes('subtotal'))
    const iTax      = h.findIndex(c => c.includes('tax'))
    const iDisc     = h.findIndex(c => c.includes('discount'))
    const iNotes    = h.findIndex(c => c.includes('notes'))
    const iStatus   = h.findIndex(c => c === 'status')

    const validStatuses = ['draft','reviewed','sent','partial','paid','cancelled','bad_debt','overdue']

    return lines.slice(1).map((c, i) => {
      const g = (j: number) => j >= 0 ? c[j]?.trim() || '' : ''
      const clientRef = g(iClient)
      const issueDate = normalizeDate(g(iIssue))
      let dueDate = normalizeDate(g(iDue))
      if (!dueDate && issueDate) {
        // Default due date: issue + 14 days
        const d = new Date(issueDate)
        d.setDate(d.getDate() + 14)
        dueDate = d.toISOString().slice(0, 10)
      }
      const invoiceStatus = g(iStatus) || 'draft'
      const r: ParsedRow = {
        ...baseRow(i), row_id: g(iId),
        invoice_number: g(iNum),
        client_ref: clientRef,
        client_id: clientRef ? clientMap[norm(clientRef)] : undefined,
        issue_date: issueDate, due_date: dueDate,
        billing_period_start: normalizeDate(g(iPStart)),
        billing_period_end:   normalizeDate(g(iPEnd)),
        currency: g(iCurr) || 'INR',
        subtotal: g(iSub) || '0',
        tax_rate: g(iTax) || '0',
        discount_amount: g(iDisc) || '0',
        notes: g(iNotes), invoice_status: invoiceStatus,
      }
      if (!r.invoice_number) r.errors.push('invoice_number is required')
      if (!r.client_id) r.errors.push(`Client "${clientRef}" not found — must match an existing client name or code`)
      if (!r.issue_date) r.errors.push('issue_date is required')
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(r.issue_date)) r.errors.push('issue_date must be DD-MM-YYYY')
      if (!validStatuses.includes(invoiceStatus)) r.errors.push(`status "${invoiceStatus}" invalid`)
      return finalize(r)
    })
  }

  async function parseInvoiceStatus(lines: string[][]): Promise<ParsedRow[]> {
    const h = lines[0].map(norm)
    const iRef    = h.findIndex(c => c.includes('invoice_number') || c.includes('number') || c.includes('id'))
    const iStatus = h.findIndex(c => c === 'status')
    const iPaid   = h.findIndex(c => c.includes('paid_amount') || c.includes('paid'))
    const iDate   = h.findIndex(c => c.includes('payment_date') || c.includes('date'))
    const iMethod = h.findIndex(c => c.includes('method') || c.includes('payment_method'))
    const iNotes  = h.findIndex(c => c.includes('notes'))

    // Pre-load invoice number → id map
    const { data: invRows } = await supabase.from('invoices').select('id, invoice_number')
    const invMap: Record<string, string> = {}
    ;(invRows || []).forEach((inv: any) => { invMap[norm(inv.invoice_number)] = inv.id })

    const validStatuses = ['draft','reviewed','sent','partial','paid','cancelled','bad_debt','overdue']
    const validMethods  = ['bank_transfer','cheque','cash','upi','online','other','']

    return lines.slice(1).map((c, i) => {
      const g = (j: number) => j >= 0 ? c[j]?.trim() || '' : ''
      const ref           = g(iRef)
      const invoiceStatus = g(iStatus)
      const isUUID = /^[0-9a-f-]{36}$/i.test(ref)
      const invId  = isUUID ? ref : invMap[norm(ref)]
      const r: ParsedRow = {
        ...baseRow(i), row_id: undefined,
        invoice_ref: ref, invoice_id: invId,
        invoice_status: invoiceStatus, paid_amount: g(iPaid),
        payment_date: normalizeDate(g(iDate)),
        payment_method: g(iMethod) || '',
        notes: g(iNotes),
      }
      if (!ref) r.errors.push('invoice_number_or_id is required')
      else if (!invId) r.errors.push(`Invoice "${ref}" not found in database`)
      if (!invoiceStatus) r.errors.push('status is required')
      else if (!validStatuses.includes(invoiceStatus)) r.errors.push(`status "${invoiceStatus}" invalid — use: ${validStatuses.join(', ')}`)
      if ((invoiceStatus === 'partial' || invoiceStatus === 'paid') && !r.paid_amount) r.warnings.push('paid_amount recommended when status is partial or paid')
      if (r.payment_method && !validMethods.includes(r.payment_method)) r.warnings.push(`payment_method "${r.payment_method}" not standard`)
      return finalize(r)
    })
  }

  async function parseDiscounts(lines: string[][]): Promise<ParsedRow[]> {
    const h = lines[0].map(norm)
    const iId         = h.findIndex(c => c === 'id')
    const iInvoiceRef = h.findIndex(c => c.includes('invoice_number') || c.includes('invoice_id') || c === 'invoice_ref')
    const iClient     = h.findIndex(c => c.includes('client'))
    const iAmount     = h.findIndex(c => c === 'discount_amount' || c === 'amount')
    const iPct        = h.findIndex(c => c === 'discount_percentage' || c === 'percentage' || c === 'percent')
    const iTotal      = h.findIndex(c => c.includes('invoice_total') || c === 'total')
    const iReason     = h.findIndex(c => c.includes('reason') || c.includes('note'))
    const iDate       = h.findIndex(c => c.includes('discount_date') || c.includes('date'))

    // Pre-load invoice number → id map
    const { data: invRows } = await supabase.from('invoices').select('id, invoice_number, client_id, total_amount')
    const invMap: Record<string, { id: string; client_id: string; total: number }> = {}
    ;(invRows || []).forEach((inv: any) => { invMap[norm(inv.invoice_number)] = { id: inv.id, client_id: inv.client_id, total: inv.total_amount || 0 } })

    return lines.slice(1).map((c, i) => {
      const g = (j: number) => j >= 0 ? c[j]?.trim() || '' : ''
      const invoiceRef = g(iInvoiceRef)
      const clientRef  = g(iClient)
      const amount     = g(iAmount)
      const pct        = g(iPct)
      const total      = g(iTotal)
      const reason     = g(iReason)
      const discountDate = normalizeDate(g(iDate)) || new Date().toISOString().slice(0, 10)

      // Resolve invoice_id (optional)
      const isUUID = /^[0-9a-f-]{36}$/i.test(invoiceRef)
      const invMatch = invoiceRef ? (isUUID ? { id: invoiceRef, client_id: '', total: 0 } : invMap[norm(invoiceRef)]) : null
      const invoice_id  = invMatch?.id || null
      const invoice_total_fallback = invMatch?.total || 0
      // Resolve client_id (required)
      let client_id = clientRef ? clientMap[norm(clientRef)] : (invMatch?.client_id || '')

      const r: ParsedRow = {
        ...baseRow(i), row_id: g(iId),
        invoice_ref:         invoiceRef,
        invoice_id:          invoice_id,
        client_ref:          clientRef,
        client_id:           client_id,
        discount_amount:     amount,
        discount_percentage: pct,
        invoice_total:       total || String(invoice_total_fallback),
        reason:              reason,
        discount_date:       discountDate,
      }
      if (invoiceRef && !invoice_id) r.errors.push(`Invoice "${invoiceRef}" not found in database`)
      if (!client_id) r.errors.push(`Client "${clientRef}" not found — required for discount history`)
      if (!amount && !pct) r.errors.push('Either discount_amount or discount_percentage is required')
      if (amount && isNaN(parseFloat(amount))) r.errors.push('discount_amount must be a number')
      if (pct && isNaN(parseFloat(pct))) r.errors.push('discount_percentage must be a number')
      if (r.discount_date && !/^\d{4}-\d{2}-\d{2}$/.test(r.discount_date)) r.errors.push('discount_date must be DD-MM-YYYY or YYYY-MM-DD')
      return finalize(r)
    })
  }

  // ── File handler ───────────────────────────────────────────────────────────
  const handleFile = useCallback(async (file: File) => {
    const text = await file.text()
    const lines = parseCSV(text)
    if (lines.length < 2) { toastError('File appears empty or has no data rows'); return }
    let parsed: ParsedRow[] = []
    switch (mode) {
      case 'employees':     parsed = parseEmployees(lines);          break
      case 'clients':       parsed = parseClients(lines);            break
      case 'services':      parsed = parseServices(lines);           break
      case 'groups':        parsed = parseGroups(lines);             break
      case 'parameters':    parsed = parseParameters(lines);         break
      case 'tools':          parsed = parseTools(lines);              break
      case 'pricing_matrix': parsed = parsePricingMatrix(lines);     break
      case 'jobs':           parsed = parseJobs(lines);              break
      case 'contributions': parsed = await parseContributions(lines); break
      case 'cashbook_entries': parsed = await parseCashbookEntries(lines);  break
      case 'invoices':         parsed = parseInvoices(lines);               break
      case 'invoice_status':   parsed = await parseInvoiceStatus(lines);    break
      case 'discounts':        parsed = await parseDiscounts(lines);        break
    }
    if (mode !== 'discounts' && (operation === 'update' || operation === 'delete')) {
      parsed.forEach(p => {
        if (!p.row_id) {
          p.errors.push('id is required in ' + operation + ' mode')
          p.status = 'error'
        }
      })
    }
    setRows(parsed)
    setStep('preview')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, operation, contribSubMode, parameters, clientMap, serviceMap, empMap, groupMap, bankAccountMap, cashCategoryMap])

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (f) handleFile(f) }
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }

  // ── Importers ──────────────────────────────────────────────────────────────
  async function runImport() {
    const valid = rows.filter(r => r.status !== 'error')
    if (!valid.length) { toastError('No valid rows to import'); return }
    setImporting(true)
    const res = { inserted: 0, skipped: 0, errors: [] as string[] }
    const BATCH = 50

    const batchInsert = async (table: string, records: any[], conflict?: string) => {
      for (let i = 0; i < records.length; i += BATCH) {
        const b = records.slice(i, i + BATCH)
        const q = conflict
          ? supabase.from(table).upsert(b, { onConflict: conflict }).select('id')
          : supabase.from(table).insert(b).select('id')
        const { data, error } = await q
        if (error) { res.errors.push(`Batch ${Math.floor(i/BATCH)+1}: ${error.message}`); res.skipped += b.length }
        else res.inserted += data?.length || 0
      }
    }

    const backupBeforeUpdate = async (table: string, ids: string[]) => {
      if (ids.length === 0) return
      const { data } = await supabase.from(table).select('*').in('id', ids)
      if (!data || data.length === 0) return
      const allKeys = new Set<string>()
      data.forEach((r: Record<string, unknown>) => Object.keys(r).forEach(k => allKeys.add(k)))
      const headers = ['id', ...[...allKeys].filter(k => k !== 'id').sort()]
      const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
      downloadCsv(`backup_${mode}_${ts}.csv`, toCsv(headers, data))
    }

    const batchUpdate = async (table: string, records: { row_id: string; fields: any }[]) => {
      const UBATCH = 25
      for (let i = 0; i < records.length; i += UBATCH) {
        const batch = records.slice(i, i + UBATCH)
        await Promise.all(batch.map(async ({ row_id, fields }) => {
          const { error } = await supabase.from(table).update(fields).eq('id', row_id)
          if (error) { res.errors.push(`row ${row_id}: ${error.message}`); res.skipped += 1 }
          else { res.inserted += 1 }
        }))
      }
    }

    async function batchDelete(table: string, ids: string[]) {
      if (ids.length === 0) return
      const BATCH = 25
      for (let i = 0; i < ids.length; i += BATCH) {
        const batch = ids.slice(i, i + BATCH)
        const { error } = await supabase.from(table).delete().in('id', batch)
        if (error) {
          res.errors.push(`Delete batch failed: ${error.message}`)
          res.skipped += batch.length
        } else {
          res.inserted += batch.length  // reusing inserted as "processed count"
        }
      }
    }

    switch (mode) {
      case 'employees': {
        const table = 'employees'
        if (operation === 'delete') {
          const ids = valid.map(r => r.row_id).filter(Boolean) as string[]
          await backupBeforeUpdate(table, ids)
          await batchDelete(table, ids)
          break
        }
        const recs = valid.map(r => ({
          row_id: r.row_id,
          fields: buildInsertRecord(EMPLOYEE_FIELDS, r),
        }))
        if (operation === 'update') {
          await backupBeforeUpdate(table, recs.map(r => r.row_id))
          await batchUpdate(table, recs)
        } else {
          await batchInsert(table, recs.map(r => ({ ...r.fields, is_active: r.fields.is_active ?? true })))
        }
        break
      }
      case 'clients': {
        const table = 'clients'
        if (operation === 'delete') {
          const ids = valid.map(r => r.row_id).filter(Boolean) as string[]
          await backupBeforeUpdate(table, ids)
          await batchDelete(table, ids)
          break
        }
        const recs = valid.map(r => ({
          row_id: r.row_id,
          fields: buildInsertRecord(CLIENT_FIELDS, r),
        }))
        if (operation === 'update') {
          await backupBeforeUpdate(table, recs.map(r => r.row_id))
          await batchUpdate(table, recs)
        } else {
          await batchInsert(table, recs.map(r => ({ ...r.fields, is_active: r.fields.is_active ?? true })))
        }
        break
      }
      case 'services': {
        const table = 'services'
        if (operation === 'delete') {
          const ids = valid.map(r => r.row_id).filter(Boolean) as string[]
          await backupBeforeUpdate(table, ids)
          await batchDelete(table, ids)
          break
        }
        const recs = valid.map(r => ({
          row_id:    r.row_id,
          group_ids: (r.group_ids || []) as string[],   // contribution group ids parsed from CSV
          fields: {
            name: r.name, pricing_type: r.pricing_type, description: r.description || null,
            display_order: parseInt(r.display_order) || 0,
            default_price: r.default_price ? parseFloat(r.default_price) : null,
            default_currency: r.default_currency || 'INR',
            is_active: r.is_active !== false,
          },
        }))

        // Helper: replace group_services links for one service id
        async function saveServiceGroups(serviceId: string, groupIds: string[]) {
          // Clean wipe + insert (mirrors the settings UI behaviour). Gracefully
          // ignores failures (e.g. if the group_services table doesn't exist).
          const { error: delErr } = await supabase.from('group_services').delete().eq('service_id', serviceId)
          if (delErr) return // table missing — skip silently
          if (groupIds.length > 0) {
            await supabase.from('group_services').insert(
              groupIds.map(gid => ({ group_id: gid, service_id: serviceId }))
            )
          }
        }

        if (operation === 'update') {
          await backupBeforeUpdate(table, recs.map(r => r.row_id))
          await batchUpdate(table, recs.map(r => ({ row_id: r.row_id!, fields: r.fields })))
          // Save group links for rows that specified group_names
          for (const r of recs) {
            if (r.row_id) await saveServiceGroups(r.row_id, r.group_ids)
          }
        } else {
          // Insert one-by-one so we can capture the new service IDs and save their group links.
          // (batchInsert collapses the response, losing per-row ids.)
          for (const r of recs) {
            const { data, error } = await supabase.from(table).insert(r.fields).select('id').single()
            if (error) { res.errors.push(`Service "${r.fields.name}": ${error.message}`); res.skipped += 1; continue }
            res.inserted += 1
            if (data?.id && r.group_ids.length > 0) await saveServiceGroups(data.id, r.group_ids)
          }
        }
        break
      }
      case 'groups': {
        const table = 'contribution_groups'
        if (operation === 'delete') {
          const ids = valid.map(r => r.row_id).filter(Boolean) as string[]
          await backupBeforeUpdate(table, ids)
          await batchDelete(table, ids)
          break
        }
        const recs = valid.map(r => ({
          row_id: r.row_id,
          fields: buildInsertRecord(GROUP_FIELDS, r),
        }))
        if (operation === 'update') {
          await backupBeforeUpdate(table, recs.map(r => r.row_id))
          await batchUpdate(table, recs)
        } else {
          await batchInsert(table, recs.map(r => ({ ...r.fields, is_active: r.fields.is_active ?? true })))
        }
        break
      }
      case 'parameters': {
        const table = 'parameters'
        if (operation === 'delete') {
          const ids = valid.map(r => r.row_id).filter(Boolean) as string[]
          await backupBeforeUpdate(table, ids)
          await batchDelete(table, ids)
          break
        }
        const recs = valid.map(r => ({
          row_id: r.row_id,
          // buildInsertRecord skips group_name (db:false); add resolved group_id manually
          fields: { ...buildInsertRecord(PARAMETER_FIELDS, r), group_id: r.group_id } as Record<string, any>,
        }))
        if (operation === 'update') {
          await backupBeforeUpdate(table, recs.map(r => r.row_id))
          await batchUpdate(table, recs)
        } else {
          const paramRows = recs.map(r => ({ ...r.fields, is_active: r.fields.is_active ?? true }))
          // Try with is_master first; fall back without it if column doesn't exist yet
          const firstBatch = await supabase.from('parameters').insert(paramRows.slice(0, 1)).select('id')
          if (firstBatch.error?.message?.includes('is_master')) {
            // Column not in schema yet — strip is_master and import without it
            const rowsWithout = (paramRows as any[]).map(({ is_master: _m, ...rest }: any) => rest)
            await batchInsert('parameters', rowsWithout)
            res.errors.push('⚠️ is_master column not found — run the SQL migration in Supabase to enable master parameter tracking. All other fields imported successfully.')
          } else {
            if (firstBatch.error) { res.errors.push(firstBatch.error.message); res.skipped += 1 }
            else { res.inserted += firstBatch.data?.length || 0 }
            if (paramRows.length > 1) await batchInsert('parameters', paramRows.slice(1))
          }
        }
        break
      }
      case 'tools': {
        const table = 'tools'
        if (operation === 'delete') {
          const ids = valid.map(r => r.row_id).filter(Boolean) as string[]
          await backupBeforeUpdate(table, ids)
          await batchDelete(table, ids)
          break
        }
        const recs = valid.map(r => ({
          row_id: r.row_id,
          // buildInsertRecord skips group_name (db:false); add resolved group_id manually
          fields: { ...buildInsertRecord(TOOL_FIELDS, r), group_id: r.group_id || null } as Record<string, any>,
        }))
        if (operation === 'update') {
          await backupBeforeUpdate(table, recs.map(r => r.row_id))
          await batchUpdate(table, recs)
        } else {
          await batchInsert(table, recs.map(r => ({ ...r.fields, is_active: r.fields.is_active ?? true })))
        }
        break
      }
      case 'pricing_matrix': {
        const table = 'client_service_pricing'
        if (operation === 'delete') {
          const ids = valid.map(r => r.row_id).filter(Boolean) as string[]
          await backupBeforeUpdate(table, ids)
          await batchDelete(table, ids)
          break
        }
        const recs = valid.map(r => ({
          row_id: r.row_id,
          fields: {
            client_id: r.client_id,
            service_id: r.service_id,
            price: r.price ? parseFloat(r.price) : null,
            percentage_rate: r.percentage_rate ? parseFloat(r.percentage_rate) : null,
            commission_percentage: parseFloat(r.commission_percentage) || 0,
            currency: (r.currency || 'INR').toUpperCase(),
          },
        }))
        if (operation === 'update') {
          await backupBeforeUpdate(table, recs.map(r => r.row_id))
          await batchUpdate(table, recs)
        } else {
          await batchInsert(table, recs.map(r => ({ ...r.fields, is_active: true })), 'client_id,service_id')
        }
        break
      }
      case 'jobs': {
        const table = 'tasks'
        if (operation === 'delete') {
          const ids = valid.map(r => r.row_id).filter(Boolean) as string[]
          await backupBeforeUpdate(table, ids)
          await batchDelete(table, ids)
          break
        }
        if (operation === 'update') {
          // In update mode, respect the CSV's task_number as-is (no auto-assign)
          const recs = valid.map(r => {
            const fields: any = {
              title: r.title, description: r.description || null,
              client_id: r.client_id || null, service_id: r.service_id || null,
              task_date: r.task_date,
              billing_amount_inr: parseFloat(r.billing_amount_inr) || 0,
              billing_amount: parseFloat(r.billing_amount) || parseFloat(r.billing_amount_inr) || 0,
              currency: r.currency || 'INR',
              quantity: parseFloat(r.quantity) || 1,
              status: r.task_status || 'done',
              is_recurring: r.is_recurring || false,
              recurring_interval: r.recurring_interval || null,
              recurring_end_date: r.recurring_end_date || null,
            }
            if (r.task_number && /^\d+$/.test(r.task_number)) {
              fields.task_number = parseInt(r.task_number, 10)
            }
            return { row_id: r.row_id, fields }
          })
          await backupBeforeUpdate('tasks', recs.map(r => r.row_id))
          await batchUpdate('tasks', recs)
        } else {
          // Base columns guaranteed to exist in schema
          const baseRows = valid.map(r => ({
            title: r.title,
            description: r.description || null,
            client_id: r.client_id || null,
            service_id: r.service_id || null,
            task_date: r.task_date,
            billing_amount_inr: parseFloat(r.billing_amount_inr) || 0,
            billing_amount: parseFloat(r.billing_amount) || parseFloat(r.billing_amount_inr) || 0,
            currency: r.currency || 'INR',
            status: r.task_status || 'done',
          }))

          // Extended columns added by migration 003 (may not exist on older deployments)
          const extendedRows = valid.map((r, i) => ({
            ...baseRows[i],
            ...(r.task_number && /^\d+$/.test(r.task_number) ? { task_number: parseInt(r.task_number, 10) } : {}),
            quantity: parseFloat(r.quantity) || 1,
            is_recurring: r.is_recurring || false,
            recurring_interval: r.recurring_interval || null,
            recurring_end_date: r.recurring_end_date || null,
          }))

          // Probe with a single extended row — fall back to base-only on any schema error
          const probe = await supabase.from('tasks').insert([extendedRows[0]]).select('id')
          const schemaError = probe.error?.message?.includes('column') || probe.error?.message?.includes('schema cache')
          if (schemaError) {
            // One or more new columns missing — import without them and warn once
            res.errors.push('⚠️ Some task columns (task_number / quantity / is_recurring) not found in schema. Run migrations/003_tasks_import_columns.sql in Supabase. Importing base fields only.')
            await batchInsert('tasks', baseRows)
          } else {
            // Extended columns exist — count probe row and import the rest
            if (probe.error) { res.errors.push(`Batch 1: ${probe.error.message}`); res.skipped += 1 }
            else { res.inserted += probe.data?.length || 0 }
            if (extendedRows.length > 1) await batchInsert('tasks', extendedRows.slice(1))
          }
        }
        break
      }
      case 'contributions': {
        const table = 'contribution_scores'
        if (operation === 'delete') {
          const ids = valid.map(r => r.row_id).filter(Boolean) as string[]
          await backupBeforeUpdate(table, ids)
          await batchDelete(table, ids)
          break
        }
        if (operation === 'update') {
          // Simple update path: update contribution_scores directly by id
          const recs = valid.map(r => ({
            row_id: r.row_id,
            fields: {
              task_id: r.task_id || null,
              employee_id: r.employee_id,
              score_percentage: parseFloat(r.score_percentage) || 0,
              earnings_inr: parseFloat(r.earnings) || 0,
              calculated_at: new Date().toISOString(),
            },
          }))
          await backupBeforeUpdate('contribution_scores', recs.map(r => r.row_id))
          await batchUpdate('contribution_scores', recs)
        } else if (contribSubMode === 'earnings_only') {
          // Store earnings directly, score_percentage = 0 (unknown)
          await batchInsert('contribution_scores', valid.map(r => ({
            task_id: r.task_id || null,
            employee_id: r.employee_id,
            score_percentage: 0,
            earnings_inr: parseFloat(r.earnings) || 0,
            calculated_at: new Date().toISOString(),
          })), 'task_id,employee_id')
        } else if (contribSubMode === 'score_pct') {
          // Store score + earnings (earnings may be blank → 0)
          await batchInsert('contribution_scores', valid.map(r => ({
            task_id: r.task_id || null,
            employee_id: r.employee_id,
            score_percentage: parseFloat(r.score_percentage) || 0,
            earnings_inr: parseFloat(r.earnings) || 0,
            calculated_at: new Date().toISOString(),
          })), 'task_id,employee_id')
        } else {
          // param_detail — insert into contributions table (parameter-level values)
          const contribRows: any[] = []
          for (const r of valid) {
            for (const [paramId, rawVal] of Object.entries(r._paramValues as Record<string, string>)) {
              const val = parseFloat(rawVal) || 0
              if (val > 0) {  // only insert non-zero values
                contribRows.push({
                  task_id: r.task_id || null,
                  employee_id: r.employee_id,
                  parameter_id: paramId,
                  value: val,
                  locked: false,
                })
              }
            }
          }
          if (contribRows.length) {
            await batchInsert('contributions', contribRows)
          }
        }
        break
      }

      case 'cashbook_entries': {
        const table = 'cashbook_entries'
        if (operation === 'delete') {
          const ids = valid.map(r => r.row_id).filter(Boolean) as string[]
          await backupBeforeUpdate(table, ids)
          await batchDelete(table, ids)
          break
        }
        const recs = valid.map(r => ({
          row_id: r.row_id,
          fields: {
            entry_date:      r.entry_date,
            type:            r.type,
            category_id:     r.category_id || null,
            bank_account_id: r.bank_account_id || null,
            amount:          parseFloat(r.amount) || 0,
            currency:        r.currency || 'INR',
            amount_inr:      parseFloat(r.amount_inr || r.amount) || 0,
            description:     r.description || null,
            reference:       r.reference || null,
            invoice_id:      r.invoice_id || null,
            client_id:       r.client_id   || null,  // resolved from reference column
            employee_id:     r.employee_id || null,  // resolved from reference column
          },
        }))
        if (operation === 'update') {
          await backupBeforeUpdate(table, recs.map(r => r.row_id).filter(Boolean) as string[])
          await batchUpdate(table, recs.filter(r => r.row_id) as any)
        } else {
          // Custom batch insert to handle auto-allocation of Salary entries
          const salaryCatId = Object.entries(cashCategoryMap).find(([k]) => k.includes('salary') || k.includes('salaries'))?.[1]
          
          for (let i = 0; i < recs.length; i += BATCH) {
            const b = recs.slice(i, i + BATCH).map(r => r.fields)
            const { data, error } = await supabase.from(table).insert(b).select('id, category_id, reference, amount_inr')
            if (error) { 
              res.errors.push(`Batch ${Math.floor(i/BATCH)+1}: ${error.message}`)
              res.skipped += b.length 
            } else {
              res.inserted += data?.length || 0
              
              if (data && salaryCatId) {
                const salaryEntries = data.filter(d => d.category_id === salaryCatId && d.reference)
                for (const entry of salaryEntries) {
                  const match = entry.reference.match(/(CQID\d{3})/i)
                  if (match) {
                    const cqid = match[1].toUpperCase()
                    const empId = empMap[norm(cqid)]
                    if (empId) {
                      // Fetch pending payrolls for employee (oldest first)
                      const { data: payrolls } = await supabase.from('payroll')
                        .select('id, net_salary')
                        .eq('employee_id', empId)
                        .eq('status', 'pending')
                        .order('created_at', { ascending: true })
                      
                      let remaining = Number(entry.amount_inr)
                      for (const p of (payrolls || [])) {
                        if (remaining <= 0.01) break
                        
                        const pNet = Number(p.net_salary)
                        const { data: allocs } = await supabase.from('cashbook_payroll_allocations')
                          .select('allocated_amount')
                          .eq('payroll_id', p.id)
                          .is('deleted_at', null)
                        
                        const alreadyAllocated = allocs?.reduce((sum, a) => sum + Number(a.allocated_amount), 0) || 0
                        const needed = Math.max(0, pNet - alreadyAllocated)
                        
                        if (needed > 0.01) {
                          const allocAmt = Math.min(remaining, needed)
                          await supabase.from('cashbook_payroll_allocations').insert({
                            cashbook_entry_id: entry.id,
                            payroll_id: p.id,
                            allocated_amount: allocAmt
                          })
                          remaining -= allocAmt
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
        break
      }

      case 'invoices': {
        const table = 'invoices'
        if (operation === 'delete') {
          const ids = valid.map(r => r.row_id).filter(Boolean) as string[]
          await backupBeforeUpdate(table, ids)
          await batchDelete(table, ids)
          break
        }
        const recs = valid.map(r => ({
          row_id: r.row_id,
          fields: {
            invoice_number:       r.invoice_number,
            client_id:            r.client_id,
            issue_date:           r.issue_date,
            due_date:             r.due_date || null,
            billing_period_start: r.billing_period_start || null,
            billing_period_end:   r.billing_period_end   || null,
            currency:             r.currency || 'INR',
            subtotal:             parseFloat(r.subtotal) || 0,
            total_amount:         parseFloat(r.subtotal) || 0,
            tax_rate:             parseFloat(r.tax_rate) || 0,
            tax_amount:           0,
            discount_amount:      parseFloat(r.discount_amount) || 0,
            status:               r.invoice_status || 'draft',
            notes:                r.notes || null,
          },
        }))
        if (operation === 'update') {
          await backupBeforeUpdate(table, recs.map(r => r.row_id).filter(Boolean) as string[])
          await batchUpdate(table, recs.filter(r => r.row_id) as any)
        } else {
          await batchInsert(table, recs.map(r => r.fields))
        }
        break
      }

      case 'discounts': {
        // Upsert by invoice_id — no id column needed in CSV.
        // Also syncs invoices.discount_amount + recalculates invoices.total_amount
        // so the discount is reflected in the invoice detail view.
        const invoiceIds = valid.map(r => r.invoice_id).filter(Boolean) as string[]

        // Fetch existing discount_logs and invoice financials in parallel
        const [existingLogsRes, invoiceDataRes] = await Promise.all([
          invoiceIds.length
            ? supabase.from('discount_logs').select('id, invoice_id').in('invoice_id', invoiceIds)
            : Promise.resolve({ data: [] as any[] }),
          invoiceIds.length
            ? supabase.from('invoices').select('id, subtotal, tax_amount, previous_balance, total_amount, discount_amount').in('id', invoiceIds)
            : Promise.resolve({ data: [] as any[] }),
        ])

        const existingByInvoice = new Map<string, string>()
        ;((existingLogsRes as any).data || []).forEach((row: any) => existingByInvoice.set(row.invoice_id, row.id))

        const invoiceFinancials = new Map<string, { subtotal: number; tax_amount: number; previous_balance: number; total_amount: number; discount_amount: number }>()
        ;((invoiceDataRes as any).data || []).forEach((inv: any) => invoiceFinancials.set(inv.id, {
          subtotal:         inv.subtotal         || 0,
          tax_amount:       inv.tax_amount       || 0,
          previous_balance: inv.previous_balance || 0,
          total_amount:     inv.total_amount     || 0,
          discount_amount:  inv.discount_amount  || 0,
        }))

        for (const r of valid) {
          if (!r.invoice_id) { res.skipped += 1; continue }
          const amount = parseFloat(r.discount_amount) || 0
          const pct    = parseFloat(r.discount_percentage) || 0
          const total  = parseFloat(r.invoice_total) || 0
          let finalAmount     = amount
          let finalPercentage = pct
          if (!finalAmount && finalPercentage && total > 0)     finalAmount     = (finalPercentage / 100) * total
          if (!finalPercentage && finalAmount && total > 0)     finalPercentage = (finalAmount   / total) * 100

          const logFields = {
            invoice_id:          r.invoice_id,
            client_id:           r.client_id || null,
            discount_amount:     finalAmount,
            discount_percentage: finalPercentage,
            invoice_total:       total,
            reason:              r.reason || 'Bulk import',
            created_at:          r.discount_date ? new Date(r.discount_date).toISOString() : new Date().toISOString(),
          }

          // Upsert discount_logs
          const existingId = existingByInvoice.get(r.invoice_id)
          const { error: logErr } = existingId
            ? await supabase.from('discount_logs').update(logFields).eq('id', existingId)
            : await supabase.from('discount_logs').insert(logFields)

          if (logErr) { res.errors.push(`${r.invoice_ref}: ${logErr.message}`); res.skipped += 1; continue }

          // Sync invoices.discount_amount + recalculate total_amount.
          // For historical invoices (subtotal=0), derive the pre-discount base
          // from current total_amount + current discount_amount (delta approach).
          const fin = invoiceFinancials.get(r.invoice_id)
          const sub      = fin?.subtotal || 0
          const tax      = fin?.tax_amount || 0
          const prevBal  = fin?.previous_balance || 0
          const oldTotal = fin?.total_amount || 0
          const oldDisc  = fin?.discount_amount || 0

          let newTotal: number
          if (sub > 0) {
            // Full financials available — recalculate properly
            newTotal = Math.max(0, sub + tax - finalAmount + prevBal)
          } else {
            // Historical import: only total_amount is set, no subtotal breakdown.
            // Derive pre-discount base and apply new discount delta.
            const preDiscountBase = oldTotal + oldDisc
            newTotal = Math.max(0, preDiscountBase - finalAmount)
          }

          const { error: invErr } = await supabase
            .from('invoices')
            .update({ discount_amount: finalAmount, total_amount: newTotal })
            .eq('id', r.invoice_id)

          if (invErr) { res.errors.push(`${r.invoice_ref} (invoice sync): ${invErr.message}`); res.skipped += 1 }
          else res.inserted += 1
        }
        break
      }

      case 'invoice_status': {
        // Special: update invoice status + optionally insert a payment record
        for (const r of valid) {
          const invId = r.invoice_id
          if (!invId) { res.skipped += 1; continue }
          const updateFields: any = { status: r.invoice_status }
          if (r.paid_amount) updateFields.paid_amount = parseFloat(r.paid_amount)
          const { error: updErr } = await supabase.from('invoices').update(updateFields).eq('id', invId)
          if (updErr) { res.errors.push(`${r.invoice_ref}: ${updErr.message}`); res.skipped += 1; continue }
          // Optionally insert payment record
          if (r.paid_amount && parseFloat(r.paid_amount) > 0) {
            await supabase.from('invoice_payments').insert({
              invoice_id: invId,
              amount: parseFloat(r.paid_amount),
              payment_date: r.payment_date || new Date().toISOString().slice(0, 10),
              payment_method: r.payment_method || 'other',
              notes: r.notes || null,
            }).select('id')
          }
          res.inserted += 1
        }
        break
      }
    }

    setResult(res)
    setImporting(false)
    setStep('done')
    if (res.inserted > 0) success(`${res.inserted} records ${operation === 'update' ? 'updated' : operation === 'delete' ? 'deleted' : 'imported'} successfully`)
    if (res.errors.length) toastError(`${res.errors.length} batch error(s)`)
  }

  function reset() { setStep('upload'); setRows([]); setResult(null); if (fileRef.current) fileRef.current.value = '' }

  // ── Clean-up helpers ───────────────────────────────────────────────────────
  const TABLE_FOR_MODE: Record<ImportMode, string> = {
    employees:        'employees',
    clients:          'clients',
    services:         'services',
    groups:           'contribution_groups',
    parameters:       'parameters',
    tools:            'tools',
    pricing_matrix:   'client_service_pricing',
    jobs:             'tasks',
    contributions:    'contribution_scores',
    cashbook_entries: 'cashbook_entries',
    invoices:         'invoices',
    invoice_status:   'invoices',
    discounts:        'discount_logs',
  }

  async function loadCleanupRecords(m: ImportMode) {
    setCleanupLoading(true)
    setSelectedIds(new Set())
    setCleanupRecords([])
    const table = TABLE_FOR_MODE[m]
    let q: any

    if (m === 'parameters') {
      q = supabase.from('parameters')
        .select('id, name, weight, is_active, display_order, contribution_groups(name)')
        .order('display_order')
    } else if (m === 'tools') {
      q = supabase.from('tools')
        .select('id, name, fixed_percentage, is_active, contribution_groups(name)')
        .order('name')
    } else if (m === 'pricing_matrix') {
      q = supabase.from('client_service_pricing')
        .select('id, price, percentage_rate, commission_percentage, currency, is_active, clients(name, code), services(name)')
        .order('created_at', { ascending: false })
    } else if (m === 'jobs') {
      q = supabase.from('tasks')
        .select('id, title, task_date, status, billing_amount_inr, clients(name)')
        .order('task_date', { ascending: false })
        .limit(500)
    } else if (m === 'contributions') {
      q = supabase.from('contribution_scores')
        .select('id, score_percentage, earnings_inr, calculated_at, tasks(title, task_date), employees(name, cqid)')
        .order('calculated_at', { ascending: false })
        .limit(500)
    } else {
      q = supabase.from(table).select('*').order('created_at', { ascending: false })
    }

    const { data, error } = await q
    if (error) { toastError(`Failed to load: ${error.message}`); setCleanupLoading(false); return }
    setCleanupRecords(data || [])
    setCleanupLoading(false)
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    if (selectedIds.size === cleanupRecords.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(cleanupRecords.map((r: any) => r.id)))
    }
  }

  async function deleteSelected() {
    if (selectedIds.size === 0) return
    const ids = [...selectedIds]

    // Warn about cascade for certain entity types
    const cascadeWarnings: Record<string, string> = {
      parameters:    'Contributions referencing these parameters will also be deleted.',
      jobs:          'Invoice items, contributions, and contribution scores for these tasks will also be deleted.',
      employees:     'Contribution scores for these employees will also be deleted.',
      groups:        'All parameters (and their contributions) inside these groups will also be deleted.',
    }
    const extraWarning = cascadeWarnings[cleanupMode] ? `\n\n⚠️ ${cascadeWarnings[cleanupMode]}` : ''
    if (!window.confirm(`Delete ${ids.length} record${ids.length !== 1 ? 's' : ''}? This cannot be undone.${extraWarning}`)) return

    setDeleting(true)
    const BATCH = 100

    const batchDelete = async (table: string, field: string, values: string[]) => {
      for (let i = 0; i < values.length; i += BATCH) {
        const { error } = await supabase.from(table).delete().in(field, values.slice(i, i + BATCH))
        if (error) throw new Error(`${table}: ${error.message}`)
      }
    }

    try {
      // ── Cascade deletes before the main delete ──────────────────────────────
      if (cleanupMode === 'parameters') {
        // Delete contributions that use these parameters
        await batchDelete('contributions', 'parameter_id', ids)
      }
      if (cleanupMode === 'groups') {
        // Find all parameter IDs in these groups, then cascade
        const { data: paramRows } = await supabase.from('parameters').select('id').in('group_id', ids)
        const paramIds = (paramRows || []).map((p: any) => p.id)
        if (paramIds.length) {
          await batchDelete('contributions', 'parameter_id', paramIds)
          await batchDelete('parameters', 'id', paramIds)
        }
      }
      if (cleanupMode === 'jobs') {
        // Delete invoice_items referencing these tasks (FK: invoice_items_task_id_fkey)
        await batchDelete('invoice_items', 'task_id', ids)
        // Delete contribution_scores for these tasks
        await batchDelete('contribution_scores', 'task_id', ids)
        await batchDelete('contributions', 'task_id', ids)
      }
      if (cleanupMode === 'employees') {
        // Delete contribution_scores for these employees
        await batchDelete('contribution_scores', 'employee_id', ids)
        await batchDelete('contributions', 'employee_id', ids)
      }
      if (cleanupMode === 'cashbook_entries') {
        // Delete any related allocations before deleting the entries to satisfy foreign key constraint
        await batchDelete('cashbook_invoice_allocations', 'cashbook_entry_id', ids)
      }

      // ── Main delete ─────────────────────────────────────────────────────────
      await batchDelete(TABLE_FOR_MODE[cleanupMode], 'id', ids)

      setDeleting(false)
      success(`${ids.length} record${ids.length !== 1 ? 's' : ''} deleted`)
      await loadCleanupRecords(cleanupMode)
    } catch (err: any) {
      setDeleting(false)
      toastError(`Delete failed: ${err.message}`)
    }
  }

  // ── Clean-up table ─────────────────────────────────────────────────────────
  function renderCleanupTable() {
    const thCls = 'px-3 py-2 text-left text-muted-foreground text-[11px] font-semibold'
    const tdCls = 'px-3 py-2 text-xs'
    const allSelected = cleanupRecords.length > 0 && selectedIds.size === cleanupRecords.length

    const CheckTh = () => (
      <th className="px-3 py-2 w-8">
        <input type="checkbox" checked={allSelected} onChange={toggleSelectAll}
          className="accent-violet-500 w-3.5 h-3.5" />
      </th>
    )
    const CheckTd = ({ id }: { id: string }) => (
      <td className="px-3 py-2">
        <input type="checkbox" checked={selectedIds.has(id)} onChange={() => toggleSelect(id)}
          className="accent-violet-500 w-3.5 h-3.5" />
      </td>
    )
    const selCls = (id: string) => `border-b border-border/40 ${selectedIds.has(id) ? 'bg-violet-500/10' : ''}`

    if (cleanupMode === 'employees') return (
      <table className="w-full"><thead><tr className="border-b border-border bg-background/40">
        <CheckTh/><th className={thCls}>CQID</th><th className={thCls}>Name</th>
        <th className={thCls}>Email</th><th className={thCls}>Role</th><th className={thCls}>Active</th>
      </tr></thead><tbody>{cleanupRecords.map((r: any) => (
        <tr key={r.id} className={selCls(r.id)} onClick={() => toggleSelect(r.id)}>
          <CheckTd id={r.id}/><td className={tdCls+' font-mono text-violet-300'}>{r.cqid}</td>
          <td className={tdCls+' font-medium'}>{r.name}</td>
          <td className={tdCls+' text-muted-foreground'}>{r.email}</td>
          <td className={tdCls}>{r.role}</td>
          <td className={tdCls}>{r.is_active ? <span className="text-green-400 text-[10px]">Active</span> : <span className="text-red-400 text-[10px]">Inactive</span>}</td>
        </tr>))}</tbody></table>
    )

    if (cleanupMode === 'clients') return (
      <table className="w-full"><thead><tr className="border-b border-border bg-background/40">
        <CheckTh/><th className={thCls}>Code</th><th className={thCls}>Name</th>
        <th className={thCls}>Contact</th><th className={thCls}>Phone</th><th className={thCls}>Active</th>
      </tr></thead><tbody>{cleanupRecords.map((r: any) => (
        <tr key={r.id} className={selCls(r.id)} onClick={() => toggleSelect(r.id)}>
          <CheckTd id={r.id}/><td className={tdCls+' font-mono text-violet-300'}>{r.code}</td>
          <td className={tdCls+' font-medium'}>{r.name}</td>
          <td className={tdCls+' text-muted-foreground'}>{r.contact_name || '—'}</td>
          <td className={tdCls}>{r.phone || '—'}</td>
          <td className={tdCls}>{r.is_active ? <span className="text-green-400 text-[10px]">Active</span> : <span className="text-red-400 text-[10px]">Inactive</span>}</td>
        </tr>))}</tbody></table>
    )

    if (cleanupMode === 'services') return (
      <table className="w-full"><thead><tr className="border-b border-border bg-background/40">
        <CheckTh/><th className={thCls}>Name</th><th className={thCls}>Pricing Type</th><th className={thCls}>Active</th>
      </tr></thead><tbody>{cleanupRecords.map((r: any) => (
        <tr key={r.id} className={selCls(r.id)} onClick={() => toggleSelect(r.id)}>
          <CheckTd id={r.id}/><td className={tdCls+' font-medium'}>{r.name}</td>
          <td className={tdCls+' text-muted-foreground'}>{r.pricing_type}</td>
          <td className={tdCls}>{r.is_active ? <span className="text-green-400 text-[10px]">Active</span> : <span className="text-red-400 text-[10px]">Inactive</span>}</td>
        </tr>))}</tbody></table>
    )

    if (cleanupMode === 'groups') return (
      <table className="w-full"><thead><tr className="border-b border-border bg-background/40">
        <CheckTh/><th className={thCls}>Name</th><th className={thCls}>Weight</th><th className={thCls}>Active</th>
      </tr></thead><tbody>{cleanupRecords.map((r: any) => (
        <tr key={r.id} className={selCls(r.id)} onClick={() => toggleSelect(r.id)}>
          <CheckTd id={r.id}/><td className={tdCls+' font-medium'}>{r.name}</td>
          <td className={tdCls}>{r.weight}</td>
          <td className={tdCls}>{r.is_active ? <span className="text-green-400 text-[10px]">Active</span> : <span className="text-red-400 text-[10px]">Inactive</span>}</td>
        </tr>))}</tbody></table>
    )

    if (cleanupMode === 'parameters') return (
      <table className="w-full"><thead><tr className="border-b border-border bg-background/40">
        <CheckTh/><th className={thCls}>Group</th><th className={thCls}>Parameter Name</th>
        <th className={thCls}>Weight</th><th className={thCls}>Order</th><th className={thCls}>Active</th>
      </tr></thead><tbody>{cleanupRecords.map((r: any) => (
        <tr key={r.id} className={selCls(r.id)} onClick={() => toggleSelect(r.id)}>
          <CheckTd id={r.id}/>
          <td className={tdCls+' text-muted-foreground text-[11px]'}>{(r.contribution_groups as any)?.name || '—'}</td>
          <td className={tdCls+' font-medium'}>{r.name}</td>
          <td className={tdCls}>{r.weight}</td>
          <td className={tdCls}>{r.display_order}</td>
          <td className={tdCls}>{r.is_active ? <span className="text-green-400 text-[10px]">Active</span> : <span className="text-red-400 text-[10px]">Inactive</span>}</td>
        </tr>))}</tbody></table>
    )

    if (cleanupMode === 'tools') return (
      <table className="w-full"><thead><tr className="border-b border-border bg-background/40">
        <CheckTh/><th className={thCls}>Tool Name</th><th className={thCls}>Fixed %</th>
        <th className={thCls}>Group</th><th className={thCls}>Active</th>
      </tr></thead><tbody>{cleanupRecords.map((r: any) => (
        <tr key={r.id} className={selCls(r.id)} onClick={() => toggleSelect(r.id)}>
          <CheckTd id={r.id}/>
          <td className={tdCls+' font-medium'}>{r.name}</td>
          <td className={tdCls}>{r.fixed_percentage}%</td>
          <td className={tdCls+' text-muted-foreground text-[11px]'}>{(r.contribution_groups as any)?.name || '—'}</td>
          <td className={tdCls}>{r.is_active ? <span className="text-green-400 text-[10px]">Active</span> : <span className="text-red-400 text-[10px]">Inactive</span>}</td>
        </tr>))}</tbody></table>
    )

    if (cleanupMode === 'pricing_matrix') return (
      <table className="w-full"><thead><tr className="border-b border-border bg-background/40">
        <CheckTh/><th className={thCls}>Client</th><th className={thCls}>Service</th>
        <th className={thCls+' text-right'}>Price</th><th className={thCls+' text-right'}>Rate%</th>
        <th className={thCls+' text-right'}>Commission%</th><th className={thCls}>Currency</th><th className={thCls}>Active</th>
      </tr></thead><tbody>{cleanupRecords.map((r: any) => (
        <tr key={r.id} className={selCls(r.id)} onClick={() => toggleSelect(r.id)}>
          <CheckTd id={r.id}/>
          <td className={tdCls+' font-medium'}>{(r.clients as any)?.name || '—'}</td>
          <td className={tdCls+' text-muted-foreground'}>{(r.services as any)?.name || '—'}</td>
          <td className={tdCls+' text-right font-mono'}>{r.price ? `₹${Number(r.price).toLocaleString('en-IN')}` : '—'}</td>
          <td className={tdCls+' text-right font-mono'}>{r.percentage_rate ? `${r.percentage_rate}%` : '—'}</td>
          <td className={tdCls+' text-right font-mono text-violet-300'}>{r.commission_percentage}%</td>
          <td className={tdCls}>{r.currency}</td>
          <td className={tdCls}>{r.is_active ? <span className="text-green-400 text-[10px]">Active</span> : <span className="text-red-400 text-[10px]">Inactive</span>}</td>
        </tr>))}</tbody></table>
    )

    if (cleanupMode === 'jobs') return (
      <table className="w-full"><thead><tr className="border-b border-border bg-background/40">
        <CheckTh/><th className={thCls}>Title</th><th className={thCls}>Client</th>
        <th className={thCls}>Date</th><th className={thCls}>Amount</th><th className={thCls}>Status</th>
      </tr></thead><tbody>{cleanupRecords.map((r: any) => (
        <tr key={r.id} className={selCls(r.id)} onClick={() => toggleSelect(r.id)}>
          <CheckTd id={r.id}/>
          <td className={tdCls+' font-medium max-w-[160px] truncate'} title={r.title}>{r.title}</td>
          <td className={tdCls+' text-muted-foreground text-[11px]'}>{(r.clients as any)?.name || '—'}</td>
          <td className={tdCls+' font-mono text-[11px]'}>{r.task_date}</td>
          <td className={tdCls+' font-mono text-right'}>{r.billing_amount_inr ? `₹${Number(r.billing_amount_inr).toLocaleString('en-IN')}` : '—'}</td>
          <td className={tdCls}><span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${r.status === 'done' ? 'bg-green-500/15 text-green-400' : r.status === 'pending' ? 'bg-yellow-500/15 text-yellow-400' : 'bg-blue-500/15 text-blue-400'}`}>{r.status}</span></td>
        </tr>))}</tbody></table>
    )

    if (cleanupMode === 'cashbook_entries') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <CheckTh/><th className={thCls}>Date</th><th className={thCls}>Type</th>
        <th className={thCls}>Description</th><th className={thCls+' text-right'}>Amount</th><th className={thCls}>Currency</th>
      </tr></thead><tbody>{cleanupRecords.map((r: any) => (
        <tr key={r.id} className={selCls(r.id)} onClick={() => toggleSelect(r.id)}>
          <CheckTd id={r.id}/>
          <td className={tdCls+' font-mono'}>{r.entry_date}</td>
          <td className={tdCls}><span className={r.type==='inflow'?'text-green-400':'text-red-400'}>{r.type}</span></td>
          <td className={tdCls+' max-w-[200px] truncate'} title={r.description}>{r.description || '—'}</td>
          <td className={tdCls+' text-right font-mono'}>{r.amount?.toLocaleString('en-IN')}</td>
          <td className={tdCls}>{r.currency}</td>
        </tr>))}</tbody></table>
    )

    if (cleanupMode === 'invoices') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <CheckTh/><th className={thCls}>Invoice #</th><th className={thCls}>Issue Date</th>
        <th className={thCls}>Status</th><th className={thCls+' text-right'}>Total</th>
      </tr></thead><tbody>{cleanupRecords.map((r: any) => (
        <tr key={r.id} className={selCls(r.id)} onClick={() => toggleSelect(r.id)}>
          <CheckTd id={r.id}/>
          <td className={tdCls+' font-mono text-violet-300'}>{r.invoice_number}</td>
          <td className={tdCls+' font-mono'}>{r.issue_date}</td>
          <td className={tdCls}>{r.status}</td>
          <td className={tdCls+' text-right font-mono'}>₹{r.total_amount?.toLocaleString('en-IN')}</td>
        </tr>))}</tbody></table>
    )

    // contributions
    return (
      <table className="w-full"><thead><tr className="border-b border-border bg-background/40">
        <CheckTh/><th className={thCls}>Task</th><th className={thCls}>Date</th>
        <th className={thCls}>Employee</th><th className={thCls}>Score %</th><th className={thCls}>Earnings</th>
      </tr></thead><tbody>{cleanupRecords.map((r: any) => (
        <tr key={r.id} className={selCls(r.id)} onClick={() => toggleSelect(r.id)}>
          <CheckTd id={r.id}/>
          <td className={tdCls+' max-w-[140px] truncate'} title={(r.tasks as any)?.title}>{(r.tasks as any)?.title || '—'}</td>
          <td className={tdCls+' font-mono text-[11px]'}>{(r.tasks as any)?.task_date || '—'}</td>
          <td className={tdCls}>{(r.employees as any)?.cqid} · {(r.employees as any)?.name}</td>
          <td className={tdCls+' text-right font-mono'}>{r.score_percentage}%</td>
          <td className={tdCls+' text-right font-mono'}>{r.earnings_inr ? `₹${Number(r.earnings_inr).toLocaleString('en-IN')}` : '—'}</td>
        </tr>))}</tbody></table>
    )
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  const okCount    = rows.filter(r => r.status === 'ok').length
  const warnCount  = rows.filter(r => r.status === 'warn').length
  const errorCount = rows.filter(r => r.status === 'error').length

  // ── Preview table ──────────────────────────────────────────────────────────
  function renderPreviewTable() {
    const thCls = 'px-3 py-2 text-left text-muted-foreground'
    const tdCls = 'px-3 py-2'

    if (mode === 'employees') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th><th className={thCls}>CQID</th>
        <th className={thCls}>Name</th><th className={thCls}>Email</th><th className={thCls}>Role</th>
        <th className={thCls}>Salary Type</th><th className={thCls}>Base ₹</th><th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':r.status==='warn'?'bg-yellow-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls+' font-mono text-violet-300'}>{r.cqid}</td>
          <td className={tdCls+' font-medium'}>{r.name}</td>
          <td className={tdCls+' text-muted-foreground'}>{r.email}</td>
          <td className={tdCls}>{r.role}</td>
          <td className={tdCls}>{r.salary_type}</td>
          <td className={tdCls+' text-right font-mono'}>{r.base_salary ? `₹${parseFloat(r.base_salary).toLocaleString('en-IN')}` : '—'}</td>
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )

    if (mode === 'clients') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th><th className={thCls}>Code</th>
        <th className={thCls}>Name</th><th className={thCls}>Contact</th>
        <th className={thCls}>Phone</th><th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':r.status==='warn'?'bg-yellow-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls+' font-mono text-violet-300'}>{r.code}</td>
          <td className={tdCls+' font-medium'}>{r.name}</td>
          <td className={tdCls+' text-muted-foreground'}>{r.contact_name}</td>
          <td className={tdCls}>{r.phone}</td>
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )

    if (mode === 'services') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th><th className={thCls}>Name</th>
        <th className={thCls}>Pricing Type</th><th className={thCls}>Order</th><th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls+' font-medium'}>{r.name}</td>
          <td className={tdCls}>{r.pricing_type}</td>
          <td className={tdCls}>{r.display_order}</td>
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )

    if (mode === 'groups') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th><th className={thCls}>Name</th>
        <th className={thCls}>Weight</th><th className={thCls}>Order</th><th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls+' font-medium'}>{r.name}</td>
          <td className={tdCls}>{r.weight}</td>
          <td className={tdCls}>{r.display_order}</td>
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )

    if (mode === 'parameters') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th><th className={thCls}>Group</th>
        <th className={thCls}>Parameter Name</th><th className={thCls}>Master?</th><th className={thCls}>Weight</th><th className={thCls}>Order</th><th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':r.status==='warn'?'bg-yellow-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls}>{r.group_id ? <span className="text-green-400">{r.group_name}</span> : <span className="text-red-400">{r.group_name}</span>}</td>
          <td className={tdCls+' font-medium'}>{r.name || <span className="text-red-400 italic">missing</span>}</td>
          <td className={tdCls+' text-center'}>{r.is_master ? <span className="text-violet-400 font-semibold">✓</span> : <span className="text-muted-foreground/40">—</span>}</td>
          <td className={tdCls}>{r.weight}</td>
          <td className={tdCls}>{r.display_order}</td>
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )

    if (mode === 'tools') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th><th className={thCls}>Tool Name</th>
        <th className={thCls}>Fixed %</th><th className={thCls}>Group</th><th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':r.status==='warn'?'bg-yellow-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls+' font-medium'}>{r.name}</td>
          <td className={tdCls}>{r.fixed_percentage}%</td>
          <td className={tdCls}>{r.group_id ? <span className="text-green-400">{r.group_name}</span> : <span className="text-muted-foreground/50">{r.group_name || '—'}</span>}</td>
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )

    if (mode === 'pricing_matrix') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th>
        <th className={thCls}>Client</th><th className={thCls}>Service</th>
        <th className={thCls+' text-right'}>Price</th><th className={thCls+' text-right'}>Rate%</th>
        <th className={thCls+' text-right'}>Commission%</th><th className={thCls}>Currency</th><th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':r.status==='warn'?'bg-yellow-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls}>{r.client_id?<span className="text-green-400">{r.client_ref}</span>:<span className="text-red-400">{r.client_ref}</span>}</td>
          <td className={tdCls}>{r.service_id?<span className="text-green-400">{r.service_ref}</span>:<span className="text-red-400">{r.service_ref}</span>}</td>
          <td className={tdCls+' text-right font-mono'}>{r.price?`₹${parseFloat(r.price).toLocaleString('en-IN')}`:'—'}</td>
          <td className={tdCls+' text-right font-mono'}>{r.percentage_rate?`${r.percentage_rate}%`:'—'}</td>
          <td className={tdCls+' text-right font-mono text-violet-300'}>{r.commission_percentage?`${r.commission_percentage}%`:'—'}</td>
          <td className={tdCls}>{r.currency}</td>
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )

    if (mode === 'jobs') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th><th className={thCls}>Title</th>
        <th className={thCls}>Client</th><th className={thCls}>Service</th>
        <th className={thCls}>Date</th><th className={thCls}>Amount</th><th className={thCls}>Status</th><th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':r.status==='warn'?'bg-yellow-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls+' font-medium max-w-[150px] truncate'} title={r.title}>{r.title}</td>
          <td className={tdCls}>{r.client_id?<span className="text-green-400">{r.client_ref}</span>:r.client_ref?<span className="text-yellow-400">{r.client_ref}</span>:'—'}</td>
          <td className={tdCls}>{r.service_id?<span className="text-green-400">{r.service_ref}</span>:r.service_ref?<span className="text-yellow-400">{r.service_ref}</span>:'—'}</td>
          <td className={tdCls+' font-mono'}>{r.task_date}</td>
          <td className={tdCls+' text-right font-mono'}>{r.billing_amount_inr?`₹${parseFloat(r.billing_amount_inr).toLocaleString('en-IN')}`:'—'}</td>
          <td className={tdCls}>{r.task_status}</td>
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )

    if (mode === 'cashbook_entries') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th><th className={thCls}>Date</th>
        <th className={thCls}>Type</th><th className={thCls}>Category</th><th className={thCls}>Bank Account</th>
        <th className={thCls+' text-right'}>Amount</th><th className={thCls}>Currency</th><th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':r.status==='warn'?'bg-yellow-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls+' font-mono'}>{r.entry_date}</td>
          <td className={tdCls}><span className={r.type==='inflow'?'text-green-400':'text-red-400'}>{r.type}</span></td>
          <td className={tdCls}>{r.category_id?<span className="text-green-400">{r.category_name}</span>:<span className="text-muted-foreground/50">{r.category_name||'—'}</span>}</td>
          <td className={tdCls}>{r.bank_account_id?<span className="text-green-400">{r.bank_account_name}</span>:<span className="text-muted-foreground/50">{r.bank_account_name||'—'}</span>}</td>
          <td className={tdCls+' text-right font-mono'}>{r.amount?parseFloat(r.amount).toLocaleString('en-IN'):'—'}</td>
          <td className={tdCls}>{r.currency}</td>
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )

    if (mode === 'invoices') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th><th className={thCls}>Invoice #</th>
        <th className={thCls}>Client</th><th className={thCls}>Issue Date</th>
        <th className={thCls+' text-right'}>Subtotal</th><th className={thCls}>Status</th><th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':r.status==='warn'?'bg-yellow-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls+' font-mono text-violet-300'}>{r.invoice_number}</td>
          <td className={tdCls}>{r.client_id?<span className="text-green-400">{r.client_ref}</span>:<span className="text-red-400">{r.client_ref||'missing'}</span>}</td>
          <td className={tdCls+' font-mono'}>{r.issue_date}</td>
          <td className={tdCls+' text-right font-mono'}>{r.subtotal?`₹${parseFloat(r.subtotal).toLocaleString('en-IN')}`:'—'}</td>
          <td className={tdCls}>{r.invoice_status}</td>
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )

    if (mode === 'invoice_status') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th><th className={thCls}>Invoice Ref</th>
        <th className={thCls}>New Status</th><th className={thCls+' text-right'}>Paid Amount</th>
        <th className={thCls}>Payment Date</th><th className={thCls}>Method</th><th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':r.status==='warn'?'bg-yellow-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls}>{r.invoice_id?<span className="text-green-400">{r.invoice_ref}</span>:<span className="text-red-400">{r.invoice_ref||'missing'}</span>}</td>
          <td className={tdCls}>{r.invoice_status}</td>
          <td className={tdCls+' text-right font-mono'}>{r.paid_amount?`₹${parseFloat(r.paid_amount).toLocaleString('en-IN')}`:'—'}</td>
          <td className={tdCls+' font-mono'}>{r.payment_date||'—'}</td>
          <td className={tdCls}>{r.payment_method||'—'}</td>
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )

    if (mode === 'discounts') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th><th className={thCls}>Invoice #</th>
        <th className={thCls}>Client</th><th className={thCls+' text-right'}>Invoice Total</th>
        <th className={thCls+' text-right'}>Discount ₹</th><th className={thCls+' text-right'}>Discount %</th>
        <th className={thCls}>Reason</th><th className={thCls}>Date</th><th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':r.status==='warn'?'bg-yellow-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls+' font-mono text-violet-300'}>{r.invoice_id?<span className="text-green-400">{r.invoice_ref}</span>:<span className="text-red-400">{r.invoice_ref||'—'}</span>}</td>
          <td className={tdCls}>{r.client_id?<span className="text-green-400">{r.client_ref||'✓'}</span>:<span className="text-red-400">{r.client_ref||'—'}</span>}</td>
          <td className={tdCls+' text-right font-mono'}>{r.invoice_total?`₹${parseFloat(r.invoice_total).toLocaleString('en-IN')}`:'—'}</td>
          <td className={tdCls+' text-right font-mono'}>{r.discount_amount?`₹${parseFloat(r.discount_amount).toLocaleString('en-IN')}`:'—'}</td>
          <td className={tdCls+' text-right font-mono'}>{r.discount_percentage?`${r.discount_percentage}%`:'—'}</td>
          <td className={tdCls+' text-muted-foreground max-w-[120px] truncate'}>{r.reason||'—'}</td>
          <td className={tdCls+' font-mono'}>{r.discount_date||'—'}</td>
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )

    // contributions
    const visibleParams = contribSubMode === 'param_detail' ? parameters.slice(0, 6) : []
    return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th><th className={thCls}>Task</th>
        <th className={thCls}>Date</th><th className={thCls}>CQID</th>
        {contribSubMode === 'earnings_only' && <th className={thCls+' text-right'}>Earnings</th>}
        {contribSubMode === 'score_pct' && <><th className={thCls+' text-right'}>Score %</th><th className={thCls+' text-right'}>Earnings</th></>}
        {contribSubMode === 'param_detail' && visibleParams.map(p => <th key={p.id} className={thCls+' text-right max-w-[70px] truncate'} title={p.name}>{p.name.length > 8 ? p.name.slice(0, 7)+'…' : p.name}</th>)}
        <th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':r.status==='warn'?'bg-yellow-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls}>{r.task_id?<span className="text-green-400 truncate block max-w-[120px]">{r.task_ref || r.task_id_direct}</span>:<span className={r.task_ref?'text-yellow-400':'text-red-400'}>{r.task_ref||'—'}</span>}</td>
          <td className={tdCls+' font-mono'}>{r.task_date}</td>
          <td className={tdCls}>{r.employee_id?<span className="text-green-400">{r.employee_cqid}</span>:<span className="text-red-400">{r.employee_cqid||'—'}</span>}</td>
          {contribSubMode === 'earnings_only' && <td className={tdCls+' text-right font-mono'}>{r.earnings?`₹${parseFloat(r.earnings).toLocaleString('en-IN')}`:'—'}</td>}
          {contribSubMode === 'score_pct' && <><td className={tdCls+' text-right font-mono'}>{r.score_percentage?`${r.score_percentage}%`:'—'}</td><td className={tdCls+' text-right font-mono'}>{r.earnings?`₹${parseFloat(r.earnings).toLocaleString('en-IN')}`:'—'}</td></>}
          {contribSubMode === 'param_detail' && visibleParams.map(p => <td key={p.id} className={tdCls+' text-right font-mono text-[10px]'}>{(r._paramValues as any)?.[p.id] || '—'}</td>)}
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )
  }

  // ── Reference panel ────────────────────────────────────────────────────────
  function renderReference() {
    const items: { label: string; values: string[] }[] = []
    if (['jobs', 'contributions', 'pricing_matrix'].includes(mode)) {
      items.push({ label: `Clients (${clients.length})`, values: clients.map(c => `${c.code} — ${c.name}`) })
      items.push({ label: `Services (${services.length})`, values: services.map(s => s.name) })
    }
    if (mode === 'contributions' || mode === 'jobs') {
      items.push({ label: `Employee CQIDs (${employees.length})`, values: employees.map(e => e.cqid) })
    }
    if (mode === 'parameters' || mode === 'tools') {
      items.push({ label: `Groups (${groups.length})`, values: groups.map(g => g.name) })
    }
    if (!items.length) return null
    return (
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <p className="text-sm font-semibold">Quick reference</p>
        <div className="grid grid-cols-2 gap-3 text-xs">
          {items.map(({ label, values }) => (
            <div key={label}>
              <p className="text-muted-foreground mb-1">{label}</p>
              <div className="space-y-0.5 max-h-28 overflow-y-auto">
                {values.map((v, i) => <div key={i} className="font-mono text-[11px] text-foreground/70">{v}</div>)}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-5">
      <ToastContainer toasts={toasts} onDismiss={dismiss} />

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Bulk Import</h1>
          <p className="text-sm text-muted-foreground mt-1">Import data or clean up incorrectly added records</p>
        </div>
        {/* Page tab switcher */}
        <div className="flex gap-1 bg-card border border-border rounded-lg p-1 shrink-0">
          <button
            onClick={() => setPageTab('import')}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${pageTab === 'import' ? 'bg-violet-600 text-white shadow' : 'text-muted-foreground hover:text-foreground'}`}
          >
            📥 Import
          </button>
          <button
            onClick={() => { setPageTab('cleanup'); loadCleanupRecords(cleanupMode) }}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${pageTab === 'cleanup' ? 'bg-red-600 text-white shadow' : 'text-muted-foreground hover:text-foreground'}`}
          >
            🗑️ Clean Up
          </button>
        </div>
      </div>

      {/* Mode selector — tiered for import, flat for cleanup */}
      <div className="space-y-3">
        {pageTab === 'import' ? (
          IMPORT_TIERS.map(tier => {
            const tierModes = MODES.filter(m => tier.modes.includes(m.key))
            const tierColors: Record<string, string> = {
              emerald: 'text-emerald-400 border-emerald-500/20 bg-emerald-500/5',
              blue:    'text-blue-400 border-blue-500/20 bg-blue-500/5',
              amber:   'text-amber-400 border-amber-500/20 bg-amber-500/5',
              violet:  'text-violet-400 border-violet-500/20 bg-violet-500/5',
            }
            const activeColor: Record<string, string> = {
              emerald: 'bg-emerald-600',
              blue:    'bg-blue-600',
              amber:   'bg-amber-600',
              violet:  'bg-violet-600',
            }
            return (
              <div key={tier.tier} className={`rounded-xl border p-3 space-y-2 ${tierColors[tier.color]}`}>
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-current/10 ${tierColors[tier.color].split(' ')[0]}`}>
                    Tier {tier.tier}
                  </span>
                  <span className={`text-xs font-semibold ${tierColors[tier.color].split(' ')[0]}`}>{tier.label}</span>
                  <span className="text-[11px] text-muted-foreground/60">— {tier.hint}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {tierModes.map(({ key, label, emoji }) => (
                    <button
                      key={key}
                      onClick={() => { setMode(key); reset() }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
                        mode === key
                          ? `${activeColor[tier.color]} text-white shadow`
                          : 'bg-background border border-border text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <span>{emoji}</span><span>{label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )
          })
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {MODES.map(({ key, label, emoji }) => (
              <button
                key={key}
                onClick={() => { setCleanupMode(key); loadCleanupRecords(key) }}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
                  cleanupMode === key
                    ? 'bg-red-600 text-white shadow'
                    : 'bg-card border border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                <span>{emoji}</span><span>{label}</span>
              </button>
            ))}
          </div>
        )}
        {pageTab === 'cleanup' && (
          <p className="text-[11px] text-red-400">⚠️ Deletion is permanent and cannot be undone. Select records carefully before deleting.</p>
        )}
      </div>

      {/* ── CLEAN UP ────────────────────────────────────────────────────────── */}
      {pageTab === 'cleanup' && (
        <div className="space-y-3">
          {/* Toolbar */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm font-semibold text-muted-foreground">
              {cleanupLoading ? 'Loading…' : `${cleanupRecords.length} records`}
            </span>
            {selectedIds.size > 0 && (
              <span className="text-[12px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 font-semibold">
                {selectedIds.size} selected
              </span>
            )}
            <div className="flex-1"/>
            <button
              onClick={() => loadCleanupRecords(cleanupMode)}
              disabled={cleanupLoading}
              className="text-xs px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              ↻ Refresh
            </button>
            {selectedIds.size > 0 && (
              <button
                onClick={deleteSelected}
                disabled={deleting}
                className="text-sm px-4 py-2 rounded-lg bg-red-600 text-white font-semibold hover:bg-red-500 disabled:opacity-50 transition-colors flex items-center gap-1.5"
              >
                {deleting ? 'Deleting…' : `🗑️ Delete ${selectedIds.size} selected`}
              </button>
            )}
          </div>

          {/* Table */}
          {cleanupLoading ? (
            <div className="bg-card border border-border rounded-xl p-12 text-center text-muted-foreground text-sm">Loading records…</div>
          ) : cleanupRecords.length === 0 ? (
            <div className="bg-card border border-border rounded-xl p-12 text-center text-muted-foreground text-sm">
              No records found for {MODES.find(m => m.key === cleanupMode)?.label}
            </div>
          ) : (
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <div className="overflow-x-auto overflow-y-auto max-h-[60vh] cursor-pointer">
                {renderCleanupTable()}
              </div>
            </div>
          )}

          {/* Tip */}
          <p className="text-[11px] text-muted-foreground">Click a row or the checkbox to select. Click row again to deselect.</p>
        </div>
      )}

      {/* ── UPLOAD ──────────────────────────────────────────────────────────── */}
      {pageTab === 'import' && step === 'upload' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Drop zone + operation toggle */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              {mode === 'discounts' ? (
                <span className="text-xs text-muted-foreground px-2 py-1 rounded-lg border border-foreground/15 bg-foreground/[0.04]">
                  ↕ Auto upsert by invoice number
                </span>
              ) : (
                <>
                  <span className="text-xs text-muted-foreground">Operation:</span>
                  <div className="flex items-center border border-foreground/15 rounded-lg overflow-hidden h-[30px]">
                    <button onClick={() => setOperation('insert')} className={`px-3 text-xs flex items-center gap-1.5 transition-colors h-full ${operation === 'insert' ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                      + Insert new
                    </button>
                    <button onClick={() => setOperation('update')} className={`px-3 text-xs flex items-center gap-1.5 transition-colors border-l border-foreground/15 h-full ${operation === 'update' ? 'bg-amber-500/15 text-amber-300' : 'text-muted-foreground hover:text-foreground'}`}>
                      ✎ Update existing
                    </button>
                    <button onClick={() => setOperation('delete')} className={`px-3 text-xs flex items-center gap-1.5 transition-colors border-l border-foreground/15 ${operation === 'delete' ? 'bg-red-500/15 text-red-300' : 'text-muted-foreground hover:text-foreground'}`}>
                      🗑 Delete
                    </button>
                  </div>
                  {operation === 'update' && (
                    <span className="text-[10px] text-amber-400/80 ml-2">
                      Requires <code className="font-mono">id</code> column. Auto-backs up before applying.
                    </span>
                  )}
                  {operation === 'delete' && (
                    <span className="text-[10px] text-red-400/80 ml-2">
                      ⚠ Destructive. Requires <code className="font-mono">id</code> column. Backup auto-downloaded before delete. Only the <code className="font-mono">id</code> column is read.
                    </span>
                  )}
                </>
              )}
            </div>
            <div
              onDrop={onDrop} onDragOver={e => e.preventDefault()}
              onClick={() => fileRef.current?.click()}
              className="border-2 border-dashed border-border rounded-xl p-8 flex flex-col items-center justify-center gap-4 text-center cursor-pointer hover:border-violet-500/60 transition-colors bg-card"
            >
              <div className="w-12 h-12 rounded-full bg-violet-500/15 flex items-center justify-center text-2xl">
                {MODES.find(m => m.key === mode)?.emoji}
              </div>
              <div>
                <p className="font-semibold">Drop CSV here or click to browse</p>
                <p className="text-xs text-muted-foreground mt-1">UTF-8 CSV · max 10 000 rows</p>
              </div>
              <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onFileChange} />
            </div>
          </div>

          {/* Template + columns */}
          <div className="space-y-3">
            <div className="bg-card border border-border rounded-xl p-4">
              <p className="text-sm font-semibold mb-2">1. Download the template</p>
              <button
                onClick={() => downloadTemplate(mode)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-violet-600/20 border border-violet-500/30 text-violet-300 text-sm font-medium hover:bg-violet-600/30 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                Download {MODES.find(m => m.key === mode)?.label} Template
              </button>
              {/* Export with optional filters */}
              <div className="mt-3 space-y-2">
                {/* Filter toggle */}
                <button
                  type="button"
                  onClick={() => setExportFilterOpen(o => !o)}
                  className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z"/></svg>
                  {exportFilterOpen ? 'Hide filters' : 'Filter export'}
                  {(() => {
                    const n = [exportFilters.clientId, exportFilters.status, exportFilters.dateFrom, exportFilters.dateTo, exportFilters.isActive, exportFilters.entryType].filter(Boolean).length
                    return n > 0 ? <span className="ml-1 px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-400 text-[10px] font-semibold">{n}</span> : null
                  })()}
                </button>

                {exportFilterOpen && (
                  <div className="bg-foreground/[0.03] border border-border/40 rounded-lg p-3 space-y-2">
                    {/* is_active — employees, clients, services */}
                    {['employees','clients','services'].includes(mode) && (
                      <div>
                        <label className="text-[10px] text-muted-foreground mb-1 block">Status</label>
                        <select value={exportFilters.isActive} onChange={e => setExportFilters(f => ({ ...f, isActive: e.target.value }))}
                          className="w-full text-xs bg-background border border-border rounded-lg px-2 py-1 focus:outline-none focus:border-violet-500/60">
                          <option value="">All</option>
                          <option value="true">Active only</option>
                          <option value="false">Inactive only</option>
                        </select>
                      </div>
                    )}
                    {/* Client — jobs, invoices, invoice_status, discounts, pricing_matrix */}
                    {['jobs','invoices','invoice_status','discounts','pricing_matrix'].includes(mode) && (
                      <div>
                        <label className="text-[10px] text-muted-foreground mb-1 block">Client</label>
                        <select value={exportFilters.clientId} onChange={e => setExportFilters(f => ({ ...f, clientId: e.target.value }))}
                          className="w-full text-xs bg-background border border-border rounded-lg px-2 py-1 focus:outline-none focus:border-violet-500/60">
                          <option value="">All clients</option>
                          {clients.map(c => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
                        </select>
                      </div>
                    )}
                    {/* Status — jobs, invoices, invoice_status */}
                    {['jobs','invoices','invoice_status'].includes(mode) && (
                      <div>
                        <label className="text-[10px] text-muted-foreground mb-1 block">Status</label>
                        <select value={exportFilters.status} onChange={e => setExportFilters(f => ({ ...f, status: e.target.value }))}
                          className="w-full text-xs bg-background border border-border rounded-lg px-2 py-1 focus:outline-none focus:border-violet-500/60">
                          <option value="">All statuses</option>
                          {mode === 'jobs'
                            ? ['pending','in_progress','done','invoiced','cancelled'].map(s => <option key={s} value={s}>{s.replace('_',' ')}</option>)
                            : ['draft','reviewed','sent','partial','paid','overdue','cancelled','bad_debt'].map(s => <option key={s} value={s}>{s}</option>)
                          }
                        </select>
                      </div>
                    )}
                    {/* Entry type — cashbook */}
                    {mode === 'cashbook_entries' && (
                      <div>
                        <label className="text-[10px] text-muted-foreground mb-1 block">Type</label>
                        <select value={exportFilters.entryType} onChange={e => setExportFilters(f => ({ ...f, entryType: e.target.value }))}
                          className="w-full text-xs bg-background border border-border rounded-lg px-2 py-1 focus:outline-none focus:border-violet-500/60">
                          <option value="">All</option>
                          <option value="income">Income</option>
                          <option value="expense">Expense</option>
                        </select>
                      </div>
                    )}
                    {/* Date range — transactional modes */}
                    {['jobs','invoices','invoice_status','cashbook_entries','discounts','contributions'].includes(mode) && (
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[10px] text-muted-foreground mb-1 block">Date from</label>
                          <input type="date" value={exportFilters.dateFrom} onChange={e => setExportFilters(f => ({ ...f, dateFrom: e.target.value }))}
                            className="w-full text-xs bg-background border border-border rounded-lg px-2 py-1 focus:outline-none focus:border-violet-500/60" />
                        </div>
                        <div>
                          <label className="text-[10px] text-muted-foreground mb-1 block">Date to</label>
                          <input type="date" value={exportFilters.dateTo} onChange={e => setExportFilters(f => ({ ...f, dateTo: e.target.value }))}
                            className="w-full text-xs bg-background border border-border rounded-lg px-2 py-1 focus:outline-none focus:border-violet-500/60" />
                        </div>
                      </div>
                    )}
                    {/* Clear filters */}
                    {[exportFilters.clientId, exportFilters.status, exportFilters.dateFrom, exportFilters.dateTo, exportFilters.isActive, exportFilters.entryType].some(Boolean) && (
                      <button type="button" onClick={() => setExportFilters({ clientId: '', status: '', dateFrom: '', dateTo: '', isActive: '', entryType: '' })}
                        className="text-[10px] text-red-400 hover:text-red-300 transition-colors">
                        × Clear filters
                      </button>
                    )}
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => exportCurrentData(mode)}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-foreground/15 text-muted-foreground hover:text-foreground hover:border-foreground/25 transition-colors"
                  title="Download a CSV of current data — use this as a backup or to edit existing rows"
                >
                  <Download className="w-3 h-3" /> Export current data
                </button>
              </div>
            </div>

            <div className="bg-card border border-border rounded-xl p-4">
              <p className="text-sm font-semibold mb-2">Columns</p>
              <table className="w-full text-left">
                <thead><tr className="text-[10px] text-muted-foreground border-b border-border">
                  <th className="pb-1 pr-2">Column</th><th className="pb-1 pr-2 text-center">Req</th><th className="pb-1">Notes</th>
                </tr></thead>
                <tbody>
                  {COLUMNS[mode].map(({ col, req, notes }) => (
                    <tr key={col} className="border-b border-border/30">
                      <td className="py-1 pr-2 font-mono text-[11px] text-violet-300">{col}</td>
                      <td className="py-1 pr-2 text-center text-[11px]">{req ? '✓' : ''}</td>
                      <td className="py-1 text-[11px] text-muted-foreground">{notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Contribution sub-mode selector */}
            {mode === 'contributions' && (
              <div className="bg-card border border-border rounded-xl p-4 space-y-2">
                <p className="text-sm font-semibold">What data do you have?</p>
                {([
                  { key: 'score_pct',     label: 'Score % per employee',   desc: 'You know each employee\'s contribution % and/or earnings per task' },
                  { key: 'earnings_only', label: 'Earnings only',           desc: 'You only know the ₹ amount each employee earned — no score %' },
                  { key: 'param_detail',  label: 'Parameter detail',        desc: 'You have exact values per parameter (Design score, revision counts, etc.)' },
                ] as { key: ContribSubMode; label: string; desc: string }[]).map(({ key, label, desc }) => (
                  <label key={key} className={`flex items-start gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors ${contribSubMode === key ? 'border-violet-500/60 bg-violet-500/10' : 'border-border hover:border-violet-500/30'}`}>
                    <input type="radio" name="contribSubMode" value={key} checked={contribSubMode === key}
                      onChange={() => setContribSubMode(key)} className="mt-0.5 accent-violet-500" />
                    <div>
                      <p className="text-xs font-semibold">{label}</p>
                      <p className="text-[11px] text-muted-foreground">{desc}</p>
                    </div>
                  </label>
                ))}

                {/* Dynamic template download for this sub-mode */}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => {
                      let header = '', example = ''
                      if (contribSubMode === 'earnings_only') {
                        header = 'id,task_id,task_number,task_title,task_date,employee_cqid,earnings_inr'
                        example = ['"","","1042","Social Media Pack Jun","2026-05-01","CQ001","3000"', '"","","1042","Social Media Pack Jun","2026-05-01","CQ002","2000"'].join('\n')
                      } else if (contribSubMode === 'score_pct') {
                        header = 'id,task_id,task_number,task_title,task_date,employee_cqid,score_percentage,earnings_inr'
                        example = ['"","","1042","Social Media Pack Jun","2026-05-01","CQ001","60","3000"', '"","","1042","Social Media Pack Jun","2026-05-01","CQ002","40","2000"'].join('\n')
                      } else {
                        const paramZeros = parameters.map(() => '0').join(',')
                        header = `id,task_id,task_number,task_title,task_date,employee_cqid,${parameters.map(p => p.name).join(',')}`
                        example = `"","","1042","Social Media Pack Jun","2026-05-01","CQ001",${paramZeros}\n"","","1042","Social Media Pack Jun","2026-05-01","CQ002",${paramZeros}`
                      }
                      const blob = new Blob([header + '\n' + example], { type: 'text/csv;charset=utf-8;' })
                      const a = document.createElement('a')
                      a.href = URL.createObjectURL(blob)
                      a.download = `contributions_${contribSubMode}_template.csv`
                      a.click()
                      URL.revokeObjectURL(a.href)
                    }}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-foreground/[0.04] border border-border/40 text-foreground text-xs font-medium hover:bg-foreground/[0.08] transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                    Blank Template
                  </button>
                  <button
                    onClick={generateContribTemplate}
                    disabled={contribTemplateLoading}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-violet-600/20 border border-violet-500/30 text-violet-300 text-xs font-medium hover:bg-violet-600/30 transition-colors disabled:opacity-50"
                  >
                    <Download className="w-3.5 h-3.5" />
                    {contribTemplateLoading ? 'Generating…' : 'Pre-fill with Jobs'}
                  </button>
                </div>

                {contribSubMode === 'param_detail' && (
                  <div className="text-[11px] text-muted-foreground bg-background/40 rounded-lg p-2 space-y-0.5">
                    <p className="font-semibold text-foreground/70">Parameters in template ({parameters.length}):</p>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {groups.map(g => (
                        <span key={g.id} className="text-[10px]">
                          <span className="text-violet-400 font-semibold">{g.name}:</span>{' '}
                          {parameters.filter(p => p.group_id === g.id).map(p => p.name).join(', ')}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {(contribSubMode === 'score_pct' || contribSubMode === 'earnings_only') && (
                  <p className="text-[11px] text-blue-400">💡 <strong>task_id</strong> column: paste the Supabase task ID directly to skip title+date matching. Leave blank to match by title+date.</p>
                )}
              </div>
            )}

            {/* Discount template generator from invoices */}
            {mode === 'discounts' && (
              <div className="bg-card border border-border rounded-xl p-4 space-y-3">
                <div>
                  <p className="text-sm font-semibold">Generate from invoices</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">Filter your invoices and download a pre-filled discount template — just add the discount amount and reason.</p>
                </div>

                {/* Client filter */}
                <div>
                  <label className="text-[11px] text-muted-foreground mb-1 block">Client</label>
                  <select
                    value={discountFilter.clientId}
                    onChange={e => setDiscountFilter(f => ({ ...f, clientId: e.target.value }))}
                    className="w-full text-xs bg-background border border-border rounded-lg px-2 py-1.5 text-foreground focus:outline-none focus:border-violet-500/60"
                  >
                    <option value="">All clients</option>
                    {clients.map(c => (
                      <option key={c.id} value={c.id}>{c.name} ({c.code})</option>
                    ))}
                  </select>
                </div>

                {/* Date range */}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[11px] text-muted-foreground mb-1 block">Issue date from</label>
                    <input
                      type="date"
                      value={discountFilter.dateFrom}
                      onChange={e => setDiscountFilter(f => ({ ...f, dateFrom: e.target.value }))}
                      className="w-full text-xs bg-background border border-border rounded-lg px-2 py-1.5 text-foreground focus:outline-none focus:border-violet-500/60"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-muted-foreground mb-1 block">Issue date to</label>
                    <input
                      type="date"
                      value={discountFilter.dateTo}
                      onChange={e => setDiscountFilter(f => ({ ...f, dateTo: e.target.value }))}
                      className="w-full text-xs bg-background border border-border rounded-lg px-2 py-1.5 text-foreground focus:outline-none focus:border-violet-500/60"
                    />
                  </div>
                </div>

                {/* Status filter */}
                <div>
                  <label className="text-[11px] text-muted-foreground mb-1 block">Status</label>
                  <select
                    value={discountFilter.status}
                    onChange={e => setDiscountFilter(f => ({ ...f, status: e.target.value }))}
                    className="w-full text-xs bg-background border border-border rounded-lg px-2 py-1.5 text-foreground focus:outline-none focus:border-violet-500/60"
                  >
                    <option value="">All statuses</option>
                    {['draft','reviewed','sent','partial','paid','overdue','cancelled','bad_debt'].map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>

                <button
                  type="button"
                  onClick={generateDiscountTemplate}
                  disabled={discountTemplateLoading}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-emerald-600/20 border border-emerald-500/30 text-emerald-300 text-sm font-medium hover:bg-emerald-600/30 transition-colors disabled:opacity-50"
                >
                  <Download className="w-4 h-4" />
                  {discountTemplateLoading ? 'Loading invoices…' : 'Download Pre-filled Template'}
                </button>

                <p className="text-[10px] text-muted-foreground/60">
                  The CSV will have one row per invoice with <code className="font-mono">invoice_number</code>, <code className="font-mono">invoice_total</code>, and <code className="font-mono">client_name_or_code</code> pre-filled. Add <code className="font-mono">discount_amount</code> or <code className="font-mono">discount_percentage</code> and import it back.
                </p>
              </div>
            )}

            {renderReference()}
          </div>
        </div>
      )}

      {/* ── PREVIEW ─────────────────────────────────────────────────────────── */}
      {pageTab === 'import' && step === 'preview' && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm font-semibold">{rows.length} rows parsed</span>
            <span className="text-[12px] px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 font-semibold">{okCount} ready</span>
            {warnCount > 0 && <span className="text-[12px] px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400 font-semibold">{warnCount} warnings</span>}
            {errorCount > 0 && <span className="text-[12px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 font-semibold">{errorCount} errors (skipped)</span>}
            <div className="flex-1"/>
            <button onClick={reset} className="text-xs px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground">
              ← Re-upload
            </button>
            <button
              onClick={runImport}
              disabled={importing || okCount + warnCount === 0}
              className="text-sm px-4 py-2 rounded-lg bg-violet-600 text-white font-semibold hover:bg-violet-500 disabled:opacity-50 transition-colors"
            >
              {importing ? 'Importing…' : `Import ${okCount + warnCount} row${okCount + warnCount !== 1 ? 's' : ''}`}
            </button>
          </div>
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="overflow-x-auto">{renderPreviewTable()}</div>
          </div>
        </div>
      )}

      {/* ── DONE ────────────────────────────────────────────────────────────── */}
      {pageTab === 'import' && step === 'done' && result && (
        <div className="bg-card border border-border rounded-xl p-8 text-center space-y-4 max-w-lg mx-auto">
          <div className={`w-14 h-14 mx-auto rounded-full flex items-center justify-center text-2xl ${result.inserted > 0 ? 'bg-green-500/15' : 'bg-red-500/15'}`}>
            {result.inserted > 0 ? '✅' : '❌'}
          </div>
          <div>
            <p className="text-xl font-bold">{result.inserted} {MODES.find(m => m.key === mode)?.label} {operation === 'update' ? 'updated' : operation === 'delete' ? 'deleted' : 'imported'}</p>
            {result.skipped > 0 && <p className="text-sm text-yellow-400">{result.skipped} rows skipped</p>}
          </div>
          {result.errors.length > 0 && (
            <div className="text-left bg-red-500/10 border border-red-500/30 rounded-lg p-3 space-y-1">
              <p className="text-xs font-semibold text-red-400">Errors:</p>
              {result.errors.map((e, i) => <p key={i} className="text-xs text-red-300">{e}</p>)}
            </div>
          )}
          <div className="flex gap-3 justify-center">
            <button onClick={reset} className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-semibold hover:bg-violet-500 transition-colors">
              Import More
            </button>
            <button onClick={() => { reset(); setMode(mode) }} className="px-4 py-2 rounded-lg border border-border text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors">
              New Type
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

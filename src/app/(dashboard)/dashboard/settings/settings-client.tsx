'use client'

import { useState, useMemo, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Handshake } from 'lucide-react'
import Header from '@/components/layout/header'
import AppSelect from '@/components/ui/app-select'
import { createClient as createSupabaseClient } from '@/lib/supabase/client'
import {
  upsertCompanySettings,
  createEmployee, updateEmployee,
  createClient, updateClient, upsertClientServicePricings, deactivateClient, quickEditClient,
  createService, updateService, deactivateService, quickEditService,
  createGroup, updateGroup, deactivateGroup,
  createParameter, updateParameter, deactivateParameter,
  createTool, updateTool, deactivateTool, quickEditTool,
  createBankAccount, updateBankAccount, deactivateBankAccount,
  createCashbookCategory, updateCashbookCategory, deactivateCashbookCategory,
  upsertExchangeRate,
  syncExchangeRates,
  upsertMatrixCell,
} from './actions'
import { Plus, X, Edit2, Archive, ArchiveRestore, Save, ChevronDown, ChevronLeft, ChevronRight, Lock, Eye, EyeOff, ShieldCheck, Zap, Search, ArrowUpDown, ArrowUp, ArrowDown, AlertTriangle, Link2, Check, KeyRound, CalendarDays, Mail, Send, RotateCcw as ResetKey, RefreshCw } from 'lucide-react'
import type { Currency } from '@/types'
import InfoTip from '@/components/ui/info-tip'
import { usePrivacy, getStoredPin, setStoredPin, isForceLocked } from '@/contexts/privacy-context'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { generateInviteToken, revokeInviteToken, archiveEmployee, restoreEmployee, adminResetPassword, updateEmployeeAvatar } from './employee-actions'
import { RecalcBillingModal } from './recalc-billing-modal'
import { RecalcCommissionsModal } from './recalc-commissions-modal'
import { EmployeeAvatar, AvatarPicker } from '@/components/ui/employee-avatar'
import { PerformanceHistoryModal } from './performance-history-modal'
import { DEFAULT_TEMPLATES, TEMPLATE_KEYS, TEMPLATE_DOCS, templatesFromSettings, type MessageTemplates } from '@/lib/messaging/templates'
import { INTAKE_KINDS, INTAKE_KIND_META } from '@/lib/services/intake'
import { isDesktop, getReceiptSharePref, setReceiptSharePref, RECEIPT_SHARE_LABELS, RECEIPT_SHARE_HINTS, type ReceiptShareAction } from '@/lib/desktop'
import { buildInvoiceShareText } from '@/lib/invoices/share'
import { buildReminderText } from '@/lib/followups/grouping'

// ── Module-level search bar (stable reference — never defined inside a component) ──
function SearchBar({ value, onChange, placeholder = 'Search…', className = '' }: {
  value: string; onChange: (v: string) => void; placeholder?: string; className?: string
}) {
  return (
    <div className={`flex items-center gap-2 bg-secondary border border-border/0 hover:border-border rounded-lg px-2.5 py-1.5 transition-colors focus-within:border-primary/50 ${className}`}>
      <Search className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="bg-transparent text-sm outline-none flex-1 placeholder:text-muted-foreground/40"
      />
      {value && (
        <button type="button" onClick={() => onChange('')} className="text-muted-foreground/50 hover:text-foreground">
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}

const SETTINGS_TABS = [
  'Company', 'Employees', 'Clients', 'Services',
  'Groups & Params', 'Tools', 'Bank Accounts', 'Cash Categories', 'Exchange Rates',
  'Pricing Matrix', 'Privacy & Security', 'Message Templates'
] as const
type SettingsTab = typeof SETTINGS_TABS[number]

// ─── Tab grouping (left rail) ────────────────────────────────────────────────
const SETTINGS_GROUPS: { label: string; emoji: string; tabs: SettingsTab[] }[] = [
  { label: 'Organization',    emoji: '🏢', tabs: ['Company', 'Privacy & Security'] },
  { label: 'People',          emoji: '👥', tabs: ['Employees'] },
  { label: 'Clients & Pricing', emoji: '🤝', tabs: ['Clients', 'Pricing Matrix'] },
  { label: 'Service Catalog', emoji: '📦', tabs: ['Services', 'Groups & Params', 'Tools'] },
  { label: 'Finance',         emoji: '💸', tabs: ['Bank Accounts', 'Cash Categories', 'Exchange Rates'] },
  { label: 'Communication',   emoji: '💬', tabs: ['Message Templates'] },
]

const CURRENCIES: Currency[] = ['AED', 'SAR', 'USD', 'QAR', 'GBP', 'EUR']
const ROLES = ['super_admin', 'accounts', 'team_lead', 'employee', 'view_only']
const SALARY_TYPES = ['fixed', 'commission_only', 'fixed_plus_commission']
const PRICING_TYPES = ['fixed_per_creative', 'percentage_of_spend', 'retainer', 'hourly']

interface Props {
  groups: any[]
  parameters: any[]
  tools: any[]
  services: any[]
  clients: any[]
  employees: any[]
  bankAccounts: any[]
  categories: any[]
  companySettings: any[]
  exchangeRates: any[]
  parameterServices: any[]
  toolServices: any[]
  taskServiceUsage: { service_id: string; created_at: string }[]
  groupServices: { group_id: string; service_id: string }[]
  invoices: { client_id: string; total_amount: number; paid_amount: number; status: string }[]
  designations?: { id: string; name: string; is_admin: boolean; is_system: boolean }[]
  initialTab?: string
  initialEditClientId?: string
  initialEditServiceId?: string
  returnTo?: string
}

export default function SettingsClient(props: Props) {
  const { taskServiceUsage, invoices = [] } = props

  // ── Per-client outstanding amount ───────────────────────────────────────────
  const clientOutstanding = useMemo(() => {
    const map: Record<string, { billed: number; paid: number; outstanding: number }> = {}
    invoices.forEach(inv => {
      if (!inv.client_id) return
      if (!map[inv.client_id]) map[inv.client_id] = { billed: 0, paid: 0, outstanding: 0 }
      map[inv.client_id].billed += inv.total_amount || 0
      map[inv.client_id].paid   += inv.paid_amount  || 0
      map[inv.client_id].outstanding = map[inv.client_id].billed - map[inv.client_id].paid
    })
    return map
  }, [invoices])
  // groupServices: which contribution groups belong to each service
  // Uses localStorage as fallback before the SQL migration is run.
  const [groupServices, setGroupServices] = useState<{ group_id: string; service_id: string }[]>(() => {
    const fromDB = props.groupServices || []
    if (fromDB.length > 0) return fromDB
    try { return JSON.parse(localStorage.getItem('cirqle_group_services') || '[]') } catch { return [] }
  })
  const [tab, setTab] = useState(props.initialTab ?? 'Company')
  const router = useRouter()
  const supabase = createSupabaseClient()
  const { dn, ds, isUnlocked, forceLock, setForceLockMode } = usePrivacy()
  const [forceLockState, setForceLockState] = useState<boolean>(false)
  useEffect(() => { setForceLockState(isForceLocked()) }, [])

  // Auto-open client edit form when arriving from invoice "Edit client" link
  useEffect(() => {
    if (!props.initialEditClientId) return
    const client = props.clients.find((c: any) => c.id === props.initialEditClientId)
    if (client) openClientForm(client)
  // openClientForm is stable across renders; props.clients is the initial value
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-open service edit form when arriving from the "needs pricing" banner.
  useEffect(() => {
    if (!props.initialEditServiceId) return
    const svc = props.services.find((s: any) => s.id === props.initialEditServiceId)
    if (!svc) return
    setEditingId(svc.id)
    setShowForm('service')
    const gids = props.groupServices.filter((gs: any) => gs.service_id === svc.id).map((gs: any) => gs.group_id)
    setForm({ ...svc, _groupIds: gids })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Privacy PIN management ──────────────────────────
  const [pinForm, setPinForm] = useState({ current: '', next: '', confirm: '' })
  const [pinMsg, setPinMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [showPinFields, setShowPinFields] = useState(false)

  function handleSavePin(e: React.FormEvent) {
    e.preventDefault()
    const stored = getStoredPin()
    if (stored && pinForm.current !== stored) { setPinMsg({ type: 'err', text: 'Current PIN is incorrect.' }); return }
    if (pinForm.next.length < 4) { setPinMsg({ type: 'err', text: 'New PIN must be at least 4 characters.' }); return }
    if (pinForm.next !== pinForm.confirm) { setPinMsg({ type: 'err', text: 'PINs do not match.' }); return }
    setStoredPin(pinForm.next)
    setPinForm({ current: '', next: '', confirm: '' })
    setPinMsg({ type: 'ok', text: stored ? 'Privacy PIN updated successfully.' : 'Privacy PIN created successfully.' })
    setShowPinFields(false)
  }

  // Local state for each section
  const [groups, setGroups] = useState(props.groups)

  // is_master and input_type now live in the DB (migration 008).
  // Props already include them; no localStorage merge needed.
  const [params, setParams] = useState<any[]>(props.parameters)
  const [tools, setTools] = useState(props.tools)
  const [services, setServices] = useState(props.services)

  // Sort services by most recently used in tasks, then alphabetically
  const servicesSortedByUsage = useMemo(() => {
    const lastUsed: Record<string, string> = {}
    taskServiceUsage.forEach(t => {
      if (!lastUsed[t.service_id] || t.created_at > lastUsed[t.service_id]) {
        lastUsed[t.service_id] = t.created_at
      }
    })
    return [...services].sort((a: any, b: any) => {
      const aLast = lastUsed[a.id]
      const bLast = lastUsed[b.id]
      if (aLast && bLast) return bLast.localeCompare(aLast)
      if (aLast) return -1
      if (bLast) return 1
      return a.name.localeCompare(b.name)
    })
  }, [services, taskServiceUsage])
  const [clients, setClients] = useState(props.clients)
  const [employees, setEmployees] = useState(props.employees)
  const [bankAccounts, setBankAccounts] = useState(props.bankAccounts)
  const [categories, setCategories] = useState(props.categories)
  const [rates, setRates] = useState(props.exchangeRates)
  const [companySettings, setCompanySettings] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {}
    props.companySettings.forEach(s => { m[s.key] = s.value })
    return m
  })

  // ── Quick Edit ─────────────────────────────────────
  const [quickEdit, setQuickEdit] = useState(false)

  // ── Per-tab search + sort ───────────────────────────
  const [clientSearch, setClientSearch] = useState('')
  const [clientSort, setClientSort] = useState<'name' | 'code'>('name')
  const [serviceSearch, setServiceSearch] = useState('')
  const [serviceSort, setServiceSort] = useState<'name' | 'usage'>('usage')
  const [groupSearch, setGroupSearch] = useState('')
  const [paramSearch, setParamSearch] = useState('')
  const [toolSearch, setToolSearch] = useState('')
  const [matrixClientSearch, setMatrixClientSearch] = useState('')
  const [matrixServiceSearch, setMatrixServiceSearch] = useState('')
  const [empSearch, setEmpSearch] = useState('')
  const [copiedPortalId, setCopiedPortalId] = useState<string | null>(null)
  const [salaryDayCalOpen, setSalaryDayCalOpen] = useState(false)
  const [salaryCalViewDate, setSalaryCalViewDate] = useState(() => new Date())

  const filteredClients = useMemo(() => {
    let list = clients.filter((c: any) => c.is_active !== false)
    if (clientSearch) {
      const q = clientSearch.toLowerCase()
      list = list.filter((c: any) => c.name?.toLowerCase().includes(q) || c.code?.toLowerCase().includes(q) || c.email?.toLowerCase().includes(q))
    }
    list.sort((a: any, b: any) => clientSort === 'code'
      ? (a.code || '').localeCompare(b.code || '')
      : (a.name || '').localeCompare(b.name || ''))
    return list
  }, [clients, clientSearch, clientSort])

  const filteredServices = useMemo(() => {
    let activeServices = services.filter((s: any) => s.is_active !== false)
    let list = serviceSort === 'usage' 
      ? servicesSortedByUsage.filter((s: any) => s.is_active !== false) 
      : activeServices.sort((a: any, b: any) => a.name.localeCompare(b.name))
    if (serviceSearch) {
      const q = serviceSearch.toLowerCase()
      list = list.filter((s: any) => s.name?.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q))
    }
    return list
  }, [services, servicesSortedByUsage, serviceSearch, serviceSort])

  const filteredGroups = useMemo(() => {
    let pool = groups.filter((g: any) => g.is_active !== false)
    if (!groupSearch) return pool
    const q = groupSearch.toLowerCase()
    return pool.filter((g: any) => g.name?.toLowerCase().includes(q))
  }, [groups, groupSearch])

  const filteredParams = useMemo(() => {
    let pool = params.filter((p: any) => p.is_active !== false)
    if (!paramSearch) return pool
    const q = paramSearch.toLowerCase()
    return pool.filter((p: any) => p.name?.toLowerCase().includes(q))
  }, [params, paramSearch])

  const filteredTools = useMemo(() => {
    let pool = tools.filter((t: any) => t.is_active !== false)
    if (!toolSearch) return pool
    const q = toolSearch.toLowerCase()
    return pool.filter((t: any) => t.name?.toLowerCase().includes(q))
  }, [tools, toolSearch])

  // Employee filter tabs: active | archived | all
  const [empFilter, setEmpFilter] = useState<'active' | 'archived' | 'all'>('active')

  const filteredEmployees = useMemo(() => {
    let pool = employees
    if (empFilter === 'active')   pool = pool.filter((e: any) => !e.is_archived)
    if (empFilter === 'archived') pool = pool.filter((e: any) =>  e.is_archived)
    if (!empSearch) return pool
    const q = empSearch.toLowerCase()
    return pool.filter((e: any) => e.cqid?.toLowerCase().includes(q) || e.name?.toLowerCase().includes(q) || e.role?.toLowerCase().includes(q))
  }, [employees, empSearch, empFilter])

  // Invite link modal state
  const [inviteLink, setInviteLink] = useState<{ employeeId: string; cqid: string; url: string; expiresAt: string } | null>(null)
  const [inviteCopied, setInviteCopied] = useState(false)
  const [inviteBusy, setInviteBusy] = useState<string | null>(null)
  const [resetPwdModal, setResetPwdModal] = useState<{ cqid: string; tempPassword: string } | null>(null)
  const [avatarModal, setAvatarModal] = useState<{ id: string; cqid: string; name: string | null; currentUrl: string | null } | null>(null)
  const [avatarPickerValue, setAvatarPickerValue] = useState<string | null>(null)
  const [avatarSaving, setAvatarSaving] = useState(false)
  const [showHistoryModal, setShowHistoryModal] = useState<any | null>(null)
  const [showRecalcCommissions, setShowRecalcCommissions] = useState(false)

  async function handleGenerateInvite(emp: any) {
    setInviteBusy(emp.id)
    const res = await generateInviteToken(emp.id)
    setInviteBusy(null)
    if (!res.ok || !res.data) { alert(res.error || 'Failed to generate invite'); return }
    setInviteLink({ employeeId: emp.id, cqid: emp.cqid, url: res.data.url, expiresAt: res.data.expiresAt })
    setInviteCopied(false)
    // patch local state
    setEmployees(prev => prev.map((x: any) => x.id === emp.id ? { ...x, invite_token: res.data!.token, invite_token_expires_at: res.data!.expiresAt } : x))
  }

  async function handleArchive(emp: any) {
    if (!confirm(`Archive ${emp.cqid}? They will be unable to log in. You can restore them anytime.`)) return
    setInviteBusy(emp.id)
    const res = await archiveEmployee(emp.id)
    setInviteBusy(null)
    if (!res.ok) { alert(res.error || 'Failed to archive'); return }
    setEmployees(prev => prev.map((x: any) => x.id === emp.id ? { ...x, is_archived: true, is_active: false } : x))
  }

  async function handleRestore(emp: any) {
    setInviteBusy(emp.id)
    const res = await restoreEmployee(emp.id)
    setInviteBusy(null)
    if (!res.ok) { alert(res.error || 'Failed to restore'); return }
    setEmployees(prev => prev.map((x: any) => x.id === emp.id ? { ...x, is_archived: false, is_active: true } : x))
  }

  async function handleAdminResetPassword(emp: any) {
    if (!confirm(`Reset password for ${emp.cqid}? A new temporary password will be generated and shown to you.`)) return
    setInviteBusy(emp.id)
    const res = await adminResetPassword(emp.id)
    setInviteBusy(null)
    if (!res.ok || !res.data) { alert(res.error || 'Failed'); return }
    setResetPwdModal({ cqid: emp.cqid, tempPassword: res.data.tempPassword })
  }

  /** Save a single field via a server action and patch the local state array */
  async function qeSave<T extends { id: string }>(
    action: (id: string, field: string, value: unknown) => Promise<{ ok: boolean; error?: string }>,
    id: string,
    field: string,
    rawValue: string,
    setter: React.Dispatch<React.SetStateAction<T[]>>,
    transform: (v: string) => any = v => v,
  ) {
    const value = transform(rawValue)
    await action(id, field, value)
    setter(prev => prev.map(row => row.id === id ? { ...row, [field]: value } : row))
  }

  // Delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: string; id: string; name: string } | null>(null)
  const pendingDeleteRef = useRef<(() => void) | null>(null)
  function requestDelete(type: string, id: string, name: string, action: () => void) {
    pendingDeleteRef.current = action
    setDeleteConfirm({ type, id, name })
  }
  function confirmDelete() {
    pendingDeleteRef.current?.()
    pendingDeleteRef.current = null
  }

  // Pricing matrix collapse
  const [showAllPricingClients, setShowAllPricingClients] = useState(false)

  // Forms
  const [showForm, setShowForm] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Generic form state
  const [form, setForm] = useState<Record<string, any>>({})
  // Client service pricing: serviceId -> { price, commission_percentage, currency }
  const [clientPricings, setClientPricings] = useState<Record<string, { price: string; commission_percentage: string; currency: string }>>({})
  const [selectedClientServices, setSelectedClientServices] = useState<Set<string>>(new Set())
  const [clientFormServiceSearch, setClientFormServiceSearch] = useState('')

  // Pricing matrix: `clientId::serviceId` -> { price, commission_percentage, currency }
  type MatrixCell = { price: string; commission_percentage: string; currency: string }
  const [matrix, setMatrix] = useState<Record<string, MatrixCell>>(() => {
    const m: Record<string, MatrixCell> = {}
    props.clients.forEach((c: any) => {
      c.service_pricings?.forEach((p: any) => {
        m[`${c.id}::${p.service_id}`] = {
          price: p.price != null ? String(p.price) : '',
          commission_percentage: p.commission_percentage != null ? String(p.commission_percentage) : '',
          currency: p.currency || c.default_currency || 'INR',
        }
      })
    })
    return m
  })
  const [matrixSaving, setMatrixSaving] = useState<string | null>(null)

  // Recalculate-task-billing modal (one-off maintenance action — hidden behind a button)
  const [showRecalcModal, setShowRecalcModal] = useState(false)
  // Flatten the matrix into the array shape the modal expects
  const clientPricingsArray = useMemo(() => {
    return Object.entries(matrix).flatMap(([key, cell]) => {
      const [client_id, service_id] = key.split('::')
      if (!client_id || !service_id) return []
      const priceNum = cell.price === '' ? null : parseFloat(cell.price)
      return [{
        client_id,
        service_id,
        price: priceNum,
        percentage_rate: null,  // matrix UI doesn't expose percentage_rate yet; modal falls back to default
        currency: cell.currency,
      }]
    })
  }, [matrix])

  async function saveMatrixCell(clientId: string, serviceId: string, cell: MatrixCell) {
    const key = `${clientId}::${serviceId}`
    setMatrixSaving(key)
    await upsertMatrixCell(
      clientId,
      serviceId,
      parseFloat(cell.price) || 0,
      parseFloat(cell.commission_percentage) || 0,
      cell.currency || 'INR',
    )
    setMatrixSaving(null)
    setClients(prev => prev.map(c => c.id === clientId ? { ...c, pricing_pending: false } : c))
    setServices(prev => prev.map(s => s.id === serviceId ? { ...s, pricing_pending: false } : s))
  }

  function updateMatrix(clientId: string, serviceId: string, field: keyof MatrixCell, value: string) {
    const key = `${clientId}::${serviceId}`
    setMatrix(prev => ({ ...prev, [key]: { ...((prev[key]) || { price: '', commission_percentage: '', currency: 'INR' }), [field]: value } }))
  }

  function openForm(type: string, defaults: Record<string, any> = {}) {
    setShowForm(type)
    setForm(defaults)
    setEditingId(null)
  }

  async function openEmployeeForm(emp?: any) {
    let cqid = ''
    if (!emp) {
      const { data } = await supabase.from('employees').select('cqid').order('cqid', { ascending: false }).limit(1)
      const last = data?.[0]?.cqid || 'CQID000'
      const num = parseInt(last.replace(/\D/g, '')) || 0
      cqid = `CQID${String(num + 1).padStart(3, '0')}`
    }
    setShowForm('employee')
    setForm(emp ? emp : { role: 'employee', salary_type: 'fixed', base_salary: 0, performance_rating: 70, is_active: true, reveal_salary: false, cqid })
    setEditingId(emp?.id || null)
  }

  async function openClientForm(client?: any) {
    let code = ''
    if (!client) {
      const { data } = await supabase.from('clients').select('code').order('code', { ascending: false }).limit(1)
      const last = data?.[0]?.code || '000'
      const num = parseInt(last) || 0
      code = String(num + 1).padStart(3, '0')
    }
    // Load existing pricings if editing
    const pricings: Record<string, { price: string; commission_percentage: string; currency: string }> = {}
    if (client) {
      const { data } = await supabase.from('client_service_pricing').select('*').eq('client_id', client.id)
      data?.forEach((p: any) => {
        pricings[p.service_id] = { price: String(p.price || ''), commission_percentage: String(p.commission_percentage || ''), currency: p.currency || client?.default_currency || 'INR' }
      })
    }
    setClientPricings(pricings)
    setSelectedClientServices(new Set(Object.keys(pricings)))
    setServiceSearch('')
    setShowForm('client')
    setForm(client ? { ...client } : { is_active: true, code, country: 'India', default_currency: 'INR' })
    setEditingId(client?.id || null)
  }

  async function saveCompanySettings() {
    setSaving(true)
    const entries = Object.entries(companySettings).map(([key, value]) => ({ key, value }))
    const res = await upsertCompanySettings(entries)
    setSaving(false)
    if (!res.ok) { alert(res.error || 'Failed to save'); return }
    alert('Saved!')
  }

  // --- Employees ---
  async function saveEmployee(e: React.FormEvent) {
    e.preventDefault(); setSaving(true)
    let res: Awaited<ReturnType<typeof createEmployee>>
    if (editingId) {
      res = await updateEmployee(editingId, form)
      if (res.ok && res.data) setEmployees(prev => prev.map(emp => emp.id === editingId ? res.data : emp))
    } else {
      res = await createEmployee(form)
      if (res.ok && res.data) setEmployees(prev => [...prev, res.data])
    }
    setSaving(false)
    if (!res.ok) { alert(res.error || 'Failed to save employee'); return }
    setShowForm(null)
  }

  function closeForm() {
    setShowForm(null)
    if (props.returnTo) router.push(props.returnTo)
  }

  // --- Clients ---
  async function saveClient(e: React.FormEvent) {
    e.preventDefault(); setSaving(true)
    let clientId = editingId
    let res: Awaited<ReturnType<typeof createClient>>
    if (editingId) {
      res = await updateClient(editingId, form)
      if (res.ok && res.data) setClients(prev => prev.map(c => c.id === editingId ? { ...res.data, service_pricings: c.service_pricings } : c))
    } else {
      res = await createClient(form)
      if (res.ok && res.data) { clientId = res.data.id; setClients(prev => [...prev, { ...res.data, service_pricings: [] }]) }
    }
    if (!res.ok) { setSaving(false); alert(res.error || 'Failed to save client'); return }
    // Save service pricings
    if (clientId) {
      const pricingRows = Object.entries(clientPricings)
        .filter(([, v]) => v.price !== '' || v.commission_percentage !== '')
        .map(([service_id, v]) => ({
          client_id: clientId!,
          service_id,
          price: parseFloat(v.price) || 0,
          commission_percentage: parseFloat(v.commission_percentage) || 0,
          currency: v.currency || 'INR',
          is_active: true as const,
        }))
      if (pricingRows.length > 0) {
        await upsertClientServicePricings(pricingRows)
        const sIds = pricingRows.map(r => r.service_id)
        setServices(prev => prev.map(s => sIds.includes(s.id) ? { ...s, pricing_pending: false } : s))
      }
    }
    setSaving(false)
    closeForm()
  }

  // --- Services ---
  async function saveService(e: React.FormEvent) {
    e.preventDefault(); setSaving(true)

    // Strip internal _groupIds from the DB payload
    const { _groupIds, ...servicePayload } = form
    const selectedGroupIds: string[] = _groupIds || []

    let res: Awaited<ReturnType<typeof createService>>
    if (editingId) {
      res = await updateService(editingId, servicePayload, selectedGroupIds)
      if (res.ok && res.data?.service) setServices(prev => prev.map(s => s.id === editingId ? res.data!.service : s))
    } else {
      res = await createService(servicePayload, selectedGroupIds)
      if (res.ok && res.data?.service) setServices(prev => [...prev, res.data!.service])
    }

    if (!res.ok) { setSaving(false); alert(res.error || 'Failed to save service'); return }

    const serviceId = editingId || res.data?.service?.id
    if (serviceId) {
      // Update local group-service state
      setGroupServices(prev => [
        ...prev.filter(gs => gs.service_id !== serviceId),
        ...selectedGroupIds.map(gid => ({ group_id: gid, service_id: serviceId }))
      ])
      // Always persist to localStorage as fallback (for pre-migration installs)
      try {
        const updated = [
          ...groupServices.filter(gs => gs.service_id !== serviceId),
          ...selectedGroupIds.map(gid => ({ group_id: gid, service_id: serviceId }))
        ]
        localStorage.setItem('cirqle_group_services', JSON.stringify(updated))
      } catch {}
    }

    setSaving(false); closeForm()
  }

  // --- Groups ---
  async function saveGroup(e: React.FormEvent) {
    e.preventDefault(); setSaving(true)
    let res: Awaited<ReturnType<typeof createGroup>>
    if (editingId) {
      res = await updateGroup(editingId, form)
      if (res.ok && res.data) setGroups(prev => prev.map(g => g.id === editingId ? res.data : g))
    } else {
      res = await createGroup(form)
      if (res.ok && res.data) setGroups(prev => [...prev, res.data])
    }
    setSaving(false)
    if (!res.ok) { alert(res.error || 'Failed to save group'); return }
    setShowForm(null)
  }

  // --- Parameters ---
  async function saveParam(e: React.FormEvent) {
    e.preventDefault(); setSaving(true)

    // is_master and input_type live in DB since migration 008 — include directly.
    const payload = {
      ...form,
      is_master:  form.is_master  ?? false,
      input_type: form.input_type ?? 'count',
    }

    let res: Awaited<ReturnType<typeof createParameter>>
    if (editingId) {
      res = await updateParameter(editingId, payload, payload)
      if (res.ok) {
        setParams(prev => prev.map(p => p.id === editingId ? { ...(res.data ?? p), ...payload } : p))
      }
    } else {
      res = await createParameter(payload, payload)
      if (res.ok && res.data) setParams(prev => [...prev, res.data])
    }

    setSaving(false)
    if (!res.ok) { alert(res.error || 'Failed to save parameter'); return }
    setShowForm(null)
  }

  // --- Tools ---
  async function saveTool(e: React.FormEvent) {
    e.preventDefault(); setSaving(true)
    let res: Awaited<ReturnType<typeof createTool>>
    if (editingId) {
      res = await updateTool(editingId, form)
      if (res.ok && res.data) setTools(prev => prev.map(t => t.id === editingId ? res.data : t))
    } else {
      res = await createTool(form)
      if (res.ok && res.data) setTools(prev => [...prev, res.data])
    }
    setSaving(false)
    if (!res.ok) { alert(res.error || 'Failed to save tool'); return }
    setShowForm(null)
  }

  // --- Bank accounts ---
  async function saveBank(e: React.FormEvent) {
    e.preventDefault(); setSaving(true)
    let res: Awaited<ReturnType<typeof createBankAccount>>
    if (editingId) {
      res = await updateBankAccount(editingId, form)
      if (res.ok && res.data) setBankAccounts(prev => prev.map(b => b.id === editingId ? res.data : b))
    } else {
      res = await createBankAccount(form)
      if (res.ok && res.data) setBankAccounts(prev => [...prev, res.data])
    }
    setSaving(false)
    if (!res.ok) { alert(res.error || 'Failed to save bank account'); return }
    setShowForm(null)
  }

  // --- Cash Categories ---
  async function saveCategory(e: React.FormEvent) {
    e.preventDefault(); setSaving(true)
    let res: Awaited<ReturnType<typeof createCashbookCategory>>
    if (editingId) {
      res = await updateCashbookCategory(editingId, form)
      if (res.ok && res.data) setCategories((prev: any[]) => prev.map(c => c.id === editingId ? res.data : c))
    } else {
      res = await createCashbookCategory(form)
      if (res.ok && res.data) setCategories((prev: any[]) => [...prev, res.data])
    }
    setSaving(false)
    if (!res.ok) { alert(res.error || 'Failed to save category'); return }
    setShowForm(null)
  }

  // --- Exchange rates ---
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')

  async function reloadRates() {
    const supabase = createSupabaseClient()
    const { data } = await supabase.from('exchange_rates').select('*')
    if (data) setRates(data)
  }

  async function saveRate(currency: Currency, rate: number) {
    const res = await upsertExchangeRate(currency, rate)
    if (!res.ok) return
    const today = new Date().toISOString().slice(0, 10)
    setRates(prev => {
      const existing = prev.find(r => r.currency === currency)
      if (existing) return prev.map(r => r.currency === currency
        ? { ...r, rate_to_inr: rate, rate_source: 'manual', rate_date: today }
        : r)
      return [...prev, { currency, rate_to_inr: rate, rate_source: 'manual', rate_date: today }]
    })
  }

  async function handleSyncRates() {
    setSyncing(true); setSyncMsg('')
    const res = await syncExchangeRates()
    if (!res.ok) { setSyncMsg(res.error || 'Sync failed'); setSyncing(false); return }
    await reloadRates()
    setSyncMsg(`Updated ${res.data?.updated ?? 0} rate(s)${res.data?.rateDate ? ` · ${res.data.rateDate}` : ''}`)
    setSyncing(false)
  }

  async function saveSetting(key: string, value: string) {
    setCompanySettings(p => ({ ...p, [key]: value }))
    await upsertCompanySettings([{ key, value }])
  }

  return (
    <div>
      <Header title="Settings" subtitle="Configure your Cirqle workspace" />

      {/* On mobile this stacks: section picker → content (full width).
          On md+ it's the original 2-column layout with a left sidebar. */}
      <div className="md:flex md:h-[calc(100dvh-73px)]">
        {/* ── Section picker — MOBILE ONLY ──
            A native <select> with <optgroup> so users can jump to any
            settings section without the left nav eating ~half the screen. */}
        <div className="md:hidden border-b border-border bg-sidebar/40 px-4 py-2.5 sticky top-[68px] z-10 backdrop-blur-sm">
          <label className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1">Section</label>
          <select
            value={tab}
            onChange={e => {
              const t = e.target.value as SettingsTab
              setTab(t); setQuickEdit(false)
              window.history.replaceState(null, '', `?tab=${t.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`)
            }}
            className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            {SETTINGS_GROUPS.map(group => (
              <optgroup key={group.label} label={`${group.emoji}  ${group.label}`}>
                {group.tabs.map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <a
            href="/dashboard/settings/designations"
            className="mt-2 flex items-center justify-between text-xs text-muted-foreground hover:text-foreground bg-secondary/60 rounded-lg px-3 py-1.5 border border-border"
          >
            <span>🔐  Access & Roles</span>
            <svg className="w-3 h-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
            </svg>
          </a>
        </div>

        {/* ── Settings sidebar — DESKTOP ONLY (md+) ── */}
        <div className="hidden md:block w-52 border-r border-border bg-sidebar/50 py-4 px-2 shrink-0 overflow-y-auto">
          {SETTINGS_GROUPS.map((group, gIdx) => (
            <div key={group.label} className={gIdx > 0 ? 'mt-4' : ''}>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40 px-3 mb-1.5 flex items-center gap-1.5">
                <span>{group.emoji}</span>
                <span>{group.label}</span>
              </p>
              <div className="space-y-0.5">
                {group.tabs.map(t => (
                  <button key={t} onClick={() => { setTab(t); setQuickEdit(false); window.history.replaceState(null, '', `?tab=${t.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`) }}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${tab === t ? 'bg-primary/15 text-primary font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'}`}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
          ))}

          {/* Access & Roles — link to designations page */}
          <div className="mt-4">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40 px-3 mb-1.5 flex items-center gap-1.5">
              <span>🔐</span>
              <span>Team Access</span>
            </p>
            <a
              href="/dashboard/settings/designations"
              className="flex items-center justify-between w-full text-left px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors group"
            >
              <span>Access & Roles</span>
              <svg className="w-3 h-3 opacity-40 group-hover:opacity-70 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
              </svg>
            </a>
          </div>
        </div>

        {/* Settings content — full width on mobile, flex-1 next to sidebar on md+ */}
        <div className="flex-1 overflow-y-auto p-4 md:p-6">

          {/* Company */}
          {tab === 'Company' && (
            <div className="max-w-lg space-y-6">

              {/* Basic Info */}
              <div className="space-y-4">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Company Info</h2>
                {[
                  { key: 'company_name', label: 'Company Name' },
                  { key: 'company_email', label: 'Email' },
                  { key: 'company_phone', label: 'Phone' },
                  { key: 'company_address', label: 'Address' },
                  { key: 'company_website', label: 'Website' },
                ].map(({ key, label }) => (
                  <div key={key}>
                    <label className="block text-xs font-medium text-muted-foreground mb-1.5">{label}</label>
                    <input
                      value={companySettings[key] || ''}
                      onChange={e => setCompanySettings(p => ({ ...p, [key]: e.target.value }))}
                      className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                  </div>
                ))}

                {/* Payslip from address — separate field with hint */}
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Payslip Sending Email</label>
                  <input
                    type="email"
                    value={companySettings['payslip_from_email'] || ''}
                    onChange={e => setCompanySettings(p => ({ ...p, payslip_from_email: e.target.value }))}
                    placeholder="e.g. payslip@cirqle.work or Cirqle Payroll <payslip@cirqle.work>"
                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <p className="text-xs text-muted-foreground mt-1">Address used as the From field when sending payslips. Must be a domain verified in Resend.</p>
                </div>
              </div>

              {/* Branding */}
              <div className="space-y-4 border-t border-border pt-5">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Branding</h2>
                {/* Logo row — light (default) + dark variant side by side */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Light-mode logo (logo_url) — the primary / current logo */}
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                      Company Logo
                      <span className="ml-1.5 text-[10px] text-muted-foreground/50 font-normal">Light mode · default</span>
                    </label>
                    <div className="flex gap-2 items-center mb-2">
                      <label className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-muted-foreground hover:text-foreground hover:border-border/80 cursor-pointer transition-colors">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                        Upload logo
                        <input
                          type="file" accept="image/*" className="hidden"
                          onChange={e => {
                            const file = e.target.files?.[0]
                            if (!file) return
                            const reader = new FileReader()
                            reader.onload = ev => setCompanySettings(p => ({ ...p, logo_url: ev.target?.result as string }))
                            reader.readAsDataURL(file)
                          }}
                        />
                      </label>
                      <span className="text-xs text-muted-foreground/50">or URL</span>
                    </div>
                    <input
                      value={companySettings['logo_url'] || ''}
                      onChange={e => setCompanySettings(p => ({ ...p, logo_url: e.target.value }))}
                      placeholder="https://…"
                      className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                    {companySettings['logo_url'] && (
                      <div className="mt-2 flex items-center gap-2">
                        {/* Preview on white — this is the light-mode logo */}
                        <img src={companySettings['logo_url']} alt="Light logo preview" className="h-10 object-contain rounded-lg border border-border bg-white p-1.5" />
                        <button type="button" onClick={() => setCompanySettings(p => ({ ...p, logo_url: '' }))}
                          className="text-xs text-red-400 hover:text-red-300 transition-colors">Remove</button>
                      </div>
                    )}
                  </div>

                  {/* Dark-mode logo (logo_url_dark) — optional separate version */}
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                      Company Logo
                      <span className="ml-1.5 text-[10px] text-muted-foreground/50 font-normal">Dark mode · optional</span>
                    </label>
                    <div className="flex gap-2 items-center mb-2">
                      <label className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-muted-foreground hover:text-foreground hover:border-border/80 cursor-pointer transition-colors">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                        Upload dark logo
                        <input
                          type="file" accept="image/*" className="hidden"
                          onChange={e => {
                            const file = e.target.files?.[0]
                            if (!file) return
                            const reader = new FileReader()
                            reader.onload = ev => setCompanySettings(p => ({ ...p, logo_url_dark: ev.target?.result as string }))
                            reader.readAsDataURL(file)
                          }}
                        />
                      </label>
                      <span className="text-xs text-muted-foreground/50">or URL</span>
                    </div>
                    <input
                      value={companySettings['logo_url_dark'] || ''}
                      onChange={e => setCompanySettings(p => ({ ...p, logo_url_dark: e.target.value }))}
                      placeholder="https://… (leave empty to use light logo in dark mode)"
                      className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                    {companySettings['logo_url_dark'] ? (
                      <div className="mt-2 flex items-center gap-2">
                        {/* Preview on dark bg — this is the dark-mode logo */}
                        <img src={companySettings['logo_url_dark']} alt="Dark logo preview" className="h-10 object-contain rounded-lg border border-border bg-[#0b1120] p-1.5" />
                        <button type="button" onClick={() => setCompanySettings(p => ({ ...p, logo_url_dark: '' }))}
                          className="text-xs text-red-400 hover:text-red-300 transition-colors">Remove</button>
                      </div>
                    ) : (
                      <p className="mt-1.5 text-[11px] text-muted-foreground/50">
                        Not set — light logo used in both modes
                      </p>
                    )}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Tagline</label>
                  <input
                    value={companySettings['company_tagline'] || ''}
                    onChange={e => setCompanySettings(p => ({ ...p, company_tagline: e.target.value }))}
                    placeholder="e.g. Creative by design"
                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>

                {/* Favicon */}
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">App Favicon</label>
                  <p className="text-[11px] text-muted-foreground/60 mb-2">Shown in browser tabs. Best as a square PNG/SVG, 32×32 or 64×64 px.</p>
                  <div className="flex gap-2 items-center mb-2">
                    <label className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-muted-foreground hover:text-foreground hover:border-border/80 cursor-pointer transition-colors">
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                      Upload favicon
                      <input type="file" accept="image/*,.svg,.ico" className="hidden"
                        onChange={e => {
                          const file = e.target.files?.[0]
                          if (!file) return
                          const reader = new FileReader()
                          reader.onload = ev => setCompanySettings(p => ({ ...p, favicon_url: ev.target?.result as string }))
                          reader.readAsDataURL(file)
                        }}
                      />
                    </label>
                    <span className="text-xs text-muted-foreground/50">or paste a URL below</span>
                  </div>
                  <input
                    value={companySettings['favicon_url'] || ''}
                    onChange={e => setCompanySettings(p => ({ ...p, favicon_url: e.target.value }))}
                    placeholder="https://… or leave blank to use default Cirqle icon"
                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  {companySettings['favicon_url'] && (
                    <div className="mt-2 flex items-center gap-2">
                      <div className="w-8 h-8 rounded border border-border bg-secondary p-0.5 flex items-center justify-center overflow-hidden">
                        <img src={companySettings['favicon_url']} alt="Favicon preview" className="w-full h-full object-contain" />
                      </div>
                      <span className="text-xs text-muted-foreground">Preview (32×32)</span>
                      <button type="button" onClick={() => setCompanySettings(p => ({ ...p, favicon_url: '' }))}
                        className="text-xs text-red-400 hover:text-red-300 ml-2 transition-colors">Remove</button>
                    </div>
                  )}
                </div>
              </div>

              {/* Invoicing */}
              <div className="space-y-4 border-t border-border pt-5">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Invoicing</h2>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1.5">Default Currency</label>
                    <input value={companySettings['default_currency'] || ''} onChange={e => setCompanySettings(p => ({ ...p, default_currency: e.target.value }))} className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" placeholder="INR" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1.5">Invoice Prefix</label>
                    <input value={companySettings['invoice_prefix'] || ''} onChange={e => setCompanySettings(p => ({ ...p, invoice_prefix: e.target.value }))} className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" placeholder="INV" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1.5">Quotation Prefix</label>
                    <input value={companySettings['quotation_prefix'] || ''} onChange={e => setCompanySettings(p => ({ ...p, quotation_prefix: e.target.value }))} className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" placeholder="QUO" />
                  </div>
                </div>
              </div>

              {/* Payment / Banking */}
              <div className="space-y-4 border-t border-border pt-5">
                <div>
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Payment Details</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">Shown on printed invoices under "Payment Information"</p>
                </div>
                {[
                  { key: 'bank_holder',  label: 'A/C Holder Name',  placeholder: 'e.g. Farooq Ahmed' },
                  { key: 'bank_account', label: 'Account Number',    placeholder: '1234567890' },
                  { key: 'bank_ifsc',    label: 'IFSC Code',         placeholder: 'e.g. SBIN0001234' },
                  { key: 'bank_upi',     label: 'UPI ID',            placeholder: 'e.g. cirqle@upi' },
                ].map(({ key, label, placeholder }) => (
                  <div key={key}>
                    <label className="block text-xs font-medium text-muted-foreground mb-1.5">{label}</label>
                    <input
                      value={companySettings[key] || ''}
                      onChange={e => setCompanySettings(p => ({ ...p, [key]: e.target.value }))}
                      placeholder={placeholder}
                      className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                  </div>
                ))}
                
                {/* Custom QR Code Upload */}
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Custom UPI QR Code <span className="ml-1.5 text-[10px] text-muted-foreground/50 font-normal">(Optional)</span>
                  </label>
                  <div className="flex gap-2 items-center mb-2">
                    <label className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-muted-foreground hover:text-foreground hover:border-border/80 cursor-pointer transition-colors">
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                      Upload custom QR
                      <input
                        type="file" accept="image/*" className="hidden"
                        onChange={e => {
                          const file = e.target.files?.[0]
                          if (!file) return
                          const reader = new FileReader()
                          reader.onload = ev => setCompanySettings(p => ({ ...p, invoice_qr_image_url: ev.target?.result as string }))
                          reader.readAsDataURL(file)
                        }}
                      />
                    </label>
                    <span className="text-xs text-muted-foreground/50">or URL</span>
                  </div>
                  <input
                    value={companySettings['invoice_qr_image_url'] || ''}
                    onChange={e => setCompanySettings(p => ({ ...p, invoice_qr_image_url: e.target.value }))}
                    placeholder="https://… (leave empty to auto-generate from UPI ID)"
                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  {companySettings['invoice_qr_image_url'] && (
                    <div className="mt-2 flex items-center gap-2">
                      <img src={companySettings['invoice_qr_image_url']} alt="QR preview" className="h-16 object-contain rounded border border-border bg-white p-1" />
                      <button type="button" onClick={() => setCompanySettings(p => ({ ...p, invoice_qr_image_url: '' }))}
                        className="text-xs text-red-400 hover:text-red-300 transition-colors">Remove</button>
                    </div>
                  )}
                  <p className="text-[10px] text-muted-foreground mt-1">If provided, this image will be used instead of auto-generating a QR code.</p>
                </div>
              </div>

              {/* Invoice & Statement Design */}
              <div className="space-y-5 border-t border-border pt-5">
                <div>
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Invoice &amp; Statement Design</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">Customize colors, font, and layout for all printed documents</p>
                </div>

                {/* Live preview */}
                <div className="rounded-xl border border-border overflow-hidden">
                  <div className="px-3 py-1.5 bg-secondary/60 text-[10px] text-muted-foreground font-medium tracking-wider uppercase flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />Live Preview
                  </div>
                  <div
                    style={{
                      backgroundColor: '#fff',
                      fontFamily: companySettings['invoice_font'] || 'Arial, sans-serif',
                      position: 'relative',
                      overflow: 'hidden',
                      ...(companySettings['invoice_bg_style'] === 'dots'
                        ? { backgroundImage: `radial-gradient(circle, ${companySettings['invoice_primary_color'] || '#1a2744'}1a 1.5px, transparent 1.5px)`, backgroundSize: '12px 12px' }
                        : companySettings['invoice_bg_style'] === 'diagonal'
                        ? { backgroundImage: `repeating-linear-gradient(45deg, ${companySettings['invoice_primary_color'] || '#1a2744'}12 0px, ${companySettings['invoice_primary_color'] || '#1a2744'}12 1px, transparent 1px, transparent 12px)` }
                        : {}),
                    }}
                    className="p-4"
                  >
                    {companySettings['invoice_bg_style'] === 'corner' && (
                      <svg style={{ position: 'absolute', top: 0, right: 0, width: 80, height: 80, pointerEvents: 'none' }} viewBox="0 0 180 180">
                        <path d="M180 0 L180 180 L0 0 Z" fill={companySettings['invoice_primary_color'] || '#1a2744'} opacity="0.07"/>
                        <path d="M180 0 L180 120 L60 0 Z" fill={companySettings['invoice_primary_color'] || '#1a2744'} opacity="0.07"/>
                      </svg>
                    )}
                    {companySettings['invoice_bg_style'] === 'shade' && (() => {
                      const sp = companySettings['invoice_primary_color'] || '#1a2744'
                      const sa = companySettings['invoice_accent_color'] || '#3b5bdb'
                      return (
                        <>
                          <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: 38, pointerEvents: 'none' }} viewBox="0 0 800 130" preserveAspectRatio="none">
                            <defs><filter id="pvShTop" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation="11"/></filter></defs>
                            <g filter="url(#pvShTop)">
                              <path d="M-30 -40 L830 -40 L830 18 C700 52 560 6 430 30 C290 56 140 14 -30 58 Z" fill={sa} opacity="0.22"/>
                              <path d="M-30 -40 L830 -40 L830 44 C660 78 520 30 380 52 C240 74 100 32 -30 84 Z" fill={sa} opacity="0.13"/>
                              <path d="M-30 -40 L830 -40 L830 8 C740 30 660 12 560 24 C420 40 200 6 -30 36 Z" fill={sp} opacity="0.10"/>
                            </g>
                          </svg>
                          <svg style={{ position: 'absolute', bottom: 0, left: 0, width: '100%', height: 38, pointerEvents: 'none' }} viewBox="0 0 800 130" preserveAspectRatio="none">
                            <defs><filter id="pvShBot" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation="11"/></filter></defs>
                            <g filter="url(#pvShBot)">
                              <path d="M-30 170 L830 170 L830 112 C690 78 550 124 420 100 C280 74 130 116 -30 72 Z" fill={sa} opacity="0.22"/>
                              <path d="M-30 170 L830 170 L830 86 C650 52 510 100 370 78 C230 56 90 98 -30 46 Z" fill={sa} opacity="0.13"/>
                              <path d="M-30 170 L830 170 L830 122 C730 100 650 118 550 106 C410 90 190 124 -30 94 Z" fill={sp} opacity="0.10"/>
                            </g>
                          </svg>
                        </>
                      )
                    })()}
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        {(companySettings['logo_url_light'] || companySettings['logo_url']) && companySettings['invoice_show_logo'] !== 'false' ? (
                          <img src={companySettings['logo_url_light'] || companySettings['logo_url']} alt="logo" style={{ height: 36, objectFit: 'contain' }} />
                        ) : (
                          <svg width="32" height="32" viewBox="0 0 42 42" xmlns="http://www.w3.org/2000/svg">
                            <circle cx="21" cy="21" r="20" fill="none" stroke={companySettings['invoice_primary_color'] || '#1a2744'} strokeWidth="2.5"/>
                            <circle cx="21" cy="21" r="14" fill={companySettings['invoice_primary_color'] || '#1a2744'}/>
                            <text x="21" y="26" textAnchor="middle" fill="white" fontSize="14" fontWeight="bold" fontFamily="Arial">c</text>
                          </svg>
                        )}
                        {companySettings['invoice_show_company_name'] !== 'false' && (
                          <div>
                            <div style={{ fontSize: 16, fontWeight: 900, color: companySettings['invoice_primary_color'] || '#1a2744', lineHeight: 1 }}>
                              {companySettings['company_name'] || 'cirqle'}
                            </div>
                            {companySettings['invoice_show_tagline'] !== 'false' && (
                              <div style={{ fontSize: 8, color: '#888', letterSpacing: 1, textTransform: 'uppercase' }}>
                                {companySettings['company_tagline'] || 'Get Budget Designs'}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      <div style={{ fontSize: 22, fontWeight: 900, color: companySettings['invoice_primary_color'] || '#1a2744', letterSpacing: 2 }}>
                        INVOICE
                      </div>
                    </div>
                    <div style={{ height: 3, background: `linear-gradient(90deg, ${companySettings['invoice_primary_color'] || '#1a2744'} 0%, ${companySettings['invoice_accent_color'] || '#3b5bdb'} 60%, #e0e7f0 100%)`, borderRadius: 2, marginBottom: 8 }} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <div style={{ fontSize: 7, fontWeight: 700, color: companySettings['invoice_primary_color'] || '#1a2744', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 2 }}>Bill To</div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: companySettings['invoice_primary_color'] || '#1a2744' }}>Client Name</div>
                        <div style={{ fontSize: 9, color: '#666' }}>client@email.com</div>
                      </div>
                      <table style={{ borderCollapse: 'collapse' as const }}>
                        <tbody>
                          {[['Invoice No.','INV-2605-001'],['Date','15/05/2026'],['Due Date','14/06/2026']].map(([l,v]) => (
                            <tr key={l}>
                              <td style={{ fontSize: 8, color: '#888', paddingRight: 8, paddingBottom: 2 }}>{l}</td>
                              <td style={{ fontSize: 8, color: '#555' }}>:</td>
                              <td style={{ fontSize: 8, fontWeight: 600, color: companySettings['invoice_primary_color'] || '#1a2744', paddingLeft: 6, paddingBottom: 2 }}>{v}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div style={{ marginTop: 8, background: companySettings['invoice_primary_color'] || '#1a2744', borderRadius: 4, padding: '5px 8px', display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 9, color: 'white', fontWeight: 700 }}>Total Payable</span>
                      <span style={{ fontSize: 10, color: 'white', fontWeight: 900 }}>₹5,250.00</span>
                    </div>
                  </div>
                </div>

                {/* Colors */}
                <div className="space-y-3">
                  <p className="text-xs font-medium text-muted-foreground">Colors</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-muted-foreground mb-1.5">Header / Primary Color</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={companySettings['invoice_primary_color'] || '#1a2744'}
                          onChange={e => setCompanySettings(p => ({ ...p, invoice_primary_color: e.target.value }))}
                          className="h-9 w-12 rounded border border-border cursor-pointer bg-secondary p-0.5"
                        />
                        <input
                          type="text"
                          value={companySettings['invoice_primary_color'] || '#1a2744'}
                          onChange={e => setCompanySettings(p => ({ ...p, invoice_primary_color: e.target.value }))}
                          className="flex-1 bg-secondary border border-border rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/50"
                          placeholder="#1a2744"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-muted-foreground mb-1.5">Gradient Accent Color</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={companySettings['invoice_accent_color'] || '#3b5bdb'}
                          onChange={e => setCompanySettings(p => ({ ...p, invoice_accent_color: e.target.value }))}
                          className="h-9 w-12 rounded border border-border cursor-pointer bg-secondary p-0.5"
                        />
                        <input
                          type="text"
                          value={companySettings['invoice_accent_color'] || '#3b5bdb'}
                          onChange={e => setCompanySettings(p => ({ ...p, invoice_accent_color: e.target.value }))}
                          className="flex-1 bg-secondary border border-border rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/50"
                          placeholder="#3b5bdb"
                        />
                      </div>
                    </div>
                  </div>
                  {/* Color presets */}
                  <div>
                    <p className="text-[10px] text-muted-foreground mb-1.5">Quick Presets</p>
                    <div className="flex flex-wrap gap-2">
                      {[
                        { name: 'Navy',    primary: '#1a2744', accent: '#243459' },
                        { name: 'Black',   primary: '#111111', accent: '#333333' },
                        { name: 'Forest',  primary: '#1a4731', accent: '#2d7a52' },
                        { name: 'Crimson', primary: '#7f1d1d', accent: '#b91c1c' },
                        { name: 'Indigo',  primary: '#312e81', accent: '#4f46e5' },
                        { name: 'Teal',    primary: '#134e4a', accent: '#0d9488' },
                        { name: 'Purple',  primary: '#4a1d96', accent: '#7c3aed' },
                        { name: 'Slate',   primary: '#1e293b', accent: '#475569' },
                      ].map(({ name, primary, accent }) => (
                        <button
                          key={name}
                          type="button"
                          onClick={() => setCompanySettings(p => ({ ...p, invoice_primary_color: primary, invoice_accent_color: accent }))}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border hover:border-primary/40 text-xs transition-colors bg-secondary/40 hover:bg-secondary"
                        >
                          <span className="flex gap-0.5">
                            <span style={{ background: primary }} className="w-3 h-3 rounded-sm inline-block" />
                            <span style={{ background: accent }}  className="w-3 h-3 rounded-sm inline-block" />
                          </span>
                          {name}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Font */}
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Document Font</label>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { value: 'Airbnb Cereal App, Arial, sans-serif', label: 'Airbnb', sample: 'Aa' },
                      { value: 'Arial, Helvetica, sans-serif',     label: 'Arial',    sample: 'Aa' },
                      { value: 'Georgia, Times New Roman, serif',  label: 'Georgia',  sample: 'Aa' },
                      { value: 'Helvetica Neue, Helvetica, Arial, sans-serif', label: 'Helvetica', sample: 'Aa' },
                      { value: 'Trebuchet MS, sans-serif',         label: 'Trebuchet',sample: 'Aa' },
                      { value: 'Verdana, Geneva, sans-serif',      label: 'Verdana',  sample: 'Aa' },
                      { value: 'Tahoma, Geneva, sans-serif',       label: 'Tahoma',   sample: 'Aa' },
                    ].map(f => (
                      <button
                        key={f.value}
                        type="button"
                        onClick={() => setCompanySettings(p => ({ ...p, invoice_font: f.value }))}
                        className={`p-2.5 rounded-lg border text-center transition-colors ${(companySettings['invoice_font'] || 'Arial, Helvetica, sans-serif') === f.value ? 'border-primary/60 bg-primary/10 text-primary' : 'border-border bg-secondary/40 text-muted-foreground hover:border-border hover:text-foreground'}`}
                        style={{ fontFamily: f.value }}
                      >
                        <div className="text-lg font-bold leading-none">{f.sample}</div>
                        <div className="text-[10px] mt-1">{f.label}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Logo & layout toggles */}
                <div className="space-y-3">
                  <p className="text-xs font-medium text-muted-foreground">Layout Options</p>
                  {[
                    { key: 'invoice_show_logo',        label: 'Show Logo on Documents',          desc: 'Display logo in invoice/statement header' },
                    { key: 'invoice_show_company_name',label: 'Show Company Name',               desc: 'Show company name text beside the logo (turn off if your logo already has the name)' },
                    { key: 'invoice_show_tagline',     label: 'Show Tagline',                    desc: 'Show company tagline below the name' },
                    { key: 'invoice_show_payment_info',label: 'Show Payment Info on Invoice',    desc: 'Display bank/UPI details on printed invoices' },
                    { key: 'invoice_show_phone',       label: 'Show Phone & Website',            desc: 'Show contact details in header' },
                    { key: 'invoice_show_qr',          label: 'Show UPI QR Code',                desc: 'Scannable UPI payment QR in the invoice footer' },
                  ].map(({ key, label, desc }) => (
                    <div key={key} className="flex items-center justify-between py-1">
                      <div>
                        <p className="text-sm text-foreground">{label}</p>
                        <p className="text-xs text-muted-foreground">{desc}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setCompanySettings(p => ({ ...p, [key]: p[key] === 'false' ? 'true' : 'false' }))}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none shrink-0 ${companySettings[key] === 'false' ? 'bg-secondary border border-border' : 'bg-primary'}`}
                      >
                        <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${companySettings[key] === 'false' ? 'translate-x-1' : 'translate-x-5'}`} />
                      </button>
                    </div>
                  ))}
                </div>

                {/* Background Style */}
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">Background Design</p>
                  <div className="grid grid-cols-2 gap-2">
                    {([
                      { value: 'none',     label: 'None',          preview: 'bg-white' },
                      { value: 'dots',     label: 'Dot Grid',      preview: 'bg-white' },
                      { value: 'corner',   label: 'Corner Accent', preview: 'bg-white' },
                      { value: 'diagonal', label: 'Diagonal',      preview: 'bg-white' },
                      { value: 'shade',    label: 'Silk Shade',    preview: 'bg-white' },
                      { value: 'custom_images', label: 'Custom Images', preview: 'bg-white' },
                    ] as const).map(opt => {
                      const active = (companySettings['invoice_bg_style'] || 'none') === opt.value
                      const primary = companySettings['invoice_primary_color'] || '#1a2744'
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setCompanySettings(p => ({ ...p, invoice_bg_style: opt.value }))}
                          className={`relative h-14 rounded-lg border-2 overflow-hidden text-xs font-medium transition-all ${active ? 'border-primary' : 'border-border hover:border-muted-foreground'}`}
                          style={{ background: '#fff' }}
                        >
                          {opt.value === 'dots' && (
                            <div style={{ position: 'absolute', inset: 0, backgroundImage: `radial-gradient(circle, ${primary}22 1px, transparent 1px)`, backgroundSize: '10px 10px' }} />
                          )}
                          {opt.value === 'corner' && (
                            <div style={{ position: 'absolute', top: 0, right: 0, width: 36, height: 36, background: `linear-gradient(225deg, ${primary} 50%, transparent 50%)`, opacity: 0.25 }} />
                          )}
                          {opt.value === 'diagonal' && (
                            <div style={{ position: 'absolute', inset: 0, backgroundImage: `repeating-linear-gradient(45deg, ${primary}18 0px, ${primary}18 1px, transparent 1px, transparent 12px)` }} />
                          )}
                          {opt.value === 'shade' && (
                            <>
                              <div style={{ position: 'absolute', top: -6, left: -8, right: -8, height: 18, filter: 'blur(4px)', background: `radial-gradient(ellipse 60% 100% at 15% 0%, ${primary}55, transparent 70%), radial-gradient(ellipse 50% 90% at 80% 0%, ${primary}40, transparent 70%)` }} />
                              <div style={{ position: 'absolute', bottom: -6, left: -8, right: -8, height: 18, filter: 'blur(4px)', background: `radial-gradient(ellipse 60% 100% at 75% 100%, ${primary}55, transparent 70%), radial-gradient(ellipse 50% 90% at 20% 100%, ${primary}40, transparent 70%)` }} />
                            </>
                          )}
                          <span style={{ position: 'relative', zIndex: 1, color: active ? primary : '#6b7280' }}>{opt.label}</span>
                        </button>
                      )
                    })}
                  </div>
                  
                  {companySettings['invoice_bg_style'] === 'custom_images' && (
                    <div className="mt-4 p-3 border border-border rounded-lg bg-secondary/30">
                      <p className="text-[10px] text-muted-foreground mb-3">Upload images to be placed at the top and bottom edges of your invoices.</p>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[10px] font-medium text-muted-foreground mb-1">Top Image</label>
                          <label className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-secondary border border-border text-xs text-muted-foreground hover:text-foreground hover:border-border/80 cursor-pointer transition-colors">
                            Upload Top
                            <input type="file" accept="image/*" className="hidden" onChange={e => {
                              const file = e.target.files?.[0]
                              if (!file) return
                              const reader = new FileReader()
                              reader.onload = ev => setCompanySettings(p => ({ ...p, invoice_bg_image_top_url: ev.target?.result as string }))
                              reader.readAsDataURL(file)
                            }} />
                          </label>
                          {companySettings['invoice_bg_image_top_url'] && (
                            <div className="mt-2 flex items-center justify-between">
                              <img src={companySettings['invoice_bg_image_top_url']} alt="Top preview" className="h-10 object-contain rounded border border-border bg-white" />
                              <button type="button" onClick={() => setCompanySettings(p => ({ ...p, invoice_bg_image_top_url: '' }))} className="text-[10px] text-red-400 hover:text-red-300">Remove</button>
                            </div>
                          )}
                        </div>
                        <div>
                          <label className="block text-[10px] font-medium text-muted-foreground mb-1">Bottom Image</label>
                          <label className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-secondary border border-border text-xs text-muted-foreground hover:text-foreground hover:border-border/80 cursor-pointer transition-colors">
                            Upload Bottom
                            <input type="file" accept="image/*" className="hidden" onChange={e => {
                              const file = e.target.files?.[0]
                              if (!file) return
                              const reader = new FileReader()
                              reader.onload = ev => setCompanySettings(p => ({ ...p, invoice_bg_image_bottom_url: ev.target?.result as string }))
                              reader.readAsDataURL(file)
                            }} />
                          </label>
                          {companySettings['invoice_bg_image_bottom_url'] && (
                            <div className="mt-2 flex items-center justify-between">
                              <img src={companySettings['invoice_bg_image_bottom_url']} alt="Bottom preview" className="h-10 object-contain rounded border border-border bg-white" />
                              <button type="button" onClick={() => setCompanySettings(p => ({ ...p, invoice_bg_image_bottom_url: '' }))} className="text-[10px] text-red-400 hover:text-red-300">Remove</button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Footer text */}
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Invoice Footer Text</label>
                  <input
                    value={companySettings['invoice_footer_text'] || ''}
                    onChange={e => setCompanySettings(p => ({ ...p, invoice_footer_text: e.target.value }))}
                    placeholder="e.g. Thank you for your Business!"
                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">Appears at the bottom of every printed invoice</p>
                </div>
              </div>

              {/* GST */}
              <div className="space-y-4 border-t border-border pt-5">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">GST</h2>
                    <p className="text-xs text-muted-foreground mt-0.5">When enabled, GST will appear on invoices and quotations</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCompanySettings(p => ({ ...p, gst_enabled: p.gst_enabled === 'true' ? 'false' : 'true' }))}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${companySettings['gst_enabled'] === 'true' ? 'bg-primary' : 'bg-secondary border border-border'}`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${companySettings['gst_enabled'] === 'true' ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </div>
                {companySettings['gst_enabled'] === 'true' && (
                  <div className="grid grid-cols-2 gap-3 p-4 bg-primary/5 border border-primary/15 rounded-xl">
                    <div>
                      <label className="block text-xs font-medium text-muted-foreground mb-1.5">Your GSTIN</label>
                      <input
                        value={companySettings['company_gstin'] || ''}
                        onChange={e => setCompanySettings(p => ({ ...p, company_gstin: e.target.value }))}
                        placeholder="22AAAAA0000A1Z5"
                        maxLength={15}
                        className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/50 uppercase"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted-foreground mb-1.5">GST Rate (%)</label>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        value={companySettings['gst_rate'] || '18'}
                        onChange={e => setCompanySettings(p => ({ ...p, gst_rate: e.target.value }))}
                        className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                      />
                    </div>
                    <p className="col-span-2 text-xs text-muted-foreground">GST calculation logic on invoices/quotations is ready to activate — it will auto-compute CGST + SGST (domestic) or IGST (inter-state) once billing is built out.</p>
                  </div>
                )}
              </div>

              {/* Expense Display Mode — controls how rebilled client expenses appear on PDFs */}
              <div className="space-y-3 border-t border-border pt-5">
                <div>
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Client Expense Display Mode</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">Controls how rebilled client expenses appear on invoice PDFs. Can be overridden per invoice.</p>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {([
                    { val: 'mode_a', label: 'Mode A — Clean', desc: 'Description + billing amount only. Internal costs hidden.' },
                    { val: 'mode_b', label: 'Mode B — Breakdown', desc: 'Shows original cost, markup, and total separately.' },
                    { val: 'mode_c', label: 'Mode C — Reimbursable', desc: 'Description + "Reimbursable Expense" label + billing amount.' },
                  ] as const).map(({ val, label, desc }) => (
                    <button key={val} type="button"
                      onClick={() => {
                        setCompanySettings(p => ({ ...p, expense_display_mode: val }))
                        void saveSetting('expense_display_mode', val)
                      }}
                      className={`p-3 rounded-xl border text-left transition-colors ${
                        (companySettings['expense_display_mode'] || 'mode_a') === val
                          ? 'bg-primary/10 border-primary/50 text-primary'
                          : 'bg-secondary border-border text-muted-foreground hover:text-foreground hover:border-border/70'
                      }`}>
                      <div className="text-xs font-semibold mb-1">{label}</div>
                      <div className="text-[10px] leading-tight opacity-70">{desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Data Visibility — per-role access control */}
              <div className="space-y-4 border-t border-border pt-5">
                <div>
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Data Visibility</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">Control what employees and team leads can see in the app.</p>
                </div>

                {([
                  { key: 'visibility_billing',      label: 'Billing amounts & invoice values', hint: 'Task billing, invoice totals, earnings' },
                  { key: 'visibility_contributions', label: 'Contribution scores & percentages', hint: 'Score %, earnings per task' },
                  { key: 'visibility_employee_names', label: 'Employee names & personal details', hint: 'Names, email, phone, DOB in HR sections' },
                ] as const).map(({ key, label, hint }) => (
                  <div key={key}>
                    <label className="block text-xs font-medium text-foreground mb-0.5">{label}</label>
                    <p className="text-[11px] text-muted-foreground/60 mb-1.5">{hint}</p>
                    <div className="flex gap-1.5">
                      {([
                        { val: 'all',         lbl: 'All roles' },
                        { val: 'team_lead',   lbl: 'Team Lead+' },
                        { val: 'admin_only',  lbl: 'Admin only' },
                      ] as const).map(({ val, lbl }) => (
                        <button
                          key={val}
                          type="button"
                          onClick={() => setCompanySettings(p => ({ ...p, [key]: val }))}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                            (companySettings[key] || 'all') === val
                              ? 'bg-primary/20 border-primary/50 text-primary'
                              : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                          }`}
                        >{lbl}</button>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="bg-amber-500/8 border border-amber-500/20 rounded-lg px-3 py-2 text-[11px] text-amber-400/80">
                  ⚠️ These settings restrict what data is <strong>displayed</strong>. Super admins always see everything regardless of this setting.
                </div>
              </div>

              <button onClick={saveCompanySettings} disabled={saving} className="gradient-bg text-white text-sm font-medium px-5 py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50">
                {saving ? 'Saving…' : 'Save Settings'}
              </button>
            </div>
          )}

          {/* Employees */}
          {tab === 'Employees' && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold">Employees ({filteredEmployees.length}{empSearch ? `/${employees.length}` : ''})</h2>
                <div className="flex items-center gap-2">
                  <button onClick={() => setShowRecalcCommissions(true)}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-secondary transition-colors text-muted-foreground">
                    <RefreshCw className="w-4 h-4" /> Bulk Recalc
                  </button>
                  <button onClick={() => openEmployeeForm()}
                    className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90">
                    <Plus className="w-4 h-4" /> Add Employee
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2 mb-3">
                <div className="flex bg-secondary border border-border rounded-lg p-0.5">
                  {(['active', 'archived', 'all'] as const).map(f => (
                    <button
                      key={f}
                      onClick={() => setEmpFilter(f)}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${empFilter === f ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                    >
                      {f === 'active' ? 'Active' : f === 'archived' ? 'Archived' : 'All'}
                    </button>
                  ))}
                </div>
                <div className="flex-1">
                  <SearchBar value={empSearch} onChange={setEmpSearch} placeholder="Search by CQID, name or role…" />
                </div>
              </div>

              {/* Employee Access Info Banner */}
              <div className="mb-4 bg-blue-500/5 border border-blue-500/20 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-blue-500/15 flex items-center justify-center shrink-0">
                    <KeyRound className="w-4 h-4 text-blue-400" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-blue-300 mb-1">Giving Employees App Access</p>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Each employee can log into the app with their own email and password. Their role controls what they see.
                      To set up access:
                    </p>
                    <ol className="text-xs text-muted-foreground mt-2 space-y-1 list-decimal list-inside">
                      <li>Make sure the employee record below has their correct email address</li>
                      <li>Go to <a href="https://supabase.com/dashboard/project/lgqarkdmlyfpacyqhfha/auth/users" target="_blank" className="text-blue-400 underline hover:text-blue-300">Supabase Auth → Users</a> and invite them by email</li>
                      <li>They receive a login link, set their password, and can log in at <strong className="text-foreground">/login</strong></li>
                      <li>The app automatically recognizes their role from their employee record</li>
                    </ol>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                {filteredEmployees.map(emp => (
                  <div key={emp.id} className="bg-card border border-border rounded-xl px-5 py-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <EmployeeAvatar
                        avatarUrl={(emp as any).avatar_url}
                        name={emp.name}
                        cqid={emp.cqid}
                        size={36}
                        rounded="lg"
                      />
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium">{emp.cqid}</p>
                          {isUnlocked && emp.name && (
                            <span className="text-sm text-foreground/70">— {emp.name}</span>
                          )}
                          {emp.auth_id
                            ? <span className="text-[10px] bg-green-500/15 text-green-400 border border-green-500/25 px-1.5 py-0.5 rounded-full">Has Access</span>
                            : <span className="text-[10px] bg-gray-500/15 text-gray-500 border border-gray-500/20 px-1.5 py-0.5 rounded-full">No Login</span>
                          }
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {ds(emp.email, '••••@••••.com')} · {emp.role.replace(/_/g, ' ')} · {emp.performance_rating}% rating
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {emp.is_archived && (
                        <span className="text-xs px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-400">Archived</span>
                      )}
                      {!emp.is_archived && (
                        <span className={`text-xs px-2 py-0.5 rounded-md ${emp.is_active ? 'bg-green-500/15 text-green-400' : 'bg-gray-500/15 text-gray-400'}`}>{emp.is_active ? 'Active' : 'Inactive'}</span>
                      )}

                      {/* Invite to register — when no auth_id and not archived */}
                      {!emp.auth_id && !emp.is_archived && (
                        <button
                          onClick={() => handleGenerateInvite(emp)}
                          disabled={inviteBusy === emp.id}
                          title="Generate invite link"
                          className="p-2 rounded-lg hover:bg-violet-500/15 text-muted-foreground hover:text-violet-400 transition-colors disabled:opacity-50"
                        >
                          <Send className="w-4 h-4" />
                        </button>
                      )}

                      {/* Admin reset password — when registered */}
                      {emp.auth_id && !emp.is_archived && (
                        <button
                          onClick={() => handleAdminResetPassword(emp)}
                          disabled={inviteBusy === emp.id}
                          title="Reset password (admin)"
                          className="p-2 rounded-lg hover:bg-blue-500/15 text-muted-foreground hover:text-blue-400 transition-colors disabled:opacity-50"
                        >
                          <ResetKey className="w-4 h-4" />
                        </button>
                      )}

                      {/* Portal token copy (legacy read-only view) */}
                      <button
                        onClick={() => {
                          const url = `${window.location.origin}/portal/${(emp as any).portal_token}`
                          navigator.clipboard.writeText(url)
                          setCopiedPortalId(emp.id)
                          setTimeout(() => setCopiedPortalId(null), 2000)
                        }}
                        title={(emp as any).portal_token ? 'Copy portal link' : 'No portal token — run SQL migration'}
                        disabled={!(emp as any).portal_token}
                        className="p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-violet-400 disabled:opacity-30"
                      >
                        {copiedPortalId === emp.id ? <Check className="w-4 h-4 text-green-400" /> : <Link2 className="w-4 h-4" />}
                      </button>

                      {/* Change avatar */}
                      <button
                        onClick={() => {
                          setAvatarModal({ id: emp.id, cqid: emp.cqid, name: emp.name, currentUrl: (emp as any).avatar_url ?? null })
                          setAvatarPickerValue((emp as any).avatar_url ?? null)
                        }}
                        className="p-2 rounded-lg hover:bg-violet-500/15 text-muted-foreground hover:text-violet-400 transition-colors"
                        title="Change avatar"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"/>
                        </svg>
                      </button>

                      <button onClick={() => openEmployeeForm(emp)} className="p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground" title="Edit">
                        <Edit2 className="w-4 h-4" />
                      </button>

                      <Link href={`/dashboard/employees/${emp.id}/agreements`} className="p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-primary" title="Commission Agreements">
                        <Handshake className="w-4 h-4" />
                      </Link>

                      {emp.is_archived ? (
                        <button
                          onClick={() => handleRestore(emp)}
                          disabled={inviteBusy === emp.id}
                          className="p-2 rounded-lg hover:bg-emerald-500/15 text-muted-foreground hover:text-emerald-400 transition-colors disabled:opacity-50"
                          title="Restore employee"
                        >
                          <ArchiveRestore className="w-4 h-4" />
                        </button>
                      ) : (
                        <button
                          onClick={() => handleArchive(emp)}
                          disabled={inviteBusy === emp.id}
                          className="p-2 rounded-lg hover:bg-amber-500/15 text-muted-foreground hover:text-amber-400 transition-colors disabled:opacity-50"
                          title="Archive employee"
                        >
                          <Archive className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Clients */}
          {tab === 'Clients' && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <h2 className="text-sm font-semibold">Clients ({filteredClients.length}{clientSearch ? `/${clients.length}` : ''})</h2>
                  <button onClick={() => setQuickEdit(q => !q)}
                    title={quickEdit ? 'Exit quick edit mode' : 'Enable quick edit — edit rows inline'}
                    className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border transition-all ${
                      quickEdit ? 'bg-amber-500/15 border-amber-500/30 text-amber-400' : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                    }`}>
                    <Zap className="w-3 h-3" /> {quickEdit ? 'Exit edit' : 'Quick edit'}
                  </button>
                </div>
                <button onClick={() => openClientForm()} className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90">
                  <Plus className="w-4 h-4" /> Add Client
                </button>
              </div>
              <div className="flex items-center gap-2 mb-3">
                <SearchBar value={clientSearch} onChange={setClientSearch} placeholder="Search clients…" className="flex-1" />
                <button onClick={() => setClientSort(s => s === 'name' ? 'code' : 'name')}
                  className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg bg-secondary border border-border text-muted-foreground hover:text-foreground transition-colors shrink-0">
                  <ArrowUpDown className="w-3 h-3" />
                  Sort: {clientSort === 'name' ? 'Name' : 'Code'}
                </button>
              </div>
              {quickEdit && (
                <p className="text-[11px] text-amber-400/70 bg-amber-500/5 border border-amber-500/15 rounded-lg px-3 py-2 mb-3 flex items-center gap-1.5">
                  <Zap className="w-3 h-3 shrink-0" /> Click any field to edit — changes auto-save when you leave the field. Use the ✏️ button for full edit.
                </p>
              )}
              <div className="space-y-1.5">
                {filteredClients.map((client: any) => quickEdit ? (
                  <div key={client.id} className="bg-card border border-amber-500/20 rounded-xl px-3 py-2.5 flex items-center gap-2">
                    <input
                      key={`${client.id}-name`}
                      defaultValue={client.name}
                      onBlur={e => qeSave(quickEditClient, client.id, 'name', e.target.value.trim(), setClients as any)}
                      className="flex-1 bg-secondary border border-border/0 hover:border-border focus:border-primary rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:bg-background transition-colors"
                      placeholder="Name"
                    />
                    <input
                      key={`${client.id}-code`}
                      defaultValue={client.code}
                      onBlur={e => qeSave(quickEditClient, client.id, 'code', e.target.value.trim().toUpperCase(), setClients as any)}
                      className="w-16 bg-secondary border border-border/0 hover:border-border focus:border-primary rounded-lg px-2 py-1.5 text-sm font-mono text-center focus:outline-none focus:bg-background transition-colors"
                      placeholder="Code"
                    />
                    <input
                      key={`${client.id}-phone`}
                      defaultValue={client.phone || ''}
                      onBlur={e => qeSave(quickEditClient, client.id, 'phone', e.target.value.trim(), setClients as any)}
                      className="w-36 bg-secondary border border-border/0 hover:border-border focus:border-primary rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:bg-background transition-colors"
                      placeholder="Phone"
                    />
                    <input
                      key={`${client.id}-email`}
                      defaultValue={client.email || ''}
                      onBlur={e => qeSave(quickEditClient, client.id, 'email', e.target.value.trim(), setClients as any)}
                      className="w-44 bg-secondary border border-border/0 hover:border-border focus:border-primary rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:bg-background transition-colors"
                      placeholder="Email"
                    />
                    <button onClick={() => openClientForm(client)} className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground/40 hover:text-foreground shrink-0">
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <div key={client.id} className="bg-card border border-border rounded-xl px-5 py-4 flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium">{client.name}</p>
                        <span className="text-xs font-mono bg-secondary px-2 py-0.5 rounded">{client.code}</span>
                        {client.pricing_pending && (
                          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/25">
                            Needs pricing
                          </span>
                        )}
                        {clientOutstanding[client.id]?.outstanding > 0 && (
                          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-400 border border-orange-500/20">
                            ₹{Math.round(clientOutstanding[client.id].outstanding).toLocaleString('en-IN')} outstanding
                          </span>
                        )}
                        {clientOutstanding[client.id] && clientOutstanding[client.id].outstanding <= 0 && clientOutstanding[client.id].billed > 0 && (
                          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">
                            Paid up
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {[client.email, client.phone].filter(Boolean).join(' · ')}
                        {clientOutstanding[client.id]?.billed > 0 && (
                          <span className="ml-2 text-muted-foreground/60">
                            Billed: ₹{Math.round(clientOutstanding[client.id].billed).toLocaleString('en-IN')}
                            {' · '}Paid: ₹{Math.round(clientOutstanding[client.id].paid).toLocaleString('en-IN')}
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => openClientForm(client)} className="p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground">
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button onClick={() => requestDelete('Client', client.id, client.name, async () => {
                        await deactivateClient(client.id)
                        setClients(prev => prev.filter((x: any) => x.id !== client.id))
                      })} className="p-2 rounded-lg hover:bg-amber-500/15 text-muted-foreground hover:text-amber-400 transition-colors" title="Archive client">
                        <Archive className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Services */}
          {tab === 'Services' && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <h2 className="text-sm font-semibold">Services ({filteredServices.length}{serviceSearch ? `/${services.length}` : ''})</h2>
                  <button onClick={() => setQuickEdit(q => !q)}
                    className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border transition-all ${
                      quickEdit ? 'bg-amber-500/15 border-amber-500/30 text-amber-400' : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                    }`}>
                    <Zap className="w-3 h-3" /> {quickEdit ? 'Exit edit' : 'Quick edit'}
                  </button>
                </div>
                <button onClick={() => openForm('service', { is_active: true })} className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90">
                  <Plus className="w-4 h-4" /> Add Service
                </button>
              </div>
              <div className="flex items-center gap-2 mb-3">
                <SearchBar value={serviceSearch} onChange={setServiceSearch} placeholder="Search services…" className="flex-1" />
                <button onClick={() => setServiceSort(s => s === 'name' ? 'usage' : 'name')}
                  className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg bg-secondary border border-border text-muted-foreground hover:text-foreground transition-colors shrink-0">
                  <ArrowUpDown className="w-3 h-3" />
                  {serviceSort === 'usage' ? 'By usage' : 'A–Z'}
                </button>
              </div>
              <div className="space-y-1.5">
                {filteredServices.map((svc: any) => {
                  const linkedGroupIds = groupServices.filter(gs => gs.service_id === svc.id).map(gs => gs.group_id)
                  const linkedGroupNames = groups.filter((g: any) => linkedGroupIds.includes(g.id)).map((g: any) => g.name.replace(' Group', ''))
                  return quickEdit ? (
                    <div key={svc.id} className="bg-card border border-amber-500/20 rounded-xl px-3 py-2.5 flex items-center gap-2">
                      <input
                        key={`${svc.id}-name`}
                        defaultValue={svc.name}
                        onBlur={e => qeSave(quickEditService, svc.id, 'name', e.target.value.trim(), setServices as any)}
                        className="flex-1 bg-secondary border border-border/0 hover:border-border focus:border-primary rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:bg-background transition-colors"
                        placeholder="Service name"
                      />
                      <input
                        key={`${svc.id}-desc`}
                        defaultValue={svc.description || ''}
                        onBlur={e => qeSave(quickEditService, svc.id, 'description', e.target.value.trim(), setServices as any)}
                        className="w-52 bg-secondary border border-border/0 hover:border-border focus:border-primary rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:bg-background transition-colors text-muted-foreground"
                        placeholder="Description (optional)"
                      />
                      {linkedGroupNames.length > 0 && (
                        <div className="flex gap-1 shrink-0">
                          {linkedGroupNames.slice(0, 2).map(n => (
                            <span key={n} className="text-[10px] bg-primary/10 text-primary border border-primary/20 px-1.5 py-0.5 rounded-full font-medium">{n}</span>
                          ))}
                        </div>
                      )}
                      <button onClick={() => { setEditingId(svc.id); setShowForm('service'); const gids = groupServices.filter(gs => gs.service_id === svc.id).map(gs => gs.group_id); setForm({ ...svc, _groupIds: gids }) }}
                        className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground/40 hover:text-foreground shrink-0">
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div key={svc.id} className="bg-card border border-border rounded-xl px-5 py-4 flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-medium">{svc.name}</p>
                          {svc.pricing_pending && (
                            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/25">
                              Needs pricing
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          {svc.description && <p className="text-xs text-muted-foreground">{svc.description}</p>}
                          {linkedGroupNames.length > 0
                            ? linkedGroupNames.map(n => (
                                <span key={n} className="text-[10px] bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 rounded-full font-medium">{n}</span>
                              ))
                            : <span className="text-[10px] text-muted-foreground/50 italic">No groups linked</span>
                          }
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => { setEditingId(svc.id); setShowForm('service'); const gids = groupServices.filter(gs => gs.service_id === svc.id).map(gs => gs.group_id); setForm({ ...svc, _groupIds: gids }) }}
                          className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground">
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button onClick={() => requestDelete('Service', svc.id, svc.name, async () => {
                          await deactivateService(svc.id)
                          setServices(prev => prev.filter((x: any) => x.id !== svc.id))
                        })} className="p-2 rounded-lg hover:bg-amber-500/15 text-muted-foreground hover:text-amber-400 transition-colors" title="Archive service">
                          <Archive className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Groups & Params */}
          {tab === 'Groups & Params' && (
            <div className="space-y-6">
              {/* Groups */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold">Contribution Groups ({filteredGroups.length}{groupSearch ? `/${groups.length}` : ''})</h2>
                  <button onClick={() => openForm('group', { weight: 50, display_order: groups.length + 1, is_active: true })} className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-3 py-2 rounded-lg hover:opacity-90 text-xs">
                    <Plus className="w-3.5 h-3.5" /> Add Group
                  </button>
                </div>
                <SearchBar value={groupSearch} onChange={setGroupSearch} placeholder="Search groups…" className="mb-3" />
                {/* Weight sum warning */}
                {(() => {
                  const total = groups.reduce((s: number, g: any) => s + (g.weight || 0), 0)
                  if (Math.abs(total - 100) > 0.5) return (
                    <div className={`mb-3 px-4 py-2.5 rounded-xl border text-sm flex items-center gap-2 ${total > 100 ? 'bg-red-500/10 border-red-500/20 text-red-400' : 'bg-amber-500/10 border-amber-500/20 text-amber-400'}`}>
                      <span className="font-semibold">⚠</span>
                      Group weights sum to <strong>{total}%</strong> — should equal exactly <strong>100%</strong>.
                      {total > 100 && ' Overage will reduce each employee\'s effective earnings.'}
                      {total < 100 && ' Shortfall means some commission pool is unallocated.'}
                    </div>
                  )
                  return null
                })()}
                <div className="space-y-2">
                  {filteredGroups.map((g: any) => (
                    <div key={g.id} className="bg-card border border-border rounded-xl px-4 py-3 flex items-center justify-between">
                      <div>
                        <p className="font-medium text-sm">{g.name}</p>
                        <p className="text-xs text-muted-foreground">Weight: {g.weight}% · Order: {g.display_order}</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => { setEditingId(g.id); setShowForm('group'); setForm(g) }} className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground">
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => requestDelete('Group', g.id, g.name, async () => {
                          await deactivateGroup(g.id)
                          setGroups(prev => prev.filter((x: any) => x.id !== g.id))
                        })} className="p-2 rounded-lg hover:bg-amber-500/15 text-muted-foreground hover:text-amber-400 transition-colors" title="Archive group">
                          <Archive className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                  {filteredGroups.length === 0 && groupSearch && (
                    <p className="text-sm text-muted-foreground text-center py-4 opacity-60">No groups match "{groupSearch}"</p>
                  )}
                </div>
              </div>

              {/* Parameters */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold">Parameters ({filteredParams.length}{paramSearch ? `/${params.length}` : ''})</h2>
                  <button onClick={() => openForm('param', { weight: 1, is_master: false, input_type: 'count', display_order: params.length + 1, is_active: true })} className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-3 py-2 rounded-lg hover:opacity-90 text-xs">
                    <Plus className="w-3.5 h-3.5" /> Add Parameter
                  </button>
                </div>
                <SearchBar value={paramSearch} onChange={setParamSearch} placeholder="Search parameters…" className="mb-3" />
                <div className="space-y-2">
                  {filteredParams.map((p: any) => {
                    const group = groups.find((g: any) => g.id === p.group_id)
                    const linkedServices = props.parameterServices.filter((ps: any) => ps.parameter_id === p.id).length
                    const isMaster = p.is_master === true
                    const inputType = p.input_type || 'count'
                    return (
                      <div key={p.id} className="bg-card border border-border rounded-xl px-4 py-3 flex items-center justify-between">
                        <div>
                          <div className="flex items-center gap-2 mb-0.5">
                            <p className="font-medium text-sm">{p.name}</p>
                            {isMaster && <span className="text-[10px] bg-purple-500/15 text-purple-400 border border-purple-500/20 px-1.5 py-0.5 rounded font-medium">MASTER</span>}
                            <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${inputType === 'percentage' ? 'bg-blue-500/10 text-blue-400 border-blue-500/20' : 'bg-secondary text-muted-foreground border-border'}`}>
                              {inputType === 'percentage' ? '%' : '#'}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground">Group: {group?.name || '—'} · Weight: {p.weight} · {linkedServices} services linked</p>
                        </div>
                        <div className="flex items-center gap-1">
                          <button onClick={() => {
                            // Merge localStorage overrides so values are correct even pre-migration
                            let isMaster = p.is_master ?? false
                            let inputType = p.input_type ?? 'count'
                            try {
                              const meta = JSON.parse(localStorage.getItem('cirqle_param_meta') || '{}')
                              if (meta[p.id]) { isMaster = meta[p.id].is_master; inputType = meta[p.id].input_type }
                            } catch {}
                            setEditingId(p.id); setShowForm('param')
                            setForm({ ...p, is_master: isMaster, input_type: inputType })
                          }} className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground">
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => requestDelete('Parameter', p.id, p.name, async () => {
                            await deactivateParameter(p.id)
                            setParams(prev => prev.filter((x: any) => x.id !== p.id))
                          })} className="p-2 rounded-lg hover:bg-amber-500/15 text-muted-foreground hover:text-amber-400 transition-colors" title="Archive parameter">
                            <Archive className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Tools */}
          {tab === 'Tools' && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <h2 className="text-sm font-semibold">AI / Design Tools ({filteredTools.length}{toolSearch ? `/${tools.length}` : ''})</h2>
                  <button onClick={() => setQuickEdit(q => !q)}
                    className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border transition-all ${
                      quickEdit ? 'bg-amber-500/15 border-amber-500/30 text-amber-400' : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                    }`}>
                    <Zap className="w-3 h-3" /> {quickEdit ? 'Exit edit' : 'Quick edit'}
                  </button>
                </div>
                <button onClick={() => openForm('tool', { fixed_percentage: 10, is_active: true })} className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90">
                  <Plus className="w-4 h-4" /> Add Tool
                </button>
              </div>
              <SearchBar value={toolSearch} onChange={setToolSearch} placeholder="Search tools…" className="mb-3" />
              <div className="space-y-1.5">
                {filteredTools.map((tool: any) => {
                  const group = groups.find((g: any) => g.id === tool.group_id)
                  return quickEdit ? (
                    <div key={tool.id} className="bg-card border border-amber-500/20 rounded-xl px-3 py-2.5 flex items-center gap-2">
                      <input
                        key={`${tool.id}-name`}
                        defaultValue={tool.name}
                        onBlur={e => qeSave(quickEditTool, tool.id, 'name', e.target.value.trim(), setTools as any)}
                        className="flex-1 bg-secondary border border-border/0 hover:border-border focus:border-primary rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:bg-background transition-colors"
                        placeholder="Tool name"
                      />
                      <div className="flex items-center gap-1 shrink-0">
                        <span className="text-xs text-muted-foreground">Deducts</span>
                        <input
                          key={`${tool.id}-pct`}
                          defaultValue={tool.fixed_percentage}
                          type="number" min="0" max="100" step="0.1"
                          onBlur={e => qeSave(quickEditTool, tool.id, 'fixed_percentage', e.target.value, setTools as any, v => parseFloat(v) || 0)}
                          className="w-14 bg-secondary border border-border/0 hover:border-border focus:border-primary rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none focus:bg-background transition-colors"
                        />
                        <span className="text-xs text-muted-foreground">% from {group?.name || '—'}</span>
                      </div>
                      <button onClick={() => { setEditingId(tool.id); setShowForm('tool'); setForm(tool) }}
                        className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground/40 hover:text-foreground shrink-0">
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div key={tool.id} className="bg-card border border-border rounded-xl px-4 py-3 flex items-center justify-between">
                      <div>
                        <p className="font-medium text-sm">{tool.name}</p>
                        <p className="text-xs text-muted-foreground">Deducts {tool.fixed_percentage}% from {group?.name || '—'} group</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => { setEditingId(tool.id); setShowForm('tool'); setForm(tool) }}
                          className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground">
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => requestDelete('Tool', tool.id, tool.name, async () => {
                          await deactivateTool(tool.id)
                          setTools(prev => prev.filter((x: any) => x.id !== tool.id))
                        })} className="p-2 rounded-lg hover:bg-amber-500/15 text-muted-foreground hover:text-amber-400 transition-colors" title="Archive tool">
                          <Archive className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Bank Accounts */}
          {tab === 'Bank Accounts' && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold">Bank Accounts</h2>
                <button onClick={() => openForm('bank', { is_active: true, type: 'bank', currency: 'INR', opening_balance: 0 })} className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90">
                  <Plus className="w-4 h-4" /> Add Account
                </button>
              </div>
              <div className="space-y-2">
                {bankAccounts.filter(b => b.is_active !== false).map(b => (
                  <div key={b.id} className="bg-card border border-border rounded-xl px-4 py-3 flex items-center justify-between">
                    <div>
                      <p className="font-medium text-sm">{b.name}</p>
                      <p className="text-xs text-muted-foreground capitalize">{b.type} · {b.currency} · {b.account_number}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-2 py-0.5 rounded-md bg-green-500/15 text-green-400`}>Active</span>
                      <button onClick={() => { setEditingId(b.id); setShowForm('bank'); setForm(b) }} className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground">
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => requestDelete('Bank Account', b.id, b.name, async () => {
                        await deactivateBankAccount(b.id)
                        setBankAccounts(prev => prev.filter((x: any) => x.id !== b.id))
                      })} className="p-2 rounded-lg hover:bg-amber-500/15 text-muted-foreground hover:text-amber-400 transition-colors" title="Archive bank account">
                        <Archive className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Cash Categories */}
          {tab === 'Cash Categories' && (
            <div>
              <h2 className="text-sm font-semibold mb-4">Cash Book Categories ({categories.length})</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                {(['inflow', 'outflow', 'both'] as const).map(type => {
                  const styleMap: Record<string, { header: string; addBtn: string; dot: string }> = {
                    inflow:  { header: 'bg-green-500/10 text-green-400',  addBtn: 'hover:bg-green-500/15 hover:text-green-400', dot: 'bg-green-400' },
                    outflow: { header: 'bg-red-500/10 text-red-400',      addBtn: 'hover:bg-red-500/15 hover:text-red-400',    dot: 'bg-red-400' },
                    both:    { header: 'bg-blue-500/10 text-blue-400',    addBtn: 'hover:bg-blue-500/15 hover:text-blue-400',  dot: 'bg-blue-400' },
                  }
                  const s = styleMap[type]
                  const filtered = categories.filter((c: any) => c.type === type && c.is_active !== false)
                  return (
                    <div key={type} className="bg-card border border-border rounded-xl overflow-hidden flex flex-col">
                      <div className={`px-4 py-3 border-b border-border flex items-center justify-between ${s.header}`}>
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full ${s.dot}`} />
                          <span className="text-xs font-semibold uppercase tracking-wider capitalize">{type}</span>
                        </div>
                        <span className="text-xs opacity-60">{filtered.length} items</span>
                      </div>
                      <div className="divide-y divide-border flex-1">
                        {filtered.length === 0 && (
                          <p className="px-4 py-4 text-xs text-muted-foreground text-center">No categories yet</p>
                        )}
                        {filtered.map((c: any) => (
                          <div key={c.id} className="flex items-center justify-between px-4 py-2.5 group hover:bg-secondary/20">
                            <span className="text-sm">{c.name}</span>
                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={() => { setEditingId(c.id); setShowForm('category'); setForm(c) }}
                                className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => requestDelete('Category', c.id, c.name, async () => {
                                  await deactivateCashbookCategory(c.id)
                                  setCategories((prev: any[]) => prev.filter((x: any) => x.id !== c.id))
                                })}
                                title="Archive category (past entries are preserved)"
                                className="p-1.5 rounded-md hover:bg-amber-500/15 text-muted-foreground hover:text-amber-400"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                      {/* Per-column add button */}
                      <button
                        onClick={() => openForm('category', { type })}
                        className={`flex items-center gap-2 w-full px-4 py-3 text-xs text-muted-foreground border-t border-border transition-colors ${s.addBtn}`}
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Add {type} category
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Exchange Rates */}
          {tab === 'Exchange Rates' && (() => {
            const lastSync = rates.map(r => r.last_updated).filter(Boolean).sort().slice(-1)[0] as string | undefined
            return (
              <div className="max-w-lg">
                <div className="flex items-start justify-between gap-3 mb-1">
                  <div>
                    <h2 className="text-sm font-semibold">Exchange Rates (to INR)</h2>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Base currency <span className="font-medium text-foreground">INR</span> — used for all accounting &amp; reports.
                      These rates pre-fill new payments &amp; cashbook entries and can be overridden per transaction.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleSyncRates}
                    disabled={syncing}
                    className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border border-violet-500/30 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20 shrink-0 disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
                    {syncing ? 'Syncing…' : 'Sync now'}
                  </button>
                </div>

                <div className="flex items-center flex-wrap gap-x-4 gap-y-1 mb-4 text-xs text-muted-foreground">
                  {lastSync && <span>Last synced: {new Date(lastSync).toLocaleString('en-IN')}</span>}
                  {syncMsg && <span className="text-foreground">{syncMsg}</span>}
                  <label className="flex items-center gap-1.5 ml-auto whitespace-nowrap">
                    Auto-refresh every
                    <input
                      type="number" min="0" step="1"
                      defaultValue={companySettings['fx_auto_refresh_hours'] ?? '24'}
                      onBlur={e => saveSetting('fx_auto_refresh_hours', String(parseInt(e.target.value) || 0))}
                      className="w-14 bg-secondary border border-border rounded-md px-2 py-1 text-xs text-center focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                    h
                  </label>
                </div>

                <div className="space-y-2">
                  {CURRENCIES.map(currency => {
                    const existing = rates.find(r => r.currency === currency)
                    return (
                      <div key={currency} className="flex items-center gap-3">
                        <span className="text-sm font-medium w-12">{currency}</span>
                        <input
                          // Re-mount when the stored rate changes (e.g. after Sync) so the
                          // uncontrolled input picks up the new defaultValue.
                          key={`${currency}-${existing?.rate_to_inr ?? ''}-${existing?.last_updated ?? ''}`}
                          type="number" step="0.0001" min="0"
                          defaultValue={existing?.rate_to_inr || ''}
                          onBlur={e => saveRate(currency, parseFloat(e.target.value) || 0)}
                          className="flex-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                          placeholder="Rate to INR"
                        />
                        <div className="w-24 text-right shrink-0">
                          {existing ? (
                            <>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${existing.rate_source === 'api' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>
                                {existing.rate_source === 'api' ? 'API' : 'Manual'}
                              </span>
                              {existing.rate_date && <div className="text-[10px] text-muted-foreground mt-0.5">{existing.rate_date}</div>}
                            </>
                          ) : (
                            <span className="text-[10px] text-muted-foreground">not set</span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
                <p className="text-xs text-muted-foreground mt-3">Rates auto-save on blur — editing one marks it “Manual”. “Sync now” fetches live mid-market rates from the free FX API.</p>
              </div>
            )
          })()}

          {/* Pricing Matrix */}
          {tab === 'Pricing Matrix' && (() => {
            const allActiveClients = clients.filter((c: any) => c.is_active)
            const allActiveServices = services.filter((s: any) => s.is_active)
            if (allActiveClients.length === 0 || allActiveServices.length === 0) {
              return <p className="text-sm text-muted-foreground">Add clients and services first.</p>
            }
            // Apply search filters
            const activeClients = matrixClientSearch
              ? allActiveClients.filter((c: any) => c.name?.toLowerCase().includes(matrixClientSearch.toLowerCase()) || c.code?.toLowerCase().includes(matrixClientSearch.toLowerCase()))
              : allActiveClients
            const activeServices = matrixServiceSearch
              ? allActiveServices.filter((s: any) => s.name?.toLowerCase().includes(matrixServiceSearch.toLowerCase()))
              : allActiveServices
            return (
              <div>
                <div className="flex items-center gap-3 mb-4">
                  <div className="flex-1">
                    <h2 className="text-sm font-semibold mb-0.5">Pricing Matrix</h2>
                    <p className="text-xs text-muted-foreground">Click any cell to edit. Changes auto-save when you leave the field.</p>
                  </div>
                  {/* Maintenance action — applies this matrix to existing tasks. Hidden behind a button
                      because it's only used after bulk imports or matrix-wide price changes. */}
                  <button
                    type="button"
                    onClick={() => setShowRecalcModal(true)}
                    title="Apply the current Pricing Matrix to existing tasks (one-time / on-demand maintenance)"
                    className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border border-violet-500/30 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20 shrink-0"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Recalculate Task Billing
                  </button>
                </div>
                <div className="flex items-center gap-2 mb-3">
                  <SearchBar value={matrixClientSearch} onChange={setMatrixClientSearch} placeholder="Filter clients…" className="flex-1" />
                  <SearchBar value={matrixServiceSearch} onChange={setMatrixServiceSearch} placeholder="Filter services…" className="flex-1" />
                  {(matrixClientSearch || matrixServiceSearch) && (
                    <button type="button" onClick={() => { setMatrixClientSearch(''); setMatrixServiceSearch('') }}
                      className="text-xs text-muted-foreground hover:text-foreground px-2.5 py-1.5 rounded-lg bg-secondary border border-border shrink-0">
                      Clear
                    </button>
                  )}
                </div>
                <div className="overflow-auto rounded-xl border border-border max-h-[calc(100dvh-280px)]">
                  <table className="text-xs w-full border-collapse">
                    <thead className="sticky top-0 z-20">
                      <tr className="bg-secondary/90 backdrop-blur-sm border-b border-border">
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground sticky left-0 bg-secondary/90 min-w-[160px] z-30 border-r border-border">
                          Client
                        </th>
                        {activeServices.map((svc: any) => (
                          <th key={svc.id} className="px-3 py-3 font-semibold text-muted-foreground text-center min-w-[160px] border-r border-border last:border-r-0 bg-secondary/90">
                            {svc.name}
                          </th>
                        ))}
                      </tr>
                      <tr className="bg-secondary/60 backdrop-blur-sm border-b border-border">
                        <th className="sticky left-0 bg-secondary/60 border-r border-border z-30 py-1.5 px-4">
                          <span className="text-[10px] text-muted-foreground/40 uppercase tracking-wider font-semibold">
                            {activeClients.length}{matrixClientSearch ? `/${allActiveClients.length}` : ''} clients
                          </span>
                        </th>
                        {activeServices.map((svc: any) => (
                          <th key={svc.id} className="border-r border-border last:border-r-0 bg-secondary/60">
                            <div className="grid grid-cols-2 divide-x divide-border">
                              <span className="px-2 py-1.5 text-muted-foreground/60 font-semibold text-center text-[10px] uppercase tracking-wide">Price</span>
                              <span className="px-2 py-1.5 text-muted-foreground/60 font-semibold text-center text-[10px] uppercase tracking-wide">Comm%</span>
                            </div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {activeClients.map((client: any) => (
                        <tr key={client.id} className="hover:bg-secondary/10 group">
                          <td className="px-4 py-2.5 sticky left-0 bg-card group-hover:bg-secondary/10 border-r border-border z-10">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-primary font-semibold">{client.code}</span>
                              <span className="text-foreground truncate max-w-[90px]">{client.name}</span>
                            </div>
                          </td>
                          {activeServices.map((svc: any) => {
                            const key = `${client.id}::${svc.id}`
                            const cell = matrix[key] || { price: '', commission_percentage: '', currency: client.default_currency || 'INR' }
                            const isSaving = matrixSaving === key
                            return (
                              <td key={svc.id} className={`border-r border-border last:border-r-0 p-0 ${isSaving ? 'bg-primary/5' : ''}`}>
                                <div className="grid grid-cols-2 divide-x divide-border">
                                  <input
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    value={cell.price}
                                    onChange={e => updateMatrix(client.id, svc.id, 'price', e.target.value)}
                                    onBlur={e => { if (e.target.value !== '') saveMatrixCell(client.id, svc.id, { ...cell, price: e.target.value }) }}
                                    placeholder="—"
                                    className="w-full bg-transparent px-2 py-2.5 text-center focus:outline-none focus:bg-primary/10 placeholder-muted-foreground/30 transition-colors"
                                  />
                                  <div className="relative">
                                    <input
                                      type="number"
                                      min="0"
                                      max="100"
                                      step="0.1"
                                      value={cell.commission_percentage}
                                      onChange={e => updateMatrix(client.id, svc.id, 'commission_percentage', e.target.value)}
                                      onBlur={e => { if (e.target.value !== '') saveMatrixCell(client.id, svc.id, { ...cell, commission_percentage: e.target.value }) }}
                                      placeholder="—"
                                      className="w-full bg-transparent px-2 py-2.5 text-center focus:outline-none focus:bg-primary/10 placeholder-muted-foreground/30 transition-colors pr-5"
                                    />
                                    {cell.commission_percentage && <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 pointer-events-none">%</span>}
                                  </div>
                                </div>
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-muted-foreground mt-3">Price is billed amount per creative / per unit. Commission % is what comes off the top before employee calculation.</p>

                {/* One-off maintenance modal — applies the matrix to existing tasks */}
                <RecalcBillingModal
                  open={showRecalcModal}
                  onClose={() => setShowRecalcModal(false)}
                  clients={props.clients}
                  services={props.services}
                  clientPricings={clientPricingsArray}
                />
              </div>
            )
          })()}

          {/* Privacy & Security */}
          {tab === 'Privacy & Security' && (
            <div className="space-y-6">
              {/* Status card */}
              <div className={`rounded-xl border p-5 flex items-start gap-4 ${isUnlocked ? 'bg-green-500/5 border-green-500/20' : 'bg-secondary border-border'}`}>
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${isUnlocked ? 'gradient-bg' : 'bg-card border border-border'}`}>
                  {isUnlocked ? <ShieldCheck className="w-5 h-5 text-white" /> : <Lock className="w-5 h-5 text-muted-foreground" />}
                </div>
                <div className="flex-1">
                  <p className="font-semibold text-sm">{isUnlocked ? 'Privacy Unlocked' : 'Privacy Locked'}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {isUnlocked
                      ? 'Employee names and emails are currently visible across the app.'
                      : 'Employee names and emails are hidden. Only CQIDs are shown across the app. Admin must unlock with the privacy PIN to see real names.'}
                  </p>
                </div>
              </div>

              {/* PIN management */}
              <div className="bg-card border border-border rounded-xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="font-semibold text-sm">Privacy PIN</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {getStoredPin() ? 'A PIN is set. You can change it below.' : 'No PIN set yet — anyone can unlock. Create a PIN to protect employee names.'}
                    </p>
                  </div>
                  <button type="button" onClick={() => { setShowPinFields(s => !s); setPinMsg(null) }}
                    className="text-xs text-muted-foreground hover:text-foreground border border-border rounded-lg px-3 py-1.5 hover:bg-secondary transition-colors">
                    {showPinFields ? 'Cancel' : getStoredPin() ? 'Change PIN' : 'Create PIN'}
                  </button>
                </div>

                {showPinFields && (
                  <form onSubmit={handleSavePin} className="space-y-3 border-t border-border pt-4">
                    {getStoredPin() && (
                      <div>
                        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Current PIN</label>
                        <input type="password" value={pinForm.current}
                          onChange={e => setPinForm(f => ({ ...f, current: e.target.value }))}
                          className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm tracking-widest focus:outline-none focus:ring-2 focus:ring-primary/50"
                          placeholder="Enter current PIN" />
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">New PIN</label>
                        <input type="password" value={pinForm.next}
                          onChange={e => setPinForm(f => ({ ...f, next: e.target.value }))}
                          className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm tracking-widest focus:outline-none focus:ring-2 focus:ring-primary/50"
                          placeholder="Min. 4 characters" />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Confirm New PIN</label>
                        <input type="password" value={pinForm.confirm}
                          onChange={e => setPinForm(f => ({ ...f, confirm: e.target.value }))}
                          className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm tracking-widest focus:outline-none focus:ring-2 focus:ring-primary/50"
                          placeholder="Repeat new PIN" />
                      </div>
                    </div>
                    {pinMsg && (
                      <p className={`text-xs px-3 py-2 rounded-lg border ${pinMsg.type === 'ok' ? 'text-green-400 bg-green-500/10 border-green-500/20' : 'text-red-400 bg-red-500/10 border-red-500/20'}`}>
                        {pinMsg.text}
                      </p>
                    )}
                    <button type="submit"
                      className="gradient-bg text-white text-sm font-medium px-5 py-2 rounded-lg hover:opacity-90 transition-opacity">
                      Save PIN
                    </button>
                  </form>
                )}

                {pinMsg && !showPinFields && (
                  <p className={`text-xs px-3 py-2 rounded-lg border mt-2 ${pinMsg.type === 'ok' ? 'text-green-400 bg-green-500/10 border-green-500/20' : 'text-red-400 bg-red-500/10 border-red-500/20'}`}>
                    {pinMsg.text}
                  </p>
                )}
              </div>

              {/* Force Lock toggle */}
              <div className="bg-card border border-border rounded-xl p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-sm flex items-center gap-2">
                      <Lock className="w-4 h-4 text-amber-400" /> Always-locked mode
                    </h3>
                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                      When enabled, employee names are always hidden across the app regardless of PIN unlock. Disable to allow temporary unlocks.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const next = !forceLockState
                      setForceLockState(next)
                      setForceLockMode(next)
                    }}
                    role="switch"
                    aria-checked={forceLockState}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50 ${forceLockState ? 'bg-amber-500' : 'bg-secondary'}`}
                  >
                    <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${forceLockState ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </div>
                {forceLockState && (
                  <p className="text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/20 px-3 py-2 rounded-lg mt-3">
                    Privacy enforcement is active. Names cannot be unlocked until this is disabled.
                  </p>
                )}
              </div>

              {/* What is protected */}
              <div className="bg-card border border-border rounded-xl p-5">
                <h3 className="font-semibold text-sm mb-3">What is protected?</h3>
                <div className="space-y-2 text-xs">
                  {[
                    { icon: '👤', label: 'Employee full names', locked: true },
                    { icon: '📧', label: 'Employee email addresses', locked: true },
                    { icon: '🪪', label: 'CQID codes (always visible)', locked: false },
                    { icon: '💰', label: 'Financial data (billing, earnings)', locked: false, note: 'Controlled by Admin view toggle' },
                  ].map(item => (
                    <div key={item.label} className="flex items-center gap-3 py-1.5 border-b border-border/50 last:border-0">
                      <span className="text-base">{item.icon}</span>
                      <span className="flex-1 text-muted-foreground">{item.label}</span>
                      {item.note
                        ? <span className="text-[10px] text-muted-foreground/50 italic">{item.note}</span>
                        : item.locked
                          ? <span className="text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded flex items-center gap-1"><Lock className="w-2.5 h-2.5" /> PIN required</span>
                          : <span className="text-[10px] text-green-400 bg-green-500/10 border border-green-500/20 px-1.5 py-0.5 rounded">Always visible</span>
                      }
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === 'Message Templates' && (
            <MessageTemplatesTab
              companySettings={companySettings}
              setCompanySettings={setCompanySettings}
              saveCompanySettings={saveCompanySettings}
              saving={saving}
            />
          )}
        </div>
      </div>

      {/* Modal Forms */}
      {showForm && (
        <ModalOverlay onClose={() => (showForm === 'client' || showForm === 'service') ? closeForm() : setShowForm(null)}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-card rounded-t-2xl">
              <div>
                {props.returnTo && (showForm === 'client' || showForm === 'service') && (
                  <button type="button" onClick={closeForm} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-1 transition-colors">
                    <ChevronLeft className="w-3 h-3" />
                    Back to {props.returnTo.split('/').pop()}
                  </button>
                )}
                <h2 className="font-semibold capitalize">{editingId ? 'Edit' : 'Add'} {showForm}</h2>
              </div>
              <button onClick={() => (showForm === 'client' || showForm === 'service') ? closeForm() : setShowForm(null)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>

            <form onSubmit={
              showForm === 'employee' ? saveEmployee :
              showForm === 'client' ? saveClient :
              showForm === 'service' ? saveService :
              showForm === 'group' ? saveGroup :
              showForm === 'param' ? saveParam :
              showForm === 'tool' ? saveTool :
              showForm === 'category' ? saveCategory :
              saveBank
            } className="p-6 space-y-4">

              {/* Employee form */}
              {showForm === 'employee' && (
                <>
                  <FieldRow label="Employee ID (CQID)">
                    <div className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm font-mono font-bold text-primary">{form.cqid || '—'}</div>
                  </FieldRow>
                  <FieldRow label="Full Name" required><input value={form.name || ''} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} required className={inputCls} /></FieldRow>
                  <div className="grid grid-cols-2 gap-3">
                    <FieldRow label="Email"><input type="email" value={form.email || ''} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} className={inputCls} /></FieldRow>
                    <FieldRow label="Phone"><input value={form.phone || ''} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} className={inputCls} /></FieldRow>
                  </div>
                  <FieldRow label={<span className="flex items-center gap-1">Date of Birth <InfoTip text="Used to show a celebration on their birthday. Optional but recommended." /></span>}>
                    <input
                      type="date"
                      value={form.date_of_birth || ''}
                      onChange={e => setForm(p => ({ ...p, date_of_birth: e.target.value || null }))}
                      max={new Date().toISOString().slice(0, 10)}
                      className={inputCls}
                    />
                  </FieldRow>
                  <div className="border-t border-border pt-3">
                    <p className="text-xs font-medium text-muted-foreground mb-2">Emergency Contact</p>
                    <div className="grid grid-cols-2 gap-3">
                      <FieldRow label="Contact Name"><input value={form.emergency_contact_name || ''} onChange={e => setForm(p => ({ ...p, emergency_contact_name: e.target.value }))} className={inputCls} placeholder="Name" /></FieldRow>
                      <FieldRow label="Contact Phone"><input value={form.emergency_contact_phone || ''} onChange={e => setForm(p => ({ ...p, emergency_contact_phone: e.target.value }))} className={inputCls} placeholder="Phone" /></FieldRow>
                    </div>
                  </div>
                  {/* Designation — new permission system. Shown when designations table is loaded. */}
                  {props.designations && props.designations.length > 0 && (
                    <FieldRow label={<span className="flex items-center gap-1">Designation <InfoTip text="Controls what this employee can see and do. Configure designations in Settings → Designations." /></span>}>
                      <AppSelect value={form.designation_id || ''} onChange={e => setForm(p => ({ ...p, designation_id: e.target.value || null }))}>
                        <option value="">— select designation —</option>
                        {props.designations.map(d => (
                          <option key={d.id} value={d.id}>
                            {d.name}{d.is_admin ? ' (Admin — full access)' : ''}{d.is_system ? '' : ''}
                          </option>
                        ))}
                      </AppSelect>
                    </FieldRow>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <FieldRow label={<span className="flex items-center">Role (legacy) <InfoTip text="Legacy role — kept for compatibility. Designation above is now the source of truth." /></span>}>
                      <AppSelect value={form.role || 'employee'} onChange={e => setForm(p => ({ ...p, role: e.target.value }))}>
                        <option value="super_admin">Super Admin (Owner/MD)</option>
                        <option value="accounts">Accounts</option>
                        <option value="team_lead">Team Lead</option>
                        <option value="employee">Employee</option>
                        <option value="view_only">View Only</option>
                      </AppSelect>
                    </FieldRow>
                    <FieldRow label={<span className="flex items-center">Salary Type <InfoTip text="fixed: monthly fixed amount · commission only: earns % on jobs only · fixed + commission: base salary + % on jobs" /></span>}>
                      <AppSelect value={form.salary_type || 'fixed'} onChange={e => setForm(p => ({ ...p, salary_type: e.target.value }))}>
                        <option value="fixed">Fixed (Monthly)</option>
                        <option value="commission_only">Commission Only</option>
                        <option value="fixed_plus_commission">Fixed + Commission</option>
                      </AppSelect>
                    </FieldRow>
                  </div>
                  <div className="grid grid-cols-2 gap-3 items-end">
                    <FieldRow label="Base Salary (₹)"><input type="number" min="0" step="0.01" value={form.base_salary || ''} onChange={e => setForm(p => ({ ...p, base_salary: parseFloat(e.target.value) || 0 }))} className={inputCls} placeholder="0" /></FieldRow>
                    <FieldRow label="Performance Rating (%)">
                      <div className="flex gap-2">
                        <input type="number" min="0" max="100" step="1" value={form.performance_rating || ''} onChange={e => setForm(p => ({ ...p, performance_rating: parseFloat(e.target.value) || 0 }))} className={inputCls} placeholder="70" />
                        {editingId && (
                          <button
                            type="button"
                            onClick={() => setShowHistoryModal(form)}
                            className="bg-secondary hover:bg-secondary/80 text-muted-foreground hover:text-foreground border border-border rounded-lg px-3 flex items-center justify-center transition-colors flex-shrink-0"
                            title="Performance History Register"
                          >
                            <CalendarDays className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </FieldRow>
                  </div>
                  <FieldRow label={<span className="flex items-center gap-1">Salary Day <InfoTip text="Day of the month salary is paid. e.g. 1 = 1st of every month, 5 = 5th of every month." /></span>}>
                    <div className="w-full relative">
                      {/* Trigger button */}
                      <button
                        type="button"
                        onClick={() => setSalaryDayCalOpen(o => !o)}
                        className="w-full flex items-center justify-between bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none hover:border-border/80 transition-colors"
                      >
                        <span className="flex items-center gap-2">
                          <CalendarDays className="w-4 h-4 text-muted-foreground" />
                          <span className="font-medium">
                            {(() => {
                              const d = form.salary_day || 1
                              const sfx = d === 1 || d === 21 || d === 31 ? 'st' : d === 2 || d === 22 ? 'nd' : d === 3 || d === 23 ? 'rd' : 'th'
                              return `${d}${sfx} of every month`
                            })()}
                          </span>
                        </span>
                        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${salaryDayCalOpen ? 'rotate-180' : ''}`} />
                      </button>

                      {/* Calendar dropdown */}
                      {salaryDayCalOpen && (
                        <div className="absolute top-full left-0 mt-1.5 z-50 bg-secondary border border-foreground/20 rounded-2xl shadow-2xl p-3 w-72">
                          {/* Month navigation */}
                          <div className="flex items-center justify-between mb-3 px-1">
                            <button type="button"
                              onClick={() => setSalaryCalViewDate(d => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
                              className="p-1 rounded-lg hover:bg-foreground/[0.06] text-muted-foreground hover:text-foreground transition-colors">
                              <ChevronLeft className="w-4 h-4" />
                            </button>
                            <span className="text-sm font-semibold">
                              {salaryCalViewDate.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
                            </span>
                            <button type="button"
                              onClick={() => setSalaryCalViewDate(d => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
                              className="p-1 rounded-lg hover:bg-foreground/[0.06] text-muted-foreground hover:text-foreground transition-colors">
                              <ChevronRight className="w-4 h-4" />
                            </button>
                          </div>

                          {/* Weekday headers */}
                          <div className="grid grid-cols-7 mb-1">
                            {['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => (
                              <div key={d} className="h-7 flex items-center justify-center text-[10px] font-semibold text-muted-foreground">{d}</div>
                            ))}
                          </div>

                          {/* Day grid */}
                          {(() => {
                            const year = salaryCalViewDate.getFullYear()
                            const month = salaryCalViewDate.getMonth()
                            const firstDay = new Date(year, month, 1).getDay()
                            const daysInMonth = new Date(year, month + 1, 0).getDate()
                            const cells: (number | null)[] = [
                              ...Array(firstDay).fill(null),
                              ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
                            ]
                            // Pad to full weeks
                            while (cells.length % 7 !== 0) cells.push(null)
                            return (
                              <div className="grid grid-cols-7 gap-0.5">
                                {cells.map((day, i) => {
                                  const isSelected = day === (form.salary_day || 1)
                                  return (
                                    <button
                                      key={i}
                                      type="button"
                                      disabled={!day}
                                      onClick={() => {
                                        if (!day) return
                                        setForm(p => ({ ...p, salary_day: day }))
                                        setSalaryDayCalOpen(false)
                                      }}
                                      className={`h-8 w-full rounded-lg text-xs font-medium transition-colors ${
                                        !day ? 'invisible' :
                                        isSelected
                                          ? 'gradient-bg text-white shadow-sm'
                                          : 'hover:bg-foreground/[0.08] text-muted-foreground hover:text-foreground'
                                      }`}
                                    >
                                      {day}
                                    </button>
                                  )
                                })}
                              </div>
                            )
                          })()}

                          {/* Footer hint */}
                          <p className="text-[10px] text-muted-foreground text-center mt-3 pt-2 border-t border-foreground/15">
                            Salary paid on the <span className="text-foreground font-semibold">{form.salary_day || 1}{
                              (() => { const d = form.salary_day||1; return d===1||d===21||d===31?'st':d===2||d===22?'nd':d===3||d===23?'rd':'th' })()
                            }</span> of each month
                          </p>
                        </div>
                      )}
                    </div>
                  </FieldRow>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={form.is_active !== false} onChange={e => setForm(p => ({ ...p, is_active: e.target.checked }))} className="w-4 h-4 accent-purple-500" />
                    <span className="text-sm">Active</span>
                  </label>
                </>
              )}

              {/* Client form */}
              {showForm === 'client' && (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2">
                      <FieldRow label="Client Name" required><input value={form.name || ''} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} required className={inputCls} /></FieldRow>
                    </div>
                    <FieldRow label="Client Code">
                      <div className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm font-mono font-bold text-primary">{form.code || '—'}</div>
                    </FieldRow>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <FieldRow label="Email"><input type="email" value={form.email || ''} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} className={inputCls} /></FieldRow>
                    <FieldRow label="Phone"><input value={form.phone || ''} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} className={inputCls} /></FieldRow>
                  </div>
                  <FieldRow label="Address"><textarea value={form.address || ''} onChange={e => setForm(p => ({ ...p, address: e.target.value }))} rows={2} className={inputCls + ' resize-none'} /></FieldRow>
                  <div className="grid grid-cols-2 gap-3">
                    <FieldRow label="Country"><input value={form.country || ''} onChange={e => setForm(p => ({ ...p, country: e.target.value }))} className={inputCls} placeholder="India" /></FieldRow>
                    <FieldRow label="Default Currency">
                      <AppSelect value={form.default_currency || 'INR'} onChange={e => setForm(p => ({ ...p, default_currency: e.target.value }))}>
                        {['INR', ...CURRENCIES].map(c => <option key={c} value={c}>{c}</option>)}
                      </AppSelect>
                    </FieldRow>
                  </div>

                  {/* Billing Cycle */}
                  <div className="border-t border-border pt-4 space-y-3">
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Invoice Billing Cycle</p>
                      <p className="text-xs text-muted-foreground mt-0.5">How often auto-invoices are generated for this client</p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <FieldRow label="Billing Cycle">
                        <AppSelect
                          value={form.billing_cycle || 'monthly'}
                          onChange={e => setForm(p => ({ ...p, billing_cycle: e.target.value }))}
                        >
                          <option value="monthly">📅 Monthly</option>
                          <option value="weekly">📆 Weekly</option>
                          <option value="daily">🗓️ Daily</option>
                          <option value="none">🚫 Manual Only</option>
                        </AppSelect>
                      </FieldRow>
                      {(form.billing_cycle === 'monthly' || !form.billing_cycle) && (
                        <FieldRow label="Invoice Day of Month">
                          <input
                            type="number" min="1" max="28"
                            value={form.billing_day || 1}
                            onChange={e => setForm(p => ({ ...p, billing_day: parseInt(e.target.value) || 1 }))}
                            className={inputCls}
                            placeholder="1"
                          />
                        </FieldRow>
                      )}
                      {form.billing_cycle === 'weekly' && (
                        <FieldRow label="Invoice Day of Week">
                          <AppSelect
                            value={form.billing_day ?? 1}
                            onChange={e => setForm(p => ({ ...p, billing_day: parseInt(e.target.value) }))}
                          >
                            {['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((d, i) => (
                              <option key={i} value={i}>{d}</option>
                            ))}
                          </AppSelect>
                        </FieldRow>
                      )}
                    </div>
                    {form.billing_cycle === 'none' && (
                      <p className="text-xs text-amber-400/80 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                        ⚠️ No invoices will be auto-generated. Use "Generate Invoice" in the Invoices page to create them manually.
                      </p>
                    )}
                  </div>

                  {/* Service Pricing */}
                  {services.length > 0 && (
                    <div className="border-t border-border pt-4 space-y-3">
                      <p className="text-xs font-medium text-muted-foreground">Services this client uses</p>

                      {/* Selected tags row */}
                      {selectedClientServices.size > 0 && (
                        <div className="flex flex-wrap gap-1.5 p-2.5 bg-secondary/40 rounded-lg border border-border min-h-[36px]">
                          {servicesSortedByUsage.filter((s: any) => selectedClientServices.has(s.id)).map((svc: any) => (
                            <span key={svc.id} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-0.5 rounded-full text-xs font-medium bg-primary/15 text-primary border border-primary/25">
                              {svc.name}
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedClientServices(prev => { const n = new Set(prev); n.delete(svc.id); return n })
                                  setClientPricings(p => { const n = { ...p }; delete n[svc.id]; return n })
                                }}
                                className="w-4 h-4 rounded-full flex items-center justify-center hover:bg-primary/20 text-primary/70 hover:text-primary transition-colors"
                              >×</button>
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Search + dropdown list */}
                      <div className="relative">
                        <input
                          type="text"
                          value={clientFormServiceSearch}
                          onChange={e => setClientFormServiceSearch(e.target.value)}
                          placeholder="Search and add services…"
                          className={inputCls + ' pl-8 text-sm'}
                        />
                        <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                        {(() => {
                          const filtered = servicesSortedByUsage.filter((s: any) =>
                            s.is_active &&
                            !selectedClientServices.has(s.id) &&
                            (!clientFormServiceSearch || s.name.toLowerCase().includes(clientFormServiceSearch.toLowerCase()))
                          )
                          if (!clientFormServiceSearch && filtered.length === servicesSortedByUsage.filter((s: any) => s.is_active && !selectedClientServices.has(s.id)).length) return null
                          return filtered.length > 0 ? (
                            <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-xl z-20 max-h-48 overflow-y-auto">
                              {filtered.map(svc => (
                                <button
                                  key={svc.id}
                                  type="button"
                                  onClick={() => {
                                    setSelectedClientServices(prev => new Set([...prev, svc.id]))
                                    setClientPricings(p => ({ ...p, [svc.id]: p[svc.id] || { price: '', commission_percentage: '', currency: form.default_currency || 'INR' } }))
                                    setClientFormServiceSearch('')
                                  }}
                                  className="w-full text-left px-3 py-2 text-sm hover:bg-secondary/60 transition-colors flex items-center gap-2"
                                >
                                  <span className="text-primary text-xs">+</span> {svc.name}
                                </button>
                              ))}
                            </div>
                          ) : clientFormServiceSearch ? (
                            <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-xl z-20 px-3 py-2 text-xs text-muted-foreground">No matching services</div>
                          ) : null
                        })()}
                      </div>

                      {/* Unselected quick-add row — top 8 by usage, not yet selected */}
                      {!clientFormServiceSearch && selectedClientServices.size < servicesSortedByUsage.filter((s: any) => s.is_active).length && (
                        <div className="flex flex-wrap gap-1.5">
                          {servicesSortedByUsage.filter((s: any) => s.is_active && !selectedClientServices.has(s.id)).slice(0, 8).map((svc: any) => (
                            <button
                              key={svc.id}
                              type="button"
                              onClick={() => {
                                setSelectedClientServices(prev => new Set([...prev, svc.id]))
                                setClientPricings(p => ({ ...p, [svc.id]: p[svc.id] || { price: '', commission_percentage: '', currency: form.default_currency || 'INR' } }))
                              }}
                              className="px-2.5 py-1 rounded-full text-xs text-muted-foreground bg-secondary border border-transparent hover:border-border hover:text-foreground transition-colors"
                            >+ {svc.name}</button>
                          ))}
                          {servicesSortedByUsage.filter((s: any) => s.is_active && !selectedClientServices.has(s.id)).length > 8 && (
                            <span className="px-2.5 py-1 text-xs text-muted-foreground">+{servicesSortedByUsage.filter((s: any) => s.is_active && !selectedClientServices.has(s.id)).length - 8} more — use search</span>
                          )}
                        </div>
                      )}

                      {/* Pricing fields — only for selected services */}
                      {selectedClientServices.size > 0 && (
                        <div className="space-y-2 pt-1">
                          <p className="text-xs text-muted-foreground font-medium">Pricing for selected services</p>
                          {servicesSortedByUsage.filter((s: any) => selectedClientServices.has(s.id)).map((svc: any) => {
                            const p = clientPricings[svc.id] || { price: '', commission_percentage: '', currency: form.default_currency || 'INR' }
                            return (
                              <div key={svc.id} className="bg-secondary/40 rounded-lg px-3 py-2.5">
                                <p className="text-xs font-medium mb-2 text-foreground">{svc.name}</p>
                                <div className="grid grid-cols-3 gap-2">
                                  <div>
                                    <label className="block text-xs text-muted-foreground mb-1">Price</label>
                                    <input type="number" min="0" step="0.01" value={p.price}
                                      onChange={e => setClientPricings(prev => ({ ...prev, [svc.id]: { ...p, price: e.target.value } }))}
                                      className={inputCls + ' text-xs py-1.5'} placeholder={svc.default_price ? String(svc.default_price) : '0.00'} />
                                  </div>
                                  <div>
                                    <label className="block text-xs text-muted-foreground mb-1">Commission %</label>
                                    <input type="number" min="0" max="100" step="0.1" value={p.commission_percentage}
                                      onChange={e => setClientPricings(prev => ({ ...prev, [svc.id]: { ...p, commission_percentage: e.target.value } }))}
                                      className={inputCls + ' text-xs py-1.5'} placeholder="0" />
                                  </div>
                                  <div>
                                    <label className="block text-xs text-muted-foreground mb-1">Currency</label>
                                    <AppSelect value={p.currency || form.default_currency || 'INR'}
                                      onChange={e => setClientPricings(prev => ({ ...prev, [svc.id]: { ...p, currency: e.target.value } }))}>
                                      {['INR', ...CURRENCIES].map(c => <option key={c} value={c}>{c}</option>)}
                                    </AppSelect>
                                  </div>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* Service form */}
              {showForm === 'service' && (
                <>
                  <FieldRow label="Service Name" required><input value={form.name || ''} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} required className={inputCls} /></FieldRow>

                  {/* Contribution Groups */}
                  <FieldRow label={<span className="flex items-center gap-1">Contribution Groups <InfoTip text="Select which groups apply to this service. Only selected groups will appear in the Contribution Entry screen for tasks of this service type." /></span>}>
                    <div className="space-y-2">
                      {groups.map((g: any) => {
                        const selected: string[] = form._groupIds || []
                        const isSelected = selected.includes(g.id)
                        return (
                          <button key={g.id} type="button"
                            onClick={() => {
                              const next = isSelected
                                ? selected.filter((id: string) => id !== g.id)
                                : [...selected, g.id]
                              setForm((p: any) => ({ ...p, _groupIds: next }))
                            }}
                            className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border text-sm transition-all ${
                              isSelected
                                ? 'bg-primary/10 border-primary/30 text-foreground'
                                : 'bg-secondary border-transparent text-muted-foreground hover:border-border'
                            }`}>
                            <div className="text-left">
                              <p className="font-medium">{g.name}</p>
                              <p className="text-xs opacity-60">Weight: {g.weight}%</p>
                            </div>
                            <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-all ${
                              isSelected ? 'border-primary bg-primary' : 'border-muted-foreground/30'
                            }`}>
                              {isSelected && <span className="text-white text-xs font-bold">✓</span>}
                            </div>
                          </button>
                        )
                      })}
                      {(form._groupIds || []).length === 0 && (
                        <p className="text-xs text-amber-400 mt-1">⚠ No groups selected — all groups will show for this service.</p>
                      )}
                    </div>
                  </FieldRow>

                  <FieldRow label={<span className="flex items-center">Pricing Type <InfoTip text="How this service is billed to clients." /></span>}>
                    <AppSelect value={form.pricing_type || 'fixed_per_creative'} onChange={e => setForm(p => ({ ...p, pricing_type: e.target.value }))}>
                      <option value="fixed_per_creative">Fixed per Creative</option>
                      <option value="percentage_of_spend">% of Client Spend</option>
                      <option value="retainer">Retainer (Monthly)</option>
                      <option value="hourly">Hourly</option>
                    </AppSelect>
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      {(form.pricing_type || 'fixed_per_creative') === 'fixed_per_creative' && '💡 Fixed price per deliverable — e.g. ₹500 × 3 flyers = ₹1,500.'}
                      {form.pricing_type === 'percentage_of_spend' && '💡 You earn a % of what the client spends — e.g. 30% × ₹1,000 ad budget = ₹300. Default price = your % rate.'}
                      {form.pricing_type === 'retainer' && '💡 Client pays a fixed monthly fee regardless of how many creatives are made.'}
                      {form.pricing_type === 'hourly' && '💡 Charge based on hours spent — e.g. ₹200/hr × 5 hours = ₹1,000. Default price = your hourly rate.'}
                    </p>
                  </FieldRow>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2">
                      <FieldRow label="Default Price">
                        <input type="number" min="0" step="0.01" value={form.default_price || ''} onChange={e => setForm(p => ({ ...p, default_price: parseFloat(e.target.value) || 0 }))} className={inputCls} placeholder="0.00" />
                      </FieldRow>
                    </div>
                    <FieldRow label="Currency">
                      <AppSelect value={form.default_currency || 'INR'} onChange={e => setForm(p => ({ ...p, default_currency: e.target.value }))}>
                        {['INR','AED','SAR','USD','QAR','GBP','EUR'].map(c => <option key={c} value={c}>{c}</option>)}
                      </AppSelect>
                    </FieldRow>
                  </div>
                  <FieldRow label="Active">
                    <AppSelect value={form.is_active === false ? 'false' : 'true'} onChange={e => setForm(p => ({ ...p, is_active: e.target.value === 'true' }))}>
                      <option value="true">Active</option>
                      <option value="false">Inactive</option>
                    </AppSelect>
                  </FieldRow>
                  <FieldRow label={<span className="flex items-center">Intake Form <InfoTip text="Which client-facing form this service exposes. A client's available request/intake forms are derived from the services assigned to them." /></span>}>
                    <AppSelect value={form.intake_kind || 'none'} onChange={e => setForm(p => ({ ...p, intake_kind: e.target.value }))}>
                      {INTAKE_KINDS.map(k => <option key={k} value={k}>{INTAKE_KIND_META[k].label}</option>)}
                    </AppSelect>
                    <p className="mt-1.5 text-xs text-muted-foreground">{INTAKE_KIND_META[(form.intake_kind as string) || 'none']?.description}</p>
                  </FieldRow>
                  <FieldRow label="Description"><textarea value={form.description || ''} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} rows={2} className={inputCls + ' resize-none'} placeholder="Optional notes about this service" /></FieldRow>
                </>
              )}

              {/* Group form */}
              {showForm === 'group' && (
                <>
                  <FieldRow label="Group Name" required><input value={form.name || ''} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} required className={inputCls} /></FieldRow>
                  <div className="grid grid-cols-2 gap-3">
                    <FieldRow label="Weight (%)"><input type="number" min="0" max="100" step="0.01" value={form.weight || ''} onChange={e => setForm(p => ({ ...p, weight: parseFloat(e.target.value) || 0 }))} className={inputCls} placeholder="e.g. 50" /></FieldRow>
                    <FieldRow label="Display Order"><input type="number" min="1" value={form.display_order || ''} onChange={e => setForm(p => ({ ...p, display_order: parseInt(e.target.value) || 1 }))} className={inputCls} /></FieldRow>
                  </div>
                  <FieldRow label="Description"><textarea value={form.description || ''} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} rows={2} className={inputCls + ' resize-none'} /></FieldRow>
                </>
              )}

              {/* Parameter form */}
              {showForm === 'param' && (
                <>
                  <FieldRow label="Parameter Name" required><input value={form.name || ''} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} required className={inputCls} /></FieldRow>
                  <FieldRow label="Group">
                    <AppSelect value={form.group_id || ''} onChange={e => setForm(p => ({ ...p, group_id: e.target.value }))}>
                      <option value="">Select group</option>
                      {groups.map((g: any) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </AppSelect>
                  </FieldRow>

                  {/* Master + Input Type side by side */}
                  <div className="grid grid-cols-2 gap-3">
                    <FieldRow label={<span className="flex items-center gap-1">Main Contribution? <InfoTip text="Mark this as the primary parameter for its group (e.g. Design, Products). Each group should have exactly one master parameter." /></span>}>
                      <button type="button"
                        onClick={() => setForm((p: any) => ({ ...p, is_master: !p.is_master }))}
                        className={`w-full flex items-center justify-between px-3 py-2 rounded-lg border text-sm font-medium transition-all ${
                          form.is_master
                            ? 'bg-purple-500/15 border-purple-500/30 text-purple-300'
                            : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                        }`}>
                        <span>{form.is_master ? '✓ Yes — Master' : 'No — Sub-param'}</span>
                        <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${form.is_master ? 'border-purple-400 bg-purple-400' : 'border-muted-foreground'}`}>
                          {form.is_master && <span className="w-2 h-2 rounded-full bg-white" />}
                        </span>
                      </button>
                    </FieldRow>

                    <FieldRow label={<span className="flex items-center gap-1">Input Type <InfoTip text="Percentage (0–100%): for effort-based params like Design. Count (#): for item/revision counts like Products, Date Change." /></span>}>
                      <div className="flex gap-2">
                        <button type="button"
                          onClick={() => setForm((p: any) => ({ ...p, input_type: 'percentage' }))}
                          className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-all ${
                            (form.input_type || 'count') === 'percentage'
                              ? 'bg-blue-500/15 border-blue-500/30 text-blue-300'
                              : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                          }`}>
                          % Percentage
                        </button>
                        <button type="button"
                          onClick={() => setForm((p: any) => ({ ...p, input_type: 'count' }))}
                          className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-all ${
                            (form.input_type || 'count') === 'count'
                              ? 'bg-secondary border-primary/40 text-foreground'
                              : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                          }`}>
                          # Count
                        </button>
                      </div>
                    </FieldRow>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <FieldRow label="Weight"><input type="number" min="0" step="0.001" value={form.weight || ''} onChange={e => setForm(p => ({ ...p, weight: parseFloat(e.target.value) || 1 }))} className={inputCls} placeholder="e.g. 0.04" /></FieldRow>
                    <FieldRow label="Display Order"><input type="number" min="1" value={form.display_order || ''} onChange={e => setForm(p => ({ ...p, display_order: parseInt(e.target.value) || 1 }))} className={inputCls} /></FieldRow>
                  </div>
                  <FieldRow label="Description"><textarea value={form.description || ''} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} rows={2} className={inputCls + ' resize-none'} /></FieldRow>
                </>
              )}

              {/* Tool form */}
              {showForm === 'tool' && (
                <>
                  <FieldRow label="Tool Name" required><input value={form.name || ''} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} required className={inputCls} /></FieldRow>
                  <FieldRow label="Deduction Group">
                    <AppSelect value={form.group_id || ''} onChange={e => setForm(p => ({ ...p, group_id: e.target.value }))}>
                      <option value="">Select group</option>
                      {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </AppSelect>
                  </FieldRow>
                  <FieldRow label="Fixed Deduction (%)"><input type="number" min="0" max="100" step="0.1" value={form.fixed_percentage || ''} onChange={e => setForm(p => ({ ...p, fixed_percentage: parseFloat(e.target.value) || 0 }))} className={inputCls} /></FieldRow>
                  <FieldRow label="Description"><textarea value={form.description || ''} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} rows={2} className={inputCls + ' resize-none'} /></FieldRow>
                </>
              )}

              {/* Bank form */}
              {showForm === 'bank' && (
                <>
                  <FieldRow label="Account Name" required><input value={form.name || ''} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} required className={inputCls} /></FieldRow>
                  <div className="grid grid-cols-2 gap-3">
                    <FieldRow label="Type">
                      <AppSelect value={form.type || 'bank'} onChange={e => setForm(p => ({ ...p, type: e.target.value }))}>
                        {['bank', 'cash', 'wallet', 'other'].map(t => <option key={t} value={t}>{t}</option>)}
                      </AppSelect>
                    </FieldRow>
                    <FieldRow label="Currency">
                      <AppSelect value={form.currency || 'INR'} onChange={e => setForm(p => ({ ...p, currency: e.target.value }))}>
                        {['INR', ...CURRENCIES].map(c => <option key={c} value={c}>{c}</option>)}
                      </AppSelect>
                    </FieldRow>
                  </div>
                  <FieldRow label="Account Number"><input value={form.account_number || ''} onChange={e => setForm(p => ({ ...p, account_number: e.target.value }))} className={inputCls} /></FieldRow>
                  <FieldRow label="Bank Name"><input value={form.bank_name || ''} onChange={e => setForm(p => ({ ...p, bank_name: e.target.value }))} className={inputCls} /></FieldRow>
                  <FieldRow label="Opening Balance"><input type="number" step="0.01" value={form.opening_balance || ''} onChange={e => setForm(p => ({ ...p, opening_balance: parseFloat(e.target.value) || 0 }))} className={inputCls} /></FieldRow>
                </>
              )}

              {/* Category form */}
              {showForm === 'category' && (
                <>
                  <FieldRow label="Category Name" required>
                    <input value={form.name || ''} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} required className={inputCls} placeholder="e.g. Office Supplies" />
                  </FieldRow>
                  <FieldRow label="Type">
                    <div className="grid grid-cols-3 gap-2">
                      {(['inflow', 'outflow', 'both'] as const).map(t => (
                        <button
                          key={t} type="button"
                          onClick={() => setForm(p => ({ ...p, type: t }))}
                          className={`py-2 rounded-lg text-sm font-medium transition-colors capitalize ${form.type === t
                            ? t === 'inflow' ? 'bg-green-500/20 text-green-400 ring-1 ring-green-500/40'
                              : t === 'outflow' ? 'bg-red-500/20 text-red-400 ring-1 ring-red-500/40'
                              : 'bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/40'
                            : 'bg-secondary text-muted-foreground hover:text-foreground'}`}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </FieldRow>
                </>
              )}

              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => showForm === 'client' ? closeForm() : setShowForm(null)} className="flex-1 bg-secondary text-sm font-medium py-2.5 rounded-lg hover:bg-secondary/80">Cancel</button>
                <button type="submit" disabled={saving} className="flex-1 gradient-bg text-white text-sm font-medium py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          </div>
        </ModalOverlay>
      )}

      {/* ── Delete confirmation modal ── */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4"
          onMouseDown={e => { if (e.target === e.currentTarget) setDeleteConfirm(null) }}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative bg-secondary border border-foreground/15 rounded-2xl shadow-2xl w-full max-w-sm p-5 animate-in fade-in zoom-in-95 duration-150">
            <h3 className="font-semibold text-sm mb-2">Archive {deleteConfirm.type}</h3>
            <p className="text-sm text-muted-foreground mb-1 leading-relaxed">
              Archive <span className="text-foreground font-medium">"{deleteConfirm.name}"</span>?
            </p>
            <p className="text-xs text-amber-400/80 mb-5">
              It will be hidden from lists. All past records that reference it are preserved.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setDeleteConfirm(null)}
                className="flex-1 py-2.5 rounded-xl border border-foreground/15 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors">
                Cancel
              </button>
              <button onClick={() => { confirmDelete(); setDeleteConfirm(null) }}
                className="flex-1 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-sm font-semibold transition-colors">
                Archive
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Invite link modal ── */}
      {inviteLink && (
        <ModalOverlay onClose={() => setInviteLink(null)}>
          <div className="bg-card border border-border rounded-2xl p-6 max-w-md w-full">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-violet-500/15 flex items-center justify-center">
                <Send className="w-5 h-5 text-violet-400" />
              </div>
              <div>
                <h3 className="font-semibold">Invite {inviteLink.cqid}</h3>
                <p className="text-xs text-muted-foreground">Share this link — valid for 7 days</p>
              </div>
            </div>

            <div className="bg-secondary border border-border rounded-lg p-3 mb-3 break-all font-mono text-xs">
              {inviteLink.url}
            </div>

            <div className="flex gap-2 mb-4">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(inviteLink.url)
                  setInviteCopied(true)
                  setTimeout(() => setInviteCopied(false), 2000)
                }}
                className="flex-1 flex items-center justify-center gap-2 bg-primary/15 hover:bg-primary/20 text-primary py-2 rounded-lg text-sm font-medium transition-colors"
              >
                {inviteCopied ? <><Check className="w-4 h-4" /> Copied!</> : <><Link2 className="w-4 h-4" /> Copy link</>}
              </button>
              <a
                href={`https://wa.me/?text=${encodeURIComponent('Welcome to Cirqle! Complete your registration: ' + inviteLink.url)}`}
                target="_blank"
                rel="noreferrer"
                className="flex-1 flex items-center justify-center gap-2 bg-emerald-500/15 hover:bg-emerald-500/20 text-emerald-400 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                <Send className="w-4 h-4" /> WhatsApp
              </a>
            </div>

            <p className="text-xs text-muted-foreground">
              The employee uses this link once to set their password and complete profile details.
              Expires {new Date(inviteLink.expiresAt).toLocaleDateString()}.
            </p>

            <div className="flex justify-end mt-4">
              <button
                onClick={() => setInviteLink(null)}
                className="px-4 py-2 bg-secondary hover:bg-secondary/80 rounded-lg text-sm font-medium"
              >
                Done
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* ── Admin reset password result modal ── */}
      {resetPwdModal && (
        <ModalOverlay onClose={() => { setResetPwdModal(null) }}>
          <div className="bg-card border border-border rounded-2xl p-6 max-w-md w-full">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-blue-500/15 flex items-center justify-center">
                <ResetKey className="w-5 h-5 text-blue-400" />
              </div>
              <div>
                <h3 className="font-semibold">Password reset for {resetPwdModal.cqid}</h3>
                <p className="text-xs text-muted-foreground">Share this with the employee securely</p>
              </div>
            </div>

            <div className="bg-secondary border border-border rounded-lg p-3 mb-4 font-mono text-sm text-center">
              {resetPwdModal.tempPassword}
            </div>

            <p className="text-xs text-amber-400/80 mb-4">
              ⚠️ Ask the employee to sign in with this temporary password and immediately change it via "Forgot password" if needed. This password will not be shown again.
            </p>

            <div className="flex gap-2">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(resetPwdModal.tempPassword)
                }}
                className="flex-1 flex items-center justify-center gap-2 bg-primary/15 hover:bg-primary/20 text-primary py-2 rounded-lg text-sm font-medium transition-colors"
              >
                <Link2 className="w-4 h-4" /> Copy password
              </button>
              <button
                onClick={() => setResetPwdModal(null)}
                className="px-4 py-2 bg-secondary hover:bg-secondary/80 rounded-lg text-sm font-medium"
              >
                Done
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* ── Avatar picker modal ──────────────────────────────────── */}
      {avatarModal && (
        <ModalOverlay onClose={() => setAvatarModal(null)}>
          <div className="bg-card border border-border rounded-2xl p-6 max-w-sm w-full">
            <div className="flex items-center gap-3 mb-5">
              <EmployeeAvatar
                avatarUrl={avatarPickerValue}
                name={avatarModal.name}
                cqid={avatarModal.cqid}
                size={44}
                rounded="xl"
              />
              <div>
                <h3 className="font-semibold">Edit avatar — {avatarModal.cqid}</h3>
                <p className="text-xs text-muted-foreground">Choose a preset or upload a photo</p>
              </div>
            </div>

            <AvatarPicker
              value={avatarPickerValue}
              onChange={setAvatarPickerValue}
              name={avatarModal.name}
              cqid={avatarModal.cqid}
            />

            <div className="flex gap-2 mt-5">
              <button
                onClick={async () => {
                  setAvatarSaving(true)
                  const res = await updateEmployeeAvatar(avatarModal.id, avatarPickerValue)
                  setAvatarSaving(false)
                  if (!res.ok) { alert(res.error || 'Failed to save avatar'); return }
                  // Refresh page data so avatars update
                  window.location.reload()
                }}
                disabled={avatarSaving}
                className="flex-1 gradient-bg text-white text-sm font-medium py-2 rounded-lg hover:opacity-90 disabled:opacity-50"
              >
                {avatarSaving ? 'Saving…' : 'Save avatar'}
              </button>
              <button
                onClick={() => setAvatarModal(null)}
                className="px-4 py-2 bg-secondary hover:bg-secondary/80 rounded-lg text-sm font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {showHistoryModal && (
        <PerformanceHistoryModal 
          employee={showHistoryModal} 
          onClose={() => setShowHistoryModal(null)} 
        />
      )}

      {showRecalcCommissions && (
        <RecalcCommissionsModal
          open={showRecalcCommissions}
          onClose={() => setShowRecalcCommissions(false)}
          employees={employees}
        />
      )}
    </div>
  )
}

const inputCls = 'w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50'

// ─── Desktop app: receipt → WhatsApp share preference ────────────────────────
// Only meaningful inside the Cirqle Desktop shell (localStorage-backed, per
// install). Lets the user set the default action the receipt Share button runs,
// and optionally force it so the picker is skipped.
function DesktopReceiptShareCard() {
  const [onDesktop, setOnDesktop] = useState(false)
  const [pref, setPref] = useState<{ default: ReceiptShareAction; always: boolean }>({ default: 'copy', always: false })

  useEffect(() => {
    if (!isDesktop()) return
    setOnDesktop(true)
    setPref(getReceiptSharePref())
  }, [])

  if (!onDesktop) return null

  const update = (next: { default: ReceiptShareAction; always: boolean }) => {
    setPref(next)
    setReceiptSharePref(next)
  }

  return (
    <div className="border border-border rounded-xl p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Send className="w-4 h-4 text-emerald-400" /> Receipt sharing (Desktop app)
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Choose what the receipt <strong>Send to WhatsApp</strong> button does by default. You can still pick a
          different action any time from the button&apos;s dropdown.
        </p>
      </div>

      <div className="space-y-1.5">
        {(['copy', 'paste', 'download'] as ReceiptShareAction[]).map(a => (
          <label
            key={a}
            className={`flex items-start gap-2.5 rounded-lg border p-2.5 cursor-pointer transition-colors ${
              pref.default === a ? 'border-primary/50 bg-primary/5' : 'border-border hover:bg-secondary/50'
            }`}
          >
            <input
              type="radio"
              name="receipt-share-default"
              checked={pref.default === a}
              onChange={() => update({ ...pref, default: a })}
              className="mt-0.5 accent-violet-500"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">{RECEIPT_SHARE_LABELS[a]}</span>
              <span className="block text-[11px] text-muted-foreground leading-snug">{RECEIPT_SHARE_HINTS[a]}</span>
            </span>
          </label>
        ))}
      </div>

      <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer pt-1">
        <input
          type="checkbox"
          checked={pref.always}
          onChange={e => update({ ...pref, always: e.target.checked })}
          className="accent-violet-500"
        />
        Always use this action (skip the picker)
      </label>
    </div>
  )
}

// ─── Message Templates tab ───────────────────────────────────────────────────
// Lets Settings own the wording of every client-facing WhatsApp text (invoice
// share + payment reminders) without a code change. Each template is stored
// as a plain string in company_settings (key = TEMPLATE_KEYS[...]); an empty
// override falls back to DEFAULT_TEMPLATES (see src/lib/messaging/templates.ts).
function MessageTemplatesTab({ companySettings, setCompanySettings, saveCompanySettings, saving }: {
  companySettings: Record<string, string>
  setCompanySettings: React.Dispatch<React.SetStateAction<Record<string, string>>>
  saveCompanySettings: () => Promise<void>
  saving: boolean
}) {
  const templates = templatesFromSettings(companySettings)
  const companyName = companySettings.company_name || 'Cirqle Design'

  // Sample data so admins can see exactly what a client would receive.
  const sampleLink = 'https://app.cirqle.work/i/sample-token'
  const previewFor = (key: keyof MessageTemplates): string => {
    if (key === 'invoiceShare') {
      return buildInvoiceShareText({
        invoiceNumber: 'INV-2606-014', clientName: 'Sea Star Supermarket', companyName,
        amount: 4250, dueDate: '2026-07-15', showAmounts: true, link: sampleLink,
        template: templates.invoiceShare,
      })
    }
    if (key === 'reminderSingle') {
      return buildReminderText({
        clientName: 'Sea Star Supermarket', companyName, showAmounts: true, templates,
        invoices: [{ invoice_number: 'INV-2606-014', issue_date: '2026-06-01', outstanding: 4250, link: sampleLink }],
      })
    }
    // reminderMulti + reminderItem share one preview (the multi-invoice message).
    return buildReminderText({
      clientName: 'Sea Star Supermarket', companyName, showAmounts: true, templates,
      invoices: [
        { invoice_number: 'INV-2606-014', issue_date: '2026-06-01', outstanding: 4250, link: sampleLink },
        { invoice_number: 'INV-2607-009', issue_date: '2026-07-01', outstanding: 1750, link: sampleLink },
      ],
    })
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">WhatsApp Message Templates</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Customize the wording of every client-facing WhatsApp message — invoice shares and payment reminders.
          Use <code className="px-1 py-0.5 rounded bg-secondary text-[11px]">{'{placeholder}'}</code> for dynamic values
          and <code className="px-1 py-0.5 rounded bg-secondary text-[11px]">{'{{if:placeholder}}'}</code> at the start of a line
          to show that line only when the placeholder has a value. Leave a template blank to use the default wording.
        </p>
      </div>

      <DesktopReceiptShareCard />

      {TEMPLATE_DOCS.map(({ key, label, description, placeholders }) => {
        const settingKey = TEMPLATE_KEYS[key]
        const value = companySettings[settingKey] ?? ''
        return (
          <div key={key} className="border border-border rounded-xl p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">{label}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
              </div>
              {value && (
                <button
                  type="button"
                  onClick={() => setCompanySettings(p => ({ ...p, [settingKey]: '' }))}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
                >Reset to default</button>
              )}
            </div>
            <textarea
              value={value}
              onChange={e => setCompanySettings(p => ({ ...p, [settingKey]: e.target.value }))}
              placeholder={DEFAULT_TEMPLATES[key]}
              rows={key === 'reminderItem' ? 3 : 7}
              className={`${inputCls} font-mono text-xs leading-relaxed`}
            />
            <div className="flex flex-wrap gap-1.5">
              {placeholders.map(p => (
                <span key={p} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">{`{${p}}`}</span>
              ))}
            </div>
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground transition-colors select-none">Preview with sample data</summary>
              <pre className="mt-2 whitespace-pre-wrap bg-secondary/50 border border-border rounded-lg p-3 text-[12px] leading-relaxed text-foreground">{previewFor(key)}</pre>
            </details>
          </div>
        )
      })}

      <button onClick={saveCompanySettings} disabled={saving} className="gradient-bg text-white text-sm font-medium px-5 py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50">
        {saving ? 'Saving…' : 'Save Settings'}
      </button>
    </div>
  )
}

function FieldRow({ label, required, children }: { label: React.ReactNode; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-muted-foreground mb-1.5">{label}{required && ' *'}</label>
      {children}
    </div>
  )
}

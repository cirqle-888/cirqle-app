'use client'

import { useState, useMemo, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import Header from '@/components/layout/header'
import AppSelect from '@/components/ui/app-select'
import { createClient as createSupabaseClient } from '@/lib/supabase/client'
import {
  upsertCompanySettings, createBrandingUploadUrl,
  createEmployee, updateEmployee,
  createClient, updateClient, upsertClientServicePricings, deactivateClientServices,
  createService, updateService, deactivateService, reactivateService, quickEditService,
  createGroup, updateGroup, deactivateGroup, quickEditGroup, restoreGroup,
  createParameter, updateParameter, deactivateParameter, quickEditParameter, restoreParameter,
  createTool, updateTool, deactivateTool, reactivateTool, quickEditTool,
  createBankAccount, updateBankAccount, deactivateBankAccount, reactivateBankAccount, setDefaultBankAccount,
  createCashbookCategory, updateCashbookCategory, deactivateCashbookCategory, reactivateCashbookCategory,
  upsertExchangeRate,
  syncExchangeRates,
  setEmployeeServices, setServiceEmployees, setEmployeeServiceCategories,
  createServiceCategory, updateServiceCategory, setServiceCategoryActive, reorderServiceCategories,
} from './actions'
import { Plus, X, Edit2, Archive, ArchiveRestore, Save, ChevronDown, ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown, Lock, Eye, EyeOff, ShieldCheck, Zap, Search, ArrowUpDown, ArrowUp, ArrowDown, AlertTriangle, Link2, Check, KeyRound, CalendarDays, Mail, Send, RotateCcw as ResetKey, RefreshCw, Star, Building2, MapPin, Users } from 'lucide-react'
import type { Currency } from '@/types'
import InfoTip from '@/components/ui/info-tip'
import { resolveBrandingUrl } from '@/lib/utils/branding'
import { usePrivacy, getStoredPin, setStoredPin, isForceLocked } from '@/contexts/privacy-context'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { generateInviteToken, revokeInviteToken, archiveEmployee, restoreEmployee, adminResetPassword, updateEmployeeAvatar } from './employee-actions'
import dynamic from 'next/dynamic'

const RecalcCommissionsModal = dynamic(() => import('./recalc-commissions-modal').then(mod => mod.RecalcCommissionsModal), { ssr: false })
const PerformanceHistoryModal = dynamic(() => import('./performance-history-modal').then(mod => mod.PerformanceHistoryModal), { ssr: false })
import { EmployeeAvatar, AvatarPicker } from '@/components/ui/employee-avatar'
import { DEFAULT_TEMPLATES, TEMPLATE_KEYS, TEMPLATE_DOCS, templatesFromSettings, type MessageTemplates } from '@/lib/messaging/templates'
import { INTAKE_KINDS, INTAKE_KIND_META } from '@/lib/services/intake'
import { normalizeGroupWeights } from '@/lib/contributions/weights'
import { isDesktop, getReceiptSharePref, setReceiptSharePref, RECEIPT_SHARE_LABELS, RECEIPT_SHARE_HINTS, type ReceiptShareAction } from '@/lib/desktop'
import { buildInvoiceShareText } from '@/lib/invoices/share'
import { buildReminderText } from '@/lib/followups/grouping'

const AllocationRebuildPanel = dynamic(
  () => import('@/components/cashbook/allocation-rebuild-panel'),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
        <span className="w-4 h-4 border-2 border-foreground/20 border-t-primary rounded-full animate-spin" />
        Loading rebuild wizard…
      </div>
    ),
  },
)

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

// Active/Archived/All segmented control shared by the catalog tabs.
function ArchFilterTabs({ value, onChange }: { value: 'active' | 'archived' | 'all'; onChange: (v: 'active' | 'archived' | 'all') => void }) {
  return (
    <div className="flex bg-secondary/30 border border-border/50 rounded-lg p-0.5 w-fit shrink-0">
      {(['active', 'archived', 'all'] as const).map(f => (
        <button key={f} onClick={() => onChange(f)}
          className={cn(
            'px-3 py-1.5 text-[13px] font-medium rounded-md transition-all',
            value === f ? 'bg-background text-foreground shadow-sm ring-1 ring-border/50' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50',
          )}>
          {f === 'active' ? 'Active' : f === 'archived' ? 'Archived' : 'All'}
        </button>
      ))}
    </div>
  )
}

const SETTINGS_TABS = [
  'Company', 'Employees', 'Services', 'Departments',
  'Groups & Params', 'Tools', 'Bank Accounts', 'Cash Categories', 'Exchange Rates',
  'Privacy & Security', 'Message Templates', 'Matching'
] as const
type SettingsTab = typeof SETTINGS_TABS[number]

/**
 * Display names for tabs whose internal id is engine vocabulary.
 *
 * The ids stay put — they key the render branches and the ?tab= deep links
 * people have bookmarked — but nobody outside this codebase knows what
 * "Groups & Params" or "Matching" mean. "Matching" was the worst: a bland
 * Finance tab that opens a tool which rewrites every invoice allocation.
 */
const TAB_LABEL: Partial<Record<SettingsTab, string>> = {
  'Groups & Params': 'Scoring Rules',
  'Matching': 'Rebuild Payment Matching',
}
const tabLabel = (t: SettingsTab) => TAB_LABEL[t] ?? t

// ─── Tab grouping (left rail) ────────────────────────────────────────────────
// Rarely-touched, technical or destructive tabs sit in "Advanced" so the
// everyday rail is short. Nothing is removed — every tab is one click away.
const SETTINGS_GROUPS: { label: string; emoji: string; tabs: SettingsTab[] }[] = [
  { label: 'Organization',    emoji: '🏢', tabs: ['Company', 'Privacy & Security'] },
  { label: 'People',          emoji: '👥', tabs: ['Employees'] },
  { label: 'Service Catalog', emoji: '📦', tabs: ['Services', 'Departments'] },
  { label: 'Finance',         emoji: '💸', tabs: ['Bank Accounts', 'Cash Categories'] },
  { label: 'Communication',   emoji: '💬', tabs: ['Message Templates'] },
  { label: 'Advanced',        emoji: '⚙️', tabs: ['Groups & Params', 'Tools', 'Exchange Rates', 'Matching'] },
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
  toolServices: any[]
  taskServiceUsage: { service_id: string; created_at: string }[]
  groupServices: { group_id: string; service_id: string }[]
  employeeServices?: { employee_id: string; service_id: string }[]
  /** Service taxonomy. Distinct from `categories`, which is Cash Book. */
  serviceCategories?: any[]
  employeeServiceCategories?: { employee_id: string; category_id: string }[]
  designations?: { id: string; name: string; is_admin: boolean; is_system: boolean }[]
  /** Designations holding ≥1 CRITICAL permission (pricing / earnings / personal
   *  data) — the picker warns in red before one is assigned. */
  criticalDesignationIds?: string[]
  initialTab?: string
  initialEditClientId?: string
  initialEditServiceId?: string
  returnTo?: string
}

export default function SettingsClient(props: Props) {
  const { taskServiceUsage } = props
  // Per-client outstanding now lives in the Clients module (/dashboard/clients),
  // which loads invoice rollups itself — Settings no longer fetches invoices.
  // groupServices: which contribution groups belong to each service
  // Uses localStorage as fallback before the SQL migration is run.
  const [groupServices, setGroupServices] = useState<{ group_id: string; service_id: string }[]>(() => {
    const fromDB = props.groupServices || []
    if (fromDB.length > 0) return fromDB
    try { return JSON.parse(localStorage.getItem('cirqle_group_services') || '[]') } catch { return [] }
  })
  // empServices: which services each employee is assigned to (employee ↔ service
  // junction — same rows power both the employee form and the service form).
  const [empServices, setEmpServices] = useState<{ employee_id: string; service_id: string }[]>(props.employeeServices || [])
  const [empCategories, setEmpCategories] = useState<{ employee_id: string; category_id: string }[]>(props.employeeServiceCategories || [])
  // Departments (service taxonomy) — state, not a prop passthrough, so the
  // Departments tab's CRUD updates every consumer (employee modal grouping,
  // service form dropdown) without a reload.
  const [serviceCategories, setServiceCategories] = useState<any[]>(props.serviceCategories || [])
  const [newDeptName, setNewDeptName] = useState('')
  const [deptSaving, setDeptSaving] = useState(false)
  // Services tab: which department groups are collapsed ('uncategorised' for the null group).
  const [collapsedDepts, setCollapsedDepts] = useState<Set<string>>(new Set())
  const [tab, setTab] = useState(props.initialTab ?? 'Company')
  const router = useRouter()
  const supabase = createSupabaseClient()
  const toast = useToast()
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
    const eids = (props.employeeServices || []).filter(es => es.service_id === svc.id).map(es => es.employee_id)
    setForm({ ...svc, _groupIds: gids, _employeeIds: eids })
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
  const [, setClients] = useState(props.clients)
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

  // ── Per-tab search + sort + view ───────────────────────────
  const [serviceSearch, setServiceSearch] = useState('')
  const [serviceSort, setServiceSort] = useState<'name' | 'usage'>('usage')
  const [groupSearch, setGroupSearch] = useState('')
  const [paramSearch, setParamSearch] = useState('')
  const [toolSearch, setToolSearch] = useState('')
  const [empSearch, setEmpSearch] = useState('')
  const [copiedPortalId, setCopiedPortalId] = useState<string | null>(null)
  const [salaryDayCalOpen, setSalaryDayCalOpen] = useState(false)
  const [salaryCalViewDate, setSalaryCalViewDate] = useState(() => new Date())

  // Shared Active/Archived/All filter for the catalog tabs (Clients, Services,
  // Tools, Cash Categories) — archived records stay inspectable + restorable.
  const [archFilter, setArchFilter] = useState<'active' | 'archived' | 'all'>('active')

  const filteredServices = useMemo(() => {
    const byFilter = (s: any) =>
      archFilter === 'active' ? s.is_active !== false :
      archFilter === 'archived' ? s.is_active === false : true
    let list = serviceSort === 'usage'
      ? servicesSortedByUsage.filter(byFilter)
      : services.filter(byFilter).sort((a: any, b: any) => a.name.localeCompare(b.name))
    if (serviceSearch) {
      const q = serviceSearch.toLowerCase()
      list = list.filter((s: any) => s.name?.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q))
    }
    return list
  }, [services, servicesSortedByUsage, serviceSearch, serviceSort, archFilter])

  // Groups & Params tab: shared active/archived/all filter (mirrors the
  // employee filter) so archived groups/params can be inspected and restored.
  const [gpFilter, setGpFilter] = useState<'active' | 'archived' | 'all'>('active')
  // Parameter list is grouped by contribution group; collapsed by default so
  // 50+ params read as a handful of group headers. Searching expands matches.
  const [expandedParamGroups, setExpandedParamGroups] = useState<Set<string>>(new Set())

  const filteredGroups = useMemo(() => {
    let pool = groups
    if (gpFilter === 'active')   pool = pool.filter((g: any) => g.is_active !== false)
    if (gpFilter === 'archived') pool = pool.filter((g: any) => g.is_active === false)
    if (!groupSearch) return pool
    const q = groupSearch.toLowerCase()
    return pool.filter((g: any) => g.name?.toLowerCase().includes(q))
  }, [groups, groupSearch, gpFilter])

  const filteredParams = useMemo(() => {
    let pool = params
    if (gpFilter === 'active')   pool = pool.filter((p: any) => p.is_active !== false)
    if (gpFilter === 'archived') pool = pool.filter((p: any) => p.is_active === false)
    if (!paramSearch) return pool
    const q = paramSearch.toLowerCase()
    return pool.filter((p: any) => p.name?.toLowerCase().includes(q))
  }, [params, paramSearch, gpFilter])

  // Parameters bucketed under their group (ordered like the groups list),
  // with a trailing bucket for params that have no group.
  const paramsByGroup = useMemo(() => {
    const orderedGroups = [...groups].sort((a: any, b: any) => (a.display_order || 0) - (b.display_order || 0))
    const buckets = orderedGroups
      .map((g: any) => ({ group: g, params: filteredParams.filter((p: any) => p.group_id === g.id) }))
      .filter(b => b.params.length > 0)
    const orphans = filteredParams.filter((p: any) => !p.group_id || !groups.some((g: any) => g.id === p.group_id))
    if (orphans.length > 0) buckets.push({ group: null as any, params: orphans })
    return buckets
  }, [groups, filteredParams])

  const filteredTools = useMemo(() => {
    let pool = tools
    if (archFilter === 'active')   pool = pool.filter((t: any) => t.is_active !== false)
    if (archFilter === 'archived') pool = pool.filter((t: any) => t.is_active === false)
    if (!toolSearch) return pool
    const q = toolSearch.toLowerCase()
    return pool.filter((t: any) => t.name?.toLowerCase().includes(q))
  }, [tools, toolSearch, archFilter])

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

  // Bank account filter tabs: active | archived | all — mirrors the employee
  // filter so an archived account (e.g. one accidentally archived, or one
  // that still has historical entries) isn't stranded invisible forever.
  const [bankFilter, setBankFilter] = useState<'active' | 'archived' | 'all'>('active')
  const filteredBankAccounts = useMemo(() => {
    if (bankFilter === 'active')   return bankAccounts.filter((b) => b.is_active !== false)
    if (bankFilter === 'archived') return bankAccounts.filter((b) => b.is_active === false)
    return bankAccounts
  }, [bankAccounts, bankFilter])

  // Invite link modal state
  const [inviteLink, setInviteLink] = useState<{ employeeId: string; cqid: string; url: string; expiresAt: string } | null>(null)
  const [inviteCopied, setInviteCopied] = useState(false)
  const [inviteBusy, setInviteBusy] = useState<string | null>(null)
  // In-app confirmation. NOT window.confirm: the desktop shell returns false
  // from it immediately without ever drawing a dialog, so these buttons would
  // silently do nothing there, with no error to explain it.
  const [confirmPrompt, setConfirmPrompt] = useState<{
    title: string
    body: string
    confirmLabel: string
    danger?: boolean
    onConfirm: () => void
  } | null>(null)
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
    if (!res.ok || !res.data) { toast.error('Failed to generate invite', res.error); return }
    setInviteLink({ employeeId: emp.id, cqid: emp.cqid, url: res.data.url, expiresAt: res.data.expiresAt })
    setInviteCopied(false)
    // patch local state
    setEmployees(prev => prev.map((x: any) => x.id === emp.id ? { ...x, invite_token: res.data!.token, invite_token_expires_at: res.data!.expiresAt } : x))
  }

  function askArchive(emp: any) {
    setConfirmPrompt({
      title: `Archive ${emp.cqid}?`,
      body: 'They lose access immediately and stop appearing in pickers for new work. Their past tasks, contributions and payslips stay exactly as they are, and you can restore them at any time.',
      confirmLabel: 'Archive',
      danger: true,
      onConfirm: () => { void handleArchive(emp) },
    })
  }

  async function handleArchive(emp: any) {
    setInviteBusy(emp.id)
    const res = await archiveEmployee(emp.id)
    setInviteBusy(null)
    if (!res.ok) { toast.error('Failed to archive', res.error); return }
    setEmployees(prev => prev.map((x: any) => x.id === emp.id ? { ...x, is_archived: true, is_active: false } : x))
  }

  async function handleRestore(emp: any) {
    setInviteBusy(emp.id)
    const res = await restoreEmployee(emp.id)
    setInviteBusy(null)
    if (!res.ok) { toast.error('Failed to restore', res.error); return }
    setEmployees(prev => prev.map((x: any) => x.id === emp.id ? { ...x, is_archived: false, is_active: true } : x))
  }

  function askAdminResetPassword(emp: any) {
    setConfirmPrompt({
      title: `Reset the password for ${emp.cqid}?`,
      body: 'Their current password stops working right away. A temporary one is shown to you once — pass it on so they can sign in and set their own.',
      confirmLabel: 'Reset password',
      danger: true,
      onConfirm: () => { void handleAdminResetPassword(emp) },
    })
  }

  async function handleAdminResetPassword(emp: any) {
    setInviteBusy(emp.id)
    const res = await adminResetPassword(emp.id)
    setInviteBusy(null)
    if (!res.ok || !res.data) { toast.error('Password reset failed', res.error); return }
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
    const serviceIds = emp ? empServices.filter(es => es.employee_id === emp.id).map(es => es.service_id) : []
    const categoryIds = emp ? empCategories.filter(ec => ec.employee_id === emp.id).map(ec => ec.category_id) : []
    setForm(emp ? { ...emp, _serviceIds: serviceIds, _categoryIds: categoryIds } : { role: 'employee', salary_type: 'fixed', base_salary: 0, performance_rating: 70, is_active: true, reveal_salary: false, cqid, _serviceIds: [], _categoryIds: [] })
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
    const activeServiceIds: string[] = []
    if (client) {
      // Only ACTIVE commitments are loaded and pre-selected. Loading
      // deactivated rows here and re-selecting them is what made saving a
      // client (even just to fix a phone number) silently revive every
      // service they no longer buy.
      const { data } = await supabase.from('client_service_pricing')
        .select('*').eq('client_id', client.id).not('is_active', 'is', false)
      data?.forEach((p: any) => {
        // `!= null` NOT `||` — a stored 0 must not collapse to blank.
        pricings[p.service_id] = {
          price: p.price != null ? String(p.price) : '',
          commission_percentage: p.commission_percentage != null ? String(p.commission_percentage) : '',
          currency: p.currency || client?.default_currency || 'INR',
        }
        activeServiceIds.push(p.service_id)
      })
    }
    setClientPricings(pricings)
    setSelectedClientServices(new Set(activeServiceIds))
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
    if (!res.ok) { toast.error('Failed to save', res.error); return }
    toast.success('Company settings saved')
  }

  // --- Employees ---
  async function saveEmployee(e: React.FormEvent) {
    e.preventDefault(); setSaving(true)
    // _serviceIds / _categoryIds are UI-only state — saved via their junction
    // tables, not as employees columns.
    const { _serviceIds, _categoryIds, ...employeePayload } = form
    const serviceIds: string[] = _serviceIds || []
    const categoryIds: string[] = _categoryIds || []
    let res: Awaited<ReturnType<typeof createEmployee>>
    if (editingId) {
      res = await updateEmployee(editingId, employeePayload)
      if (res.ok && res.data) setEmployees(prev => prev.map(emp => emp.id === editingId ? res.data : emp))
    } else {
      res = await createEmployee(employeePayload)
      if (res.ok && res.data) setEmployees(prev => [...prev, res.data])
    }
    if (!res.ok) { setSaving(false); toast.error('Failed to save employee', res.error); return }

    const employeeId = editingId || res.data?.id
    if (employeeId) {
      const svcRes = await setEmployeeServices(employeeId, serviceIds)
      if (svcRes.ok) {
        setEmpServices(prev => [
          ...prev.filter(es => es.employee_id !== employeeId),
          ...serviceIds.map(sid => ({ employee_id: employeeId, service_id: sid })),
        ])
      } else if (serviceIds.length > 0) {
        toast.error('Service assignments not saved', svcRes.error || 'Run the employee_services migration.')
      }

      // Categories are a separate junction, saved independently: a failure here
      // must not roll back the individual assignments that already succeeded.
      const catRes = await setEmployeeServiceCategories(employeeId, categoryIds)
      if (catRes.ok) {
        setEmpCategories(prev => [
          ...prev.filter(ec => ec.employee_id !== employeeId),
          ...categoryIds.map(cid => ({ employee_id: employeeId, category_id: cid })),
        ])
      } else if (categoryIds.length > 0) {
        toast.error('Category assignments not saved', catRes.error || 'Run the service_categories migration.')
      }
    }
    setSaving(false)
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
    if (!res.ok) { setSaving(false); toast.error('Failed to save client', res.error); return }
    // Save service pricings
    if (clientId) {
      // Blank means "not agreed yet", never 0: coercing with `|| 0` made a
      // committed-but-unpriced service indistinguishable from a free one, and
      // for commission it silently zeroed the pair's historical earnings pool
      // (every reader guards with `?? 50` / `!= null`, neither catches 0).
      const numOrNull = (raw: string) => {
        const s = (raw ?? '').trim()
        if (s === '') return null
        const n = parseFloat(s)
        return Number.isFinite(n) ? n : null
      }
      const pricingRows = Object.entries(clientPricings)
        .filter(([service_id]) => selectedClientServices.has(service_id))
        .map(([service_id, v]) => {
          const commission = numOrNull(v.commission_percentage)
          return {
            client_id: clientId!,
            service_id,
            price: numOrNull(v.price),
            // Omitted when blank → ON CONFLICT DO UPDATE leaves it untouched.
            ...(commission === null ? {} : { commission_percentage: commission }),
            currency: v.currency || 'INR',
            is_active: true as const,
          }
        })
      if (pricingRows.length > 0) {
        await upsertClientServicePricings(pricingRows)
        const sIds = pricingRows.map(r => r.service_id)
        setServices(prev => prev.map(s => sIds.includes(s.id) ? { ...s, pricing_pending: false } : s))
      }
      // Deactivation counterpart: a service deselected in this form must be
      // removed from the client's commitments, or the form could only ever
      // add. Deactivates (never deletes) so the agreed price survives.
      const deselected = Object.keys(clientPricings).filter(id => !selectedClientServices.has(id))
      if (deselected.length > 0) await deactivateClientServices(clientId!, deselected)
    }
    setSaving(false)
    closeForm()
  }

  // --- Services ---
  async function saveService(e: React.FormEvent) {
    e.preventDefault(); setSaving(true)

    // Strip internal _groupIds / _employeeIds from the DB payload
    const { _groupIds, _employeeIds, ...servicePayload } = form
    const selectedGroupIds: string[] = _groupIds || []
    const selectedEmployeeIds: string[] = _employeeIds || []

    let res: Awaited<ReturnType<typeof createService>>
    if (editingId) {
      res = await updateService(editingId, servicePayload, selectedGroupIds)
      if (res.ok && res.data?.service) setServices(prev => prev.map(s => s.id === editingId ? res.data!.service : s))
    } else {
      res = await createService(servicePayload, selectedGroupIds)
      if (res.ok && res.data?.service) setServices(prev => [...prev, res.data!.service])
    }

    if (!res.ok) { setSaving(false); toast.error('Failed to save service', res.error); return }

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

      // Sync assigned employees (same junction the employee form writes)
      const empRes = await setServiceEmployees(serviceId, selectedEmployeeIds)
      if (empRes.ok) {
        setEmpServices(prev => [
          ...prev.filter(es => es.service_id !== serviceId),
          ...selectedEmployeeIds.map(eid => ({ employee_id: eid, service_id: serviceId })),
        ])
      } else if (selectedEmployeeIds.length > 0) {
        toast.error('Employee assignments not saved', empRes.error || 'Run the employee_services migration.')
      }
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
    if (!res.ok) { toast.error('Failed to save group', res.error); return }
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
    if (!res.ok) { toast.error('Failed to save parameter', res.error); return }
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
    if (!res.ok) { toast.error('Failed to save tool', res.error); return }
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
    if (!res.ok) { toast.error('Failed to save bank account', res.error); return }
    setShowForm(null)
  }

  async function makeDefaultBank(id: string) {
    setBankAccounts(prev => prev.map(b => ({ ...b, is_default: b.id === id })))
    const res = await setDefaultBankAccount(id)
    if (!res.ok) toast.error('Failed to set default account', res.error)
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
    if (!res.ok) { toast.error('Failed to save category', res.error); return }
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
            onChange={async e => {
              const t = e.target.value as SettingsTab
              setTab(t); setQuickEdit(false)
              window.history.replaceState(null, '', `?tab=${t.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`)
            }}
            className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            {SETTINGS_GROUPS.map(group => (
              <optgroup key={group.label} label={`${group.emoji}  ${group.label}`}>
                {group.tabs.map(t => (
                  <option key={t} value={t}>{tabLabel(t)}</option>
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
          <a
            href="/dashboard/settings/ownership"
            className="mt-2 flex items-center justify-between text-xs text-muted-foreground hover:text-foreground bg-secondary/60 rounded-lg px-3 py-1.5 border border-border"
          >
            <span>🤝  Ownership</span>
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
                    {tabLabel(t)}
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
            {/* Ownership Platform — revenue/profit share, incentives, bonuses.
                Configuration lives here; the monthly ritual lives in
                Finance → Months. */}
            <a
              href="/dashboard/settings/ownership"
              className="flex items-center justify-between w-full text-left px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors group"
            >
              <span>Ownership</span>
              <svg className="w-3 h-3 opacity-40 group-hover:opacity-70 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
              </svg>
            </a>
            <a
              href="/dashboard/settings/organization"
              className="flex items-center justify-between w-full text-left px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors group"
            >
              <span>Organization</span>
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
                          onChange={async e => {
                            const file = e.target.files?.[0]
                            if (!file) return
                                                        const supabase = createSupabaseClient()
                            const prep = await createBrandingUploadUrl({ key: 'logo_url', fileName: file.name })
                            if (!prep.ok || !prep.data) { alert('Upload failed: ' + prep.error); return }
                            const { error: upErr } = await supabase.storage.from('company-branding').uploadToSignedUrl(prep.data!.storagePath, prep.data!.token, file)
                            if (upErr) { alert('Upload failed: ' + upErr.message); return }
                            setCompanySettings(p => ({ ...p, logo_url: `storage:company-branding/${prep.data!.storagePath}` }))
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
                        <img src={resolveBrandingUrl(companySettings['logo_url'])} alt="Light logo preview" className="h-10 object-contain rounded-lg border border-border bg-white p-1.5" />
                        <button type="button" onClick={() => setCompanySettings(p => ({ ...p, logo_url: '' }))}
                          className="text-xs text-red-400 hover:text-red-700 dark:text-red-300 transition-colors">Remove</button>
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
                          onChange={async e => {
                            const file = e.target.files?.[0]
                            if (!file) return
                                                        const supabase = createSupabaseClient()
                            const prep = await createBrandingUploadUrl({ key: 'logo_url_dark', fileName: file.name })
                            if (!prep.ok || !prep.data) { alert('Upload failed: ' + prep.error); return }
                            const { error: upErr } = await supabase.storage.from('company-branding').uploadToSignedUrl(prep.data!.storagePath, prep.data!.token, file)
                            if (upErr) { alert('Upload failed: ' + upErr.message); return }
                            setCompanySettings(p => ({ ...p, logo_url_dark: `storage:company-branding/${prep.data!.storagePath}` }))
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
                        <img src={resolveBrandingUrl(companySettings['logo_url_dark'])} alt="Dark logo preview" className="h-10 object-contain rounded-lg border border-border bg-[#0b1120] p-1.5" />
                        <button type="button" onClick={() => setCompanySettings(p => ({ ...p, logo_url_dark: '' }))}
                          className="text-xs text-red-400 hover:text-red-700 dark:text-red-300 transition-colors">Remove</button>
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
                        onChange={async e => {
                          const file = e.target.files?.[0]
                          if (!file) return
                                                      const supabase = createSupabaseClient()
                            const prep = await createBrandingUploadUrl({ key: 'favicon_url', fileName: file.name })
                            if (!prep.ok || !prep.data) { alert('Upload failed: ' + prep.error); return }
                            const { error: upErr } = await supabase.storage.from('company-branding').uploadToSignedUrl(prep.data!.storagePath, prep.data!.token, file)
                            if (upErr) { alert('Upload failed: ' + upErr.message); return }
                            setCompanySettings(p => ({ ...p, favicon_url: `storage:company-branding/${prep.data!.storagePath}` }))
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
                        <img src={resolveBrandingUrl(companySettings['favicon_url'])} alt="Favicon preview" className="w-full h-full object-contain" />
                      </div>
                      <span className="text-xs text-muted-foreground">Preview (32×32)</span>
                      <button type="button" onClick={() => setCompanySettings(p => ({ ...p, favicon_url: '' }))}
                        className="text-xs text-red-400 hover:text-red-700 dark:text-red-300 ml-2 transition-colors">Remove</button>
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
                        onChange={async e => {
                          const file = e.target.files?.[0]
                          if (!file) return
                                                      const supabase = createSupabaseClient()
                            const prep = await createBrandingUploadUrl({ key: 'invoice_qr_image_url', fileName: file.name })
                            if (!prep.ok || !prep.data) { alert('Upload failed: ' + prep.error); return }
                            const { error: upErr } = await supabase.storage.from('company-branding').uploadToSignedUrl(prep.data!.storagePath, prep.data!.token, file)
                            if (upErr) { alert('Upload failed: ' + upErr.message); return }
                            setCompanySettings(p => ({ ...p, invoice_qr_image_url: `storage:company-branding/${prep.data!.storagePath}` }))
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
                      <img src={resolveBrandingUrl(companySettings['invoice_qr_image_url'])} alt="QR preview" className="h-16 object-contain rounded border border-border bg-white p-1" />
                      <button type="button" onClick={() => setCompanySettings(p => ({ ...p, invoice_qr_image_url: '' }))}
                        className="text-xs text-red-400 hover:text-red-700 dark:text-red-300 transition-colors">Remove</button>
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
                          <img src={resolveBrandingUrl(companySettings['logo_url_light'] || companySettings['logo_url'])} alt="logo" style={{ height: 36, objectFit: 'contain' }} />
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
                                {companySettings['company_tagline'] || 'Creative & Marketing Solutions'}
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
                            <input type="file" accept="image/*" className="hidden" onChange={async e => {
                              const file = e.target.files?.[0]
                              if (!file) return
                                                          const supabase = createSupabaseClient()
                            const prep = await createBrandingUploadUrl({ key: 'invoice_bg_image_top_url', fileName: file.name })
                            if (!prep.ok || !prep.data) { alert('Upload failed: ' + prep.error); return }
                            const { error: upErr } = await supabase.storage.from('company-branding').uploadToSignedUrl(prep.data!.storagePath, prep.data!.token, file)
                            if (upErr) { alert('Upload failed: ' + upErr.message); return }
                            setCompanySettings(p => ({ ...p, invoice_bg_image_top_url: `storage:company-branding/${prep.data!.storagePath}` }))
                            }} />
                          </label>
                          {companySettings['invoice_bg_image_top_url'] && (
                            <div className="mt-2 flex items-center justify-between">
                              <img src={resolveBrandingUrl(companySettings['invoice_bg_image_top_url'])} alt="Top preview" className="h-10 object-contain rounded border border-border bg-white" />
                              <button type="button" onClick={() => setCompanySettings(p => ({ ...p, invoice_bg_image_top_url: '' }))} className="text-[10px] text-red-400 hover:text-red-700 dark:text-red-300">Remove</button>
                            </div>
                          )}
                        </div>
                        <div>
                          <label className="block text-[10px] font-medium text-muted-foreground mb-1">Bottom Image</label>
                          <label className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-secondary border border-border text-xs text-muted-foreground hover:text-foreground hover:border-border/80 cursor-pointer transition-colors">
                            Upload Bottom
                            <input type="file" accept="image/*" className="hidden" onChange={async e => {
                              const file = e.target.files?.[0]
                              if (!file) return
                                                          const supabase = createSupabaseClient()
                            const prep = await createBrandingUploadUrl({ key: 'invoice_bg_image_bottom_url', fileName: file.name })
                            if (!prep.ok || !prep.data) { alert('Upload failed: ' + prep.error); return }
                            const { error: upErr } = await supabase.storage.from('company-branding').uploadToSignedUrl(prep.data!.storagePath, prep.data!.token, file)
                            if (upErr) { alert('Upload failed: ' + upErr.message); return }
                            setCompanySettings(p => ({ ...p, invoice_bg_image_bottom_url: `storage:company-branding/${prep.data!.storagePath}` }))
                            }} />
                          </label>
                          {companySettings['invoice_bg_image_bottom_url'] && (
                            <div className="mt-2 flex items-center justify-between">
                              <img src={resolveBrandingUrl(companySettings['invoice_bg_image_bottom_url'])} alt="Bottom preview" className="h-10 object-contain rounded border border-border bg-white" />
                              <button type="button" onClick={() => setCompanySettings(p => ({ ...p, invoice_bg_image_bottom_url: '' }))} className="text-[10px] text-red-400 hover:text-red-700 dark:text-red-300">Remove</button>
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
                  {/* "Bulk Recalc" told you nothing about what it rewrites.
                      The ellipsis signals that a dialog follows rather than an
                      immediate write. */}
                  <button onClick={() => setShowRecalcCommissions(true)}
                    title="Re-run commission earnings for a date range"
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-secondary transition-colors text-muted-foreground">
                    <RefreshCw className="w-4 h-4" /> Recalculate commissions…
                  </button>
                  <button onClick={() => openEmployeeForm()}
                    className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90">
                    <Plus className="w-4 h-4" /> Add Employee
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2 mb-4">
                <div className="flex bg-secondary/30 backdrop-blur-sm border border-border/50 rounded-lg p-0.5 w-fit">
                  {(['active', 'archived', 'all'] as const).map(f => (
                    <button
                      key={f}
                      onClick={() => setEmpFilter(f)}
                      className={cn(
                        "px-3 py-1.5 text-[13px] font-medium rounded-md transition-all",
                        empFilter === f
                          ? "bg-background text-foreground shadow-sm ring-1 ring-border/50"
                          : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                      )}
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
              <div className="mb-6 bg-blue-500/[0.02] border border-blue-500/10 rounded-2xl p-5 shadow-sm">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center shrink-0 border border-blue-500/20 shadow-sm">
                    <KeyRound className="w-4 h-4 text-blue-500 dark:text-blue-400" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-foreground mb-1">Giving Employees App Access</p>
                    <p className="text-[13px] text-muted-foreground leading-relaxed mb-3">
                      Each employee can log into the app with their own email and password. Their role controls what they see.
                      To set up access:
                    </p>
                    <ol className="text-[13px] text-muted-foreground space-y-1.5 list-decimal list-inside">
                      <li>Make sure the employee record below has their correct email address</li>
                      <li>Click the <Send className="w-3 h-3 inline mx-0.5 text-violet-400" /> invite button on their row to generate a registration link</li>
                      <li>Share the link — they set their own password and log in at <strong className="text-foreground font-semibold">/login</strong></li>
                      <li>Their designation controls exactly what they can see and do</li>
                    </ol>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                {filteredEmployees.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 px-4 border border-dashed border-border/60 rounded-2xl bg-secondary/10">
                    <div className="w-12 h-12 rounded-full bg-secondary/50 flex items-center justify-center mb-3">
                      <Users className="w-5 h-5 text-muted-foreground" />
                    </div>
                    <h3 className="text-sm font-medium text-foreground mb-1">No employees found</h3>
                    <p className="text-xs text-muted-foreground text-center max-w-sm">
                      {empSearch ? 'No employees match your search criteria.' : 'Add your first employee to get started with payroll and access management.'}
                    </p>
                  </div>
                ) : filteredEmployees.map(emp => (
                  <div key={emp.id} className="group bg-card border border-border/40 rounded-2xl px-5 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:border-primary/20 hover:shadow-sm transition-all">
                    <div className="flex items-center gap-4">
                      <EmployeeAvatar
                        avatarUrl={(emp as any).avatar_url}
                        name={emp.name}
                        cqid={emp.cqid}
                        size={40}
                        rounded="xl"
                        className="shadow-sm border border-border/50"
                      />
                      <div>
                        <div className="flex items-center gap-2 mb-0.5">
                          <p className="font-semibold text-sm tracking-tight text-foreground">{emp.cqid}</p>
                          {isUnlocked && emp.name && (
                            // eslint-disable-next-line no-restricted-syntax -- deliberate: name shown only when privacy is unlocked, on the admin Employees settings page
                            <span className="text-[13px] text-foreground/80 font-medium">— {emp.name}</span>
                          )}
                          {emp.auth_id
                            ? <span className="text-[10px] font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded-full flex items-center gap-1"><span className="w-1 h-1 rounded-full bg-emerald-500"></span>Has Access</span>
                            : <span className="text-[10px] font-medium bg-secondary/50 text-muted-foreground border border-border px-2 py-0.5 rounded-full">No Login</span>
                          }
                        </div>
                        <p className="text-[13px] text-muted-foreground flex items-center flex-wrap gap-2">
                          <span>{ds(emp.email, '••••@••••.com')}</span>
                          <span className="w-1 h-1 rounded-full bg-border"></span>
                          <span className="capitalize">{emp.role.replace(/_/g, ' ')}</span>
                          <span className="w-1 h-1 rounded-full bg-border"></span>
                          <span className="flex items-center gap-1"><Zap className="w-3 h-3 text-amber-500/70" /> {emp.performance_rating}% rating</span>
                        </p>
                        {(() => {
                          const svcNames = empServices
                            .filter(es => es.employee_id === emp.id)
                            .map(es => services.find((s: any) => s.id === es.service_id)?.name)
                            .filter(Boolean)
                          if (svcNames.length === 0) return null
                          return (
                            <div className="flex flex-wrap gap-1 mt-1.5">
                              {svcNames.slice(0, 5).map(n => (
                                <span key={n} className="text-[10px] bg-primary/10 text-primary border border-primary/20 px-1.5 py-0.5 rounded-full font-medium">{n}</span>
                              ))}
                              {svcNames.length > 5 && (
                                <span className="text-[10px] text-muted-foreground/60 px-1 py-0.5">+{svcNames.length - 5} more</span>
                              )}
                            </div>
                          )
                        })()}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 opacity-100 md:opacity-40 md:group-hover:opacity-100 transition-opacity flex-wrap">
                      {emp.is_archived && (
                        <span className="text-[11px] font-medium px-2 py-1 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">Archived</span>
                      )}
                      {!emp.is_archived && (
                        <span className={cn(
                          "text-[11px] font-medium px-2 py-1 rounded-md border",
                          emp.is_active 
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20" 
                            : "bg-secondary text-muted-foreground border-border"
                        )}>
                          {emp.is_active ? 'Active' : 'Inactive'}
                        </span>
                      )}

                      <div className="h-4 w-px bg-border/50 mx-1 hidden sm:block" />

                      {/* Invite to register — when no auth_id and not archived */}
                      {!emp.auth_id && !emp.is_archived && (
                        <button
                          onClick={() => handleGenerateInvite(emp)}
                          disabled={inviteBusy === emp.id}
                          title="Generate invite link"
                          className="p-1.5 rounded-lg hover:bg-violet-500/10 text-muted-foreground hover:text-violet-600 dark:hover:text-violet-400 transition-colors disabled:opacity-50"
                        >
                          <Send className="w-4 h-4" />
                        </button>
                      )}

                      {/* Admin reset password — when registered */}
                      {emp.auth_id && !emp.is_archived && (
                        <button
                          onClick={() => askAdminResetPassword(emp)}
                          disabled={inviteBusy === emp.id}
                          title="Reset password (admin)"
                          className="p-1.5 rounded-lg hover:bg-blue-500/10 text-muted-foreground hover:text-blue-600 dark:hover:text-blue-400 transition-colors disabled:opacity-50"
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
                        className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground disabled:opacity-30"
                      >
                        {copiedPortalId === emp.id ? <Check className="w-4 h-4 text-emerald-500" /> : <Link2 className="w-4 h-4" />}
                      </button>

                      {/* Change avatar */}
                      <button
                        onClick={() => {
                          setAvatarModal({ id: emp.id, cqid: emp.cqid, name: emp.name, currentUrl: (emp as any).avatar_url ?? null })
                          setAvatarPickerValue((emp as any).avatar_url ?? null)
                        }}
                        className="p-1.5 rounded-lg hover:bg-violet-500/10 text-muted-foreground hover:text-violet-600 dark:hover:text-violet-400 transition-colors"
                        title="Change avatar"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"/>
                        </svg>
                      </button>

                      <Link href={`/dashboard/employees/${emp.id}`} className="p-1.5 rounded-lg hover:bg-blue-500/10 text-muted-foreground hover:text-blue-600 dark:hover:text-blue-400 transition-colors" title="View Profile">
                        <UserCog className="w-4 h-4" />
                      </Link>
                      <button onClick={() => openEmployeeForm(emp)} className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground" title="Edit">
                        <Edit2 className="w-4 h-4" />
                      </button>

                      {emp.is_archived ? (
                        <button
                          onClick={() => handleRestore(emp)}
                          disabled={inviteBusy === emp.id}
                          className="p-1.5 rounded-lg hover:bg-emerald-500/10 text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors disabled:opacity-50"
                          title="Restore employee"
                        >
                          <ArchiveRestore className="w-4 h-4" />
                        </button>
                      ) : (
                        <button
                          onClick={() => askArchive(emp)}
                          disabled={inviteBusy === emp.id}
                          className="p-1.5 rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-600 dark:hover:text-red-400 transition-colors disabled:opacity-50"
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
                <ArchFilterTabs value={archFilter} onChange={setArchFilter} />
                <SearchBar value={serviceSearch} onChange={setServiceSearch} placeholder="Search services…" className="flex-1" />
                <button onClick={() => setServiceSort(s => s === 'name' ? 'usage' : 'name')}
                  className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg bg-secondary border border-border text-muted-foreground hover:text-foreground transition-colors shrink-0">
                  <ArrowUpDown className="w-3 h-3" />
                  {serviceSort === 'usage' ? 'By usage' : 'A–Z'}
                </button>
                {/* Collapse / expand every department group at once. Disabled
                    while searching, because search force-opens all groups —
                    an enabled button that visibly does nothing is worse than
                    a disabled one that says why. */}
                {(() => {
                  const keys = Array.from(new Set(filteredServices.map((s: any) => s.category_id || 'uncategorised')))
                  const allCollapsed = keys.length > 0 && keys.every(k => collapsedDepts.has(k as string))
                  return (
                    <button
                      onClick={() => setCollapsedDepts(allCollapsed ? new Set() : new Set(keys as string[]))}
                      disabled={!!serviceSearch}
                      title={serviceSearch ? 'Groups stay open while searching' : allCollapsed ? 'Expand every department' : 'Collapse every department'}
                      className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg bg-secondary border border-border text-muted-foreground hover:text-foreground transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-muted-foreground">
                      {allCollapsed ? <ChevronsUpDown className="w-3 h-3" /> : <ChevronsDownUp className="w-3 h-3" />}
                      {allCollapsed ? 'Expand all' : 'Collapse all'}
                    </button>
                  )
                })()}
              </div>
              {/* Grouped by department — same taxonomy that drives employee
                  access, so the catalog reads the way access is granted. */}
              {(() => {
                const renderServiceRow = (svc: any) => {
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
                      <button onClick={() => { setEditingId(svc.id); setShowForm('service'); const gids = groupServices.filter(gs => gs.service_id === svc.id).map(gs => gs.group_id); const eids = empServices.filter(es => es.service_id === svc.id).map(es => es.employee_id); setForm({ ...svc, _groupIds: gids, _employeeIds: eids }) }}
                        className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground/40 hover:text-foreground shrink-0">
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div key={svc.id} className="bg-card border border-border rounded-xl px-5 py-4 flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-medium">{svc.name}</p>
                          {svc.is_active === false && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">Archived</span>
                          )}
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
                          {(() => {
                            const count = empServices.filter(es => es.service_id === svc.id).length
                            return count > 0
                              ? <span className="text-[10px] bg-blue-500/10 text-blue-500 dark:text-blue-400 border border-blue-500/20 px-2 py-0.5 rounded-full font-medium flex items-center gap-1"><Users className="w-2.5 h-2.5" />{count} employee{count === 1 ? '' : 's'}</span>
                              : <span className="text-[10px] text-muted-foreground/50 italic">No employees assigned</span>
                          })()}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => { setEditingId(svc.id); setShowForm('service'); const gids = groupServices.filter(gs => gs.service_id === svc.id).map(gs => gs.group_id); const eids = empServices.filter(es => es.service_id === svc.id).map(es => es.employee_id); setForm({ ...svc, _groupIds: gids, _employeeIds: eids }) }}
                          className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground">
                          <Edit2 className="w-4 h-4" />
                        </button>
                        {svc.is_active === false ? (
                          <button onClick={async () => {
                            const res = await reactivateService(svc.id)
                            if (!res.ok) { toast.error('Failed to restore', res.error); return }
                            setServices(prev => prev.map((x: any) => x.id === svc.id ? { ...x, is_active: true } : x))
                          }} className="p-2 rounded-lg hover:bg-emerald-500/15 text-muted-foreground hover:text-emerald-500 transition-colors" title="Restore service">
                            <ArchiveRestore className="w-4 h-4" />
                          </button>
                        ) : (
                          <button onClick={() => requestDelete('Service', svc.id, svc.name, async () => {
                            await deactivateService(svc.id)
                            setServices(prev => prev.map((x: any) => x.id === svc.id ? { ...x, is_active: false } : x))
                          })} className="p-2 rounded-lg hover:bg-amber-500/15 text-muted-foreground hover:text-amber-400 transition-colors" title="Archive service">
                            <Archive className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  )
                }
                const dotCls: Record<string, string> = {
                  violet: 'bg-violet-500', amber: 'bg-amber-500', blue: 'bg-blue-500',
                  emerald: 'bg-emerald-500', rose: 'bg-rose-500', cyan: 'bg-cyan-500',
                  orange: 'bg-orange-500', slate: 'bg-slate-400',
                }
                const deptGroups: any[] = [
                  ...serviceCategories.filter((c: any) => c.is_active !== false)
                    .sort((a: any, b: any) => (a.display_order ?? 0) - (b.display_order ?? 0)),
                  ...serviceCategories.filter((c: any) => c.is_active === false),
                  { id: null, name: 'No department' },
                ]
                return (
                  <div className="space-y-5">
                    {deptGroups.map((g: any) => {
                      const rows = filteredServices.filter((s: any) => (s.category_id || null) === (g.id || null))
                      if (rows.length === 0) return null
                      const key = g.id ?? 'uncategorised'
                      // A live search should never hide matches behind a collapsed
                      // header — while searching, every group is forced open.
                      const collapsed = collapsedDepts.has(key) && !serviceSearch
                      return (
                        <div key={key}>
                          <button
                            type="button"
                            onClick={() => setCollapsedDepts(prev => {
                              const next = new Set(prev)
                              if (next.has(key)) next.delete(key); else next.add(key)
                              return next
                            })}
                            className="w-full flex items-center gap-2 mb-1.5 group/dept"
                            aria-expanded={!collapsed}>
                            <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground/50 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
                            <span className={`w-2 h-2 rounded-full ${g.id ? (dotCls[g.color] || 'bg-muted-foreground/40') : 'bg-amber-500'}`} />
                            <h3 className={`text-[11px] font-semibold uppercase tracking-wider ${g.id ? 'text-muted-foreground group-hover/dept:text-foreground' : 'text-amber-500'} transition-colors`}>
                              {g.name}{g.is_active === false ? ' (archived)' : ''}
                            </h3>
                            <span className="text-[10px] text-muted-foreground/50">{rows.length}</span>
                            {!g.id && <span className="text-[10px] text-amber-500/70 italic">hidden from department-restricted employees</span>}
                            <span className="flex-1 h-px bg-border/40" />
                          </button>
                          {!collapsed && <div className="space-y-1.5">{rows.map(renderServiceRow)}</div>}
                        </div>
                      )
                    })}
                  </div>
                )
              })()}
            </div>
          )}

          {/* Departments — master data for the service taxonomy. Fully
              data-driven: rows created here flow straight into employee access
              via the scope engine, which resolves category membership at read
              time. No migration is ever needed for a new department. */}
          {tab === 'Departments' && (() => {
            const DEPT_COLORS = ['violet', 'amber', 'blue', 'emerald', 'rose', 'cyan', 'orange', 'slate']
            const dotCls: Record<string, string> = {
              violet: 'bg-violet-500', amber: 'bg-amber-500', blue: 'bg-blue-500',
              emerald: 'bg-emerald-500', rose: 'bg-rose-500', cyan: 'bg-cyan-500',
              orange: 'bg-orange-500', slate: 'bg-slate-400',
            }
            const active = serviceCategories.filter((c: any) => c.is_active !== false)
              .sort((a: any, b: any) => (a.display_order ?? 0) - (b.display_order ?? 0))
            const archived = serviceCategories.filter((c: any) => c.is_active === false)
            const activeServices = services.filter((s: any) => s.is_active !== false)
            const uncategorised = activeServices.filter((s: any) => !s.category_id)

            async function addDept() {
              const name = newDeptName.trim()
              if (!name || deptSaving) return
              setDeptSaving(true)
              const res = await createServiceCategory({ name, color: DEPT_COLORS[active.length % DEPT_COLORS.length] })
              setDeptSaving(false)
              if (!res.ok) { toast.error('Failed to create department', res.error); return }
              setServiceCategories(prev => [...prev, res.data])
              setNewDeptName('')
              toast.success(`Department "${name}" created`, 'Assign services to it from Services → Edit, then assign employees.')
            }

            async function move(id: string, dir: -1 | 1) {
              const idx = active.findIndex((c: any) => c.id === id)
              const swap = idx + dir
              if (swap < 0 || swap >= active.length) return
              const ordered = [...active]
              ;[ordered[idx], ordered[swap]] = [ordered[swap], ordered[idx]]
              // Optimistic — display_order mirrors the new index.
              setServiceCategories(prev => prev.map((c: any) => {
                const pos = ordered.findIndex((o: any) => o.id === c.id)
                return pos === -1 ? c : { ...c, display_order: pos + 1 }
              }))
              const res = await reorderServiceCategories(ordered.map((c: any) => c.id))
              if (!res.ok) toast.error('Reorder not saved', res.error)
            }

            const deptRow = (c: any) => {
              const svcCount = activeServices.filter((s: any) => s.category_id === c.id).length
              const empCount = empCategories.filter(ec => ec.category_id === c.id).length
              const isArchived = c.is_active === false
              return (
                <div key={c.id} className={`bg-card border rounded-xl px-4 py-3 flex items-center gap-3 ${isArchived ? 'border-border/50 opacity-60' : 'border-border'}`}>
                  <button
                    type="button"
                    title="Change colour"
                    onClick={async () => {
                      const next = DEPT_COLORS[(DEPT_COLORS.indexOf(c.color) + 1) % DEPT_COLORS.length]
                      setServiceCategories(prev => prev.map((x: any) => x.id === c.id ? { ...x, color: next } : x))
                      const res = await updateServiceCategory(c.id, { color: next })
                      if (!res.ok) toast.error('Colour not saved', res.error)
                    }}
                    className={`w-3.5 h-3.5 rounded-full shrink-0 ring-2 ring-transparent hover:ring-border transition-all ${dotCls[c.color] || 'bg-muted-foreground/40'}`}
                  />
                  <div className="flex-1 min-w-0">
                    <input
                      key={`${c.id}-name`}
                      defaultValue={c.name}
                      disabled={isArchived}
                      onBlur={async e => {
                        const v = e.target.value.trim()
                        if (!v || v === c.name) { e.target.value = c.name; return }
                        const res = await updateServiceCategory(c.id, { name: v })
                        if (!res.ok) { toast.error('Rename failed', res.error); e.target.value = c.name; return }
                        setServiceCategories(prev => prev.map((x: any) => x.id === c.id ? { ...x, name: v } : x))
                      }}
                      className="w-full bg-transparent text-sm font-medium border-b border-transparent hover:border-border/60 focus:border-primary focus:outline-none pb-0.5 disabled:pointer-events-none"
                    />
                    <input
                      key={`${c.id}-desc`}
                      defaultValue={c.description || ''}
                      disabled={isArchived}
                      placeholder="Description (optional)…"
                      onBlur={async e => {
                        const v = e.target.value.trim()
                        if (v === (c.description || '')) return
                        const res = await updateServiceCategory(c.id, { description: v || null })
                        if (!res.ok) { toast.error('Description not saved', res.error); return }
                        setServiceCategories(prev => prev.map((x: any) => x.id === c.id ? { ...x, description: v || null } : x))
                      }}
                      className="w-full bg-transparent text-xs text-muted-foreground border-b border-transparent hover:border-border/40 focus:border-primary focus:outline-none mt-0.5 disabled:pointer-events-none"
                    />
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${svcCount > 0 ? 'bg-primary/10 text-primary border-primary/20' : 'text-muted-foreground/50 border-border/50 italic'}`}>
                      {svcCount} service{svcCount === 1 ? '' : 's'}
                    </span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium flex items-center gap-1 ${empCount > 0 ? 'bg-blue-500/10 text-blue-500 dark:text-blue-400 border-blue-500/20' : 'text-muted-foreground/50 border-border/50 italic'}`}>
                      <Users className="w-2.5 h-2.5" />{empCount}
                    </span>
                  </div>
                  {!isArchived && (
                    <div className="flex flex-col shrink-0">
                      <button onClick={() => move(c.id, -1)} className="p-0.5 text-muted-foreground/50 hover:text-foreground disabled:opacity-20" disabled={active[0]?.id === c.id} title="Move up">
                        <ArrowUp className="w-3 h-3" />
                      </button>
                      <button onClick={() => move(c.id, 1)} className="p-0.5 text-muted-foreground/50 hover:text-foreground disabled:opacity-20" disabled={active[active.length - 1]?.id === c.id} title="Move down">
                        <ArrowDown className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                  {isArchived ? (
                    <button onClick={async () => {
                      const res = await setServiceCategoryActive(c.id, true)
                      if (!res.ok) { toast.error('Restore failed', res.error); return }
                      setServiceCategories(prev => prev.map((x: any) => x.id === c.id ? { ...x, is_active: true } : x))
                    }} className="p-2 rounded-lg hover:bg-emerald-500/15 text-muted-foreground hover:text-emerald-500 transition-colors shrink-0" title="Restore department">
                      <ArchiveRestore className="w-4 h-4" />
                    </button>
                  ) : (
                    <button onClick={() => requestDelete('Department', c.id, c.name, async () => {
                      const res = await setServiceCategoryActive(c.id, false)
                      if (!res.ok) { toast.error('Archive failed', res.error); return }
                      setServiceCategories(prev => prev.map((x: any) => x.id === c.id ? { ...x, is_active: false } : x))
                    })} className="p-2 rounded-lg hover:bg-amber-500/15 text-muted-foreground hover:text-amber-400 transition-colors shrink-0" title="Archive department">
                      <Archive className="w-4 h-4" />
                    </button>
                  )}
                </div>
              )
            }

            return (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <h2 className="text-sm font-semibold">Departments ({active.length})</h2>
                </div>
                <p className="text-xs text-muted-foreground mb-4">
                  Departments group services for employee access, client visibility and reporting.
                  Assign a service to a department in <span className="font-medium text-foreground/80">Services → Edit</span>;
                  assign employees to departments in <span className="font-medium text-foreground/80">Employees → Edit</span>.
                  Everyone assigned to a department automatically covers every service in it — including ones added later.
                </p>

                {/* Create */}
                <form onSubmit={e => { e.preventDefault(); addDept() }} className="flex items-center gap-2 mb-4">
                  <input
                    value={newDeptName}
                    onChange={e => setNewDeptName(e.target.value)}
                    placeholder="New department name — e.g. Photography, Web & Development…"
                    className="flex-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary"
                  />
                  <button type="submit" disabled={!newDeptName.trim() || deptSaving}
                    className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90 disabled:opacity-50">
                    <Plus className="w-4 h-4" /> {deptSaving ? 'Adding…' : 'Add Department'}
                  </button>
                </form>

                <div className="space-y-1.5">{active.map(deptRow)}</div>

                {uncategorised.length > 0 && (
                  <div className="mt-4 px-4 py-3 rounded-xl bg-amber-500/[0.06] border border-amber-500/20">
                    <p className="text-xs font-semibold text-amber-500 dark:text-amber-400 mb-1 flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5" /> {uncategorised.length} service{uncategorised.length === 1 ? '' : 's'} not in any department
                    </p>
                    <p className="text-[11px] text-muted-foreground mb-1.5">
                      Uncategorised services are invisible to department-restricted employees unless assigned directly.
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {uncategorised.map((s: any) => (
                        <button key={s.id} type="button"
                          onClick={() => { setEditingId(s.id); setShowForm('service'); const gids = groupServices.filter(gs => gs.service_id === s.id).map(gs => gs.group_id); const eids = empServices.filter(es => es.service_id === s.id).map(es => es.employee_id); setForm({ ...s, _groupIds: gids, _employeeIds: eids }) }}
                          className="text-[11px] px-2 py-0.5 rounded-full bg-secondary border border-border text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors">
                          {s.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {archived.length > 0 && (
                  <div className="mt-5">
                    <h3 className="text-xs font-semibold text-muted-foreground mb-2">Archived ({archived.length})</h3>
                    <div className="space-y-1.5">{archived.map(deptRow)}</div>
                  </div>
                )}
              </div>
            )
          })()}

          {/* Groups & Params */}
          {tab === 'Groups & Params' && (
            <div className="space-y-6">
              {/* How weights work — group weights are relative, the engine normalizes per task */}
              <div className="px-4 py-3 rounded-xl border bg-blue-500/[0.04] border-blue-500/15 text-xs text-muted-foreground leading-relaxed">
                <span className="font-semibold text-foreground">Weights are relative importance values, not fixed percentages.</span>{' '}
                When a task is scored, the weights of the groups actually used on that task are automatically
                normalized to split 100% of the commission pool — e.g. three groups weighted 50 / 50 / 50 each
                receive 33.3%, and 50 / 25 becomes 66.7% / 33.3%. Weights never need to sum to 100, and adding a
                group to a task can never push the total past 100%. The same applies to parameter weights within a group.
              </div>

              {/* Groups */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <h2 className="text-sm font-semibold">Contribution Groups ({filteredGroups.length}{groupSearch ? `/${groups.length}` : ''})</h2>
                    <button onClick={() => setQuickEdit(q => !q)}
                      className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border transition-all ${
                        quickEdit ? 'bg-amber-500/15 border-amber-500/30 text-amber-400' : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                      }`}>
                      <Zap className="w-3 h-3" /> {quickEdit ? 'Exit edit' : 'Quick edit'}
                    </button>
                  </div>
                  <button onClick={() => openForm('group', { weight: 50, display_order: groups.length + 1, is_active: true })} className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-3 py-2 rounded-lg hover:opacity-90 text-xs">
                    <Plus className="w-3.5 h-3.5" /> Add Group
                  </button>
                </div>
                <div className="flex items-center gap-2 mb-3">
                  <div className="flex bg-secondary/30 backdrop-blur-sm border border-border/50 rounded-lg p-0.5 w-fit shrink-0">
                    {(['active', 'archived', 'all'] as const).map(f => (
                      <button
                        key={f}
                        onClick={() => setGpFilter(f)}
                        className={cn(
                          "px-3 py-1.5 text-[13px] font-medium rounded-md transition-all",
                          gpFilter === f
                            ? "bg-background text-foreground shadow-sm ring-1 ring-border/50"
                            : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                        )}
                      >
                        {f === 'active' ? 'Active' : f === 'archived' ? 'Archived' : 'All'}
                      </button>
                    ))}
                  </div>
                  <SearchBar value={groupSearch} onChange={setGroupSearch} placeholder="Search groups…" className="flex-1" />
                </div>
                <div className="space-y-2">
                  {filteredGroups.map((g: any) => quickEdit ? (
                    <div key={g.id} className="bg-card border border-amber-500/20 rounded-xl px-3 py-2.5 flex items-center gap-2">
                      <input
                        key={`${g.id}-name`}
                        defaultValue={g.name}
                        onBlur={e => qeSave(quickEditGroup, g.id, 'name', e.target.value.trim(), setGroups as any)}
                        className="flex-1 bg-secondary border border-border/0 hover:border-border focus:border-primary rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:bg-background transition-colors"
                        placeholder="Group name"
                      />
                      <div className="flex items-center gap-1 shrink-0">
                        <span className="text-xs text-muted-foreground">Weight</span>
                        <input
                          key={`${g.id}-weight`}
                          defaultValue={g.weight}
                          type="number" min="0" step="0.01"
                          onBlur={e => {
                            // Guard: an accidentally-cleared field must not save weight 0
                            // (a 0-weight group zeroes every score computed from it alone).
                            const v = parseFloat(e.target.value)
                            if (!Number.isFinite(v) || v < 0) { e.target.value = String(g.weight); return }
                            if (v === g.weight) return
                            qeSave(quickEditGroup, g.id, 'weight', e.target.value, setGroups as any, () => v)
                          }}
                          className="w-16 bg-secondary border border-border/0 hover:border-border focus:border-primary rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none focus:bg-background transition-colors"
                        />
                      </div>
                      <button onClick={() => { setEditingId(g.id); setShowForm('group'); setForm(g) }}
                        className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground/40 hover:text-foreground shrink-0">
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div key={g.id} className="bg-card border border-border rounded-xl px-4 py-3 flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-sm">{g.name}</p>
                          {g.is_active === false && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">Archived</span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">Relative weight: {g.weight} · Order: {g.display_order}</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => { setEditingId(g.id); setShowForm('group'); setForm(g) }} className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground">
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        {g.is_active === false ? (
                          <button onClick={async () => {
                            await restoreGroup(g.id)
                            setGroups(prev => prev.map((x: any) => x.id === g.id ? { ...x, is_active: true } : x))
                          }} className="p-2 rounded-lg hover:bg-emerald-500/15 text-muted-foreground hover:text-emerald-500 transition-colors" title="Restore group">
                            <ArchiveRestore className="w-3.5 h-3.5" />
                          </button>
                        ) : (
                          <button onClick={() => requestDelete('Group', g.id, g.name, async () => {
                            await deactivateGroup(g.id)
                            setGroups(prev => prev.map((x: any) => x.id === g.id ? { ...x, is_active: false } : x))
                          })} className="p-2 rounded-lg hover:bg-amber-500/15 text-muted-foreground hover:text-amber-400 transition-colors" title="Archive group">
                            <Archive className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  {filteredGroups.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4 opacity-60">
                      {groupSearch ? `No groups match "${groupSearch}"` : gpFilter === 'archived' ? 'No archived groups' : 'No groups yet'}
                    </p>
                  )}
                </div>
              </div>

              {/* Parameters — bucketed under their group, collapsible */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold">Parameters ({filteredParams.length}{paramSearch ? `/${params.length}` : ''})</h2>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setExpandedParamGroups(prev =>
                      prev.size >= paramsByGroup.length
                        ? new Set()
                        : new Set(paramsByGroup.map(b => b.group?.id || '__none__'))
                    )} className="text-xs font-medium px-2.5 py-1.5 rounded-lg bg-secondary border border-border text-muted-foreground hover:text-foreground transition-colors">
                      {expandedParamGroups.size >= paramsByGroup.length && paramsByGroup.length > 0 ? 'Collapse all' : 'Expand all'}
                    </button>
                    <button onClick={() => openForm('param', { weight: 1, is_master: false, input_type: 'count', display_order: params.length + 1, is_active: true })} className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-3 py-2 rounded-lg hover:opacity-90 text-xs">
                      <Plus className="w-3.5 h-3.5" /> Add Parameter
                    </button>
                  </div>
                </div>
                <SearchBar value={paramSearch} onChange={setParamSearch} placeholder="Search parameters…" className="mb-3" />
                <div className="space-y-2">
                  {paramsByGroup.map(({ group, params: bucket }) => {
                    const gid = group?.id || '__none__'
                    // Searching auto-expands so matches are never hidden behind a collapsed header.
                    const isOpen = !!paramSearch || expandedParamGroups.has(gid)
                    return (
                      <div key={gid} className="bg-card border border-border rounded-xl overflow-hidden">
                        <button type="button"
                          onClick={() => setExpandedParamGroups(prev => {
                            const n = new Set(prev); n.has(gid) ? n.delete(gid) : n.add(gid); return n
                          })}
                          className="w-full flex items-center justify-between px-4 py-3 hover:bg-secondary/40 transition-colors">
                          <div className="flex items-center gap-2 min-w-0">
                            <ChevronRight className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                            <p className="font-medium text-sm truncate">{group?.name || 'No group assigned'}</p>
                            {group?.is_active === false && (
                              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 shrink-0">Group archived</span>
                            )}
                          </div>
                          <span className="text-xs text-muted-foreground shrink-0 ml-2">
                            {group ? <>Relative weight {group.weight} · </> : null}{bucket.length} parameter{bucket.length === 1 ? '' : 's'}
                          </span>
                        </button>
                        {isOpen && (
                          <div className="border-t border-border/50 divide-y divide-border/40">
                            {bucket.map((p: any) => {
                              const isMaster = p.is_master === true
                              const inputType = p.input_type || 'count'
                              return quickEdit ? (
                                <div key={p.id} className="px-3 py-2 flex items-center gap-2 bg-amber-500/[0.03]">
                                  <input
                                    key={`${p.id}-name`}
                                    defaultValue={p.name}
                                    onBlur={e => qeSave(quickEditParameter, p.id, 'name', e.target.value.trim(), setParams as any)}
                                    className="flex-1 bg-secondary border border-border/0 hover:border-border focus:border-primary rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:bg-background transition-colors"
                                    placeholder="Parameter name"
                                  />
                                  <div className="flex items-center gap-1 shrink-0">
                                    <span className="text-xs text-muted-foreground">Weight</span>
                                    <input
                                      key={`${p.id}-weight`}
                                      defaultValue={p.weight}
                                      type="number" min="0" step="0.001"
                                      onBlur={e => {
                                        const v = parseFloat(e.target.value)
                                        if (!Number.isFinite(v) || v < 0) { e.target.value = String(p.weight); return }
                                        if (v === p.weight) return
                                        qeSave(quickEditParameter, p.id, 'weight', e.target.value, setParams as any, () => v)
                                      }}
                                      className="w-20 bg-secondary border border-border/0 hover:border-border focus:border-primary rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none focus:bg-background transition-colors"
                                    />
                                  </div>
                                </div>
                              ) : (
                                <div key={p.id} className="px-4 py-2.5 flex items-center justify-between">
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2 mb-0.5">
                                      <p className="font-medium text-sm truncate">{p.name}</p>
                                      {isMaster && <span className="text-[10px] bg-purple-500/15 text-purple-400 border border-purple-500/20 px-1.5 py-0.5 rounded font-medium shrink-0">MASTER</span>}
                                      <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium shrink-0 ${inputType === 'percentage' ? 'bg-blue-500/10 text-blue-400 border-blue-500/20' : 'bg-secondary text-muted-foreground border-border'}`}>
                                        {inputType === 'percentage' ? '%' : '#'}
                                      </span>
                                      {p.is_active === false && (
                                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 shrink-0">Archived</span>
                                      )}
                                    </div>
                                    <p className="text-xs text-muted-foreground">Weight: {p.weight}</p>
                                  </div>
                                  <div className="flex items-center gap-1 shrink-0 ml-2">
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
                                    {p.is_active === false ? (
                                      <button onClick={async () => {
                                        await restoreParameter(p.id)
                                        setParams(prev => prev.map((x: any) => x.id === p.id ? { ...x, is_active: true } : x))
                                      }} className="p-2 rounded-lg hover:bg-emerald-500/15 text-muted-foreground hover:text-emerald-500 transition-colors" title="Restore parameter">
                                        <ArchiveRestore className="w-3.5 h-3.5" />
                                      </button>
                                    ) : (
                                      <button onClick={() => requestDelete('Parameter', p.id, p.name, async () => {
                                        await deactivateParameter(p.id)
                                        setParams(prev => prev.map((x: any) => x.id === p.id ? { ...x, is_active: false } : x))
                                      })} className="p-2 rounded-lg hover:bg-amber-500/15 text-muted-foreground hover:text-amber-400 transition-colors" title="Archive parameter">
                                        <Archive className="w-3.5 h-3.5" />
                                      </button>
                                    )}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {filteredParams.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4 opacity-60">
                      {paramSearch ? `No parameters match "${paramSearch}"` : gpFilter === 'archived' ? 'No archived parameters' : 'No parameters yet'}
                    </p>
                  )}
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
              <div className="flex items-center gap-2 mb-3">
                <ArchFilterTabs value={archFilter} onChange={setArchFilter} />
                <SearchBar value={toolSearch} onChange={setToolSearch} placeholder="Search tools…" className="flex-1" />
              </div>
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
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-sm">{tool.name}</p>
                          {tool.is_active === false && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">Archived</span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">Deducts {tool.fixed_percentage}% from {group?.name || '—'} group</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => { setEditingId(tool.id); setShowForm('tool'); setForm(tool) }}
                          className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground">
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        {tool.is_active === false ? (
                          <button onClick={async () => {
                            const res = await reactivateTool(tool.id)
                            if (!res.ok) { toast.error('Failed to restore', res.error); return }
                            setTools(prev => prev.map((x: any) => x.id === tool.id ? { ...x, is_active: true } : x))
                          }} className="p-2 rounded-lg hover:bg-emerald-500/15 text-muted-foreground hover:text-emerald-500 transition-colors" title="Restore tool">
                            <ArchiveRestore className="w-3.5 h-3.5" />
                          </button>
                        ) : (
                          <button onClick={() => requestDelete('Tool', tool.id, tool.name, async () => {
                            await deactivateTool(tool.id)
                            setTools(prev => prev.map((x: any) => x.id === tool.id ? { ...x, is_active: false } : x))
                          })} className="p-2 rounded-lg hover:bg-amber-500/15 text-muted-foreground hover:text-amber-400 transition-colors" title="Archive tool">
                            <Archive className="w-3.5 h-3.5" />
                          </button>
                        )}
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
                <h2 className="text-sm font-semibold">Bank Accounts ({filteredBankAccounts.length})</h2>
                <button onClick={() => openForm('bank', { is_active: true, type: 'bank', currency: 'INR', opening_balance: 0 })} className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90">
                  <Plus className="w-4 h-4" /> Add Account
                </button>
              </div>
              <div className="flex items-center gap-2 mb-3">
                <div className="flex bg-secondary border border-border rounded-lg p-0.5">
                  {(['active', 'archived', 'all'] as const).map(f => (
                    <button
                      key={f}
                      onClick={() => setBankFilter(f)}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${bankFilter === f ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                    >
                      {f === 'active' ? 'Active' : f === 'archived' ? 'Archived' : 'All'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                {filteredBankAccounts.length === 0 && (
                  <p className="text-sm text-muted-foreground py-6 text-center">
                    {bankFilter === 'archived' ? 'No archived accounts.' : 'No accounts.'}
                  </p>
                )}
                {filteredBankAccounts.map(b => (
                  <div key={b.id} className={`bg-card border border-border rounded-xl px-4 py-3 flex items-center justify-between ${b.is_active === false ? 'opacity-60' : ''}`}>
                    <div>
                      <p className="font-medium text-sm flex items-center gap-1.5">
                        {b.name}
                        {b.is_default && <span className="text-xs px-2 py-0.5 rounded-md bg-yellow-500/15 text-yellow-400">Default</span>}
                      </p>
                      <p className="text-xs text-muted-foreground capitalize">{b.type} · {b.currency} · {b.account_number}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-2 py-0.5 rounded-md ${b.is_active === false ? 'bg-amber-500/15 text-amber-400' : 'bg-green-500/15 text-green-400'}`}>
                        {b.is_active === false ? 'Archived' : 'Active'}
                      </span>
                      {b.is_active !== false && (
                        <button
                          onClick={() => !b.is_default && makeDefaultBank(b.id)}
                          disabled={b.is_default}
                          className={`p-2 rounded-lg transition-colors ${b.is_default ? 'text-yellow-400' : 'text-muted-foreground hover:text-yellow-400 hover:bg-secondary'}`}
                          title={b.is_default ? 'Default account' : 'Set as default account'}
                        >
                          <Star className="w-3.5 h-3.5" fill={b.is_default ? 'currentColor' : 'none'} />
                        </button>
                      )}
                      <button onClick={() => { setEditingId(b.id); setShowForm('bank'); setForm(b) }} className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground">
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      {b.is_active === false ? (
                        <button
                          onClick={async () => {
                            const res = await reactivateBankAccount(b.id)
                            if (!res.ok) { toast.error('Failed to restore', res.error); return }
                            setBankAccounts(prev => prev.map((x) => x.id === b.id ? { ...x, is_active: true } : x))
                          }}
                          className="p-2 rounded-lg hover:bg-emerald-500/15 text-muted-foreground hover:text-emerald-400 transition-colors"
                          title="Restore bank account"
                        >
                          <ArchiveRestore className="w-3.5 h-3.5" />
                        </button>
                      ) : (
                        <button onClick={() => requestDelete('Bank Account', b.id, b.name, async () => {
                          await deactivateBankAccount(b.id)
                          setBankAccounts(prev => prev.map((x) => x.id === b.id ? { ...x, is_active: false } : x))
                        })} className="p-2 rounded-lg hover:bg-amber-500/15 text-muted-foreground hover:text-amber-400 transition-colors" title="Archive bank account">
                          <Archive className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Cash Categories */}
          {tab === 'Cash Categories' && (
            <div>
              <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
                <h2 className="text-sm font-semibold">Cash Book Categories ({categories.length})</h2>
                <ArchFilterTabs value={archFilter} onChange={setArchFilter} />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                {(['inflow', 'outflow', 'both'] as const).map(type => {
                  const styleMap: Record<string, { header: string; addBtn: string; dot: string }> = {
                    inflow:  { header: 'bg-green-500/10 text-green-400',  addBtn: 'hover:bg-green-500/15 hover:text-green-400', dot: 'bg-green-400' },
                    outflow: { header: 'bg-red-500/10 text-red-400',      addBtn: 'hover:bg-red-500/15 hover:text-red-400',    dot: 'bg-red-400' },
                    both:    { header: 'bg-blue-500/10 text-blue-400',    addBtn: 'hover:bg-blue-500/15 hover:text-blue-400',  dot: 'bg-blue-400' },
                  }
                  const s = styleMap[type]
                  const filtered = categories.filter((c: any) => c.type === type
                    && (archFilter === 'active' ? c.is_active !== false : archFilter === 'archived' ? c.is_active === false : true))
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
                            <span className={`text-sm ${c.is_active === false ? 'text-muted-foreground line-through decoration-border' : ''}`}>{c.name}</span>
                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={() => { setEditingId(c.id); setShowForm('category'); setForm(c) }}
                                className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                              {c.is_active === false ? (
                                <button
                                  onClick={async () => {
                                    const res = await reactivateCashbookCategory(c.id)
                                    if (!res.ok) { toast.error('Failed to restore', res.error); return }
                                    setCategories((prev: any[]) => prev.map((x: any) => x.id === c.id ? { ...x, is_active: true } : x))
                                  }}
                                  title="Restore category"
                                  className="p-1.5 rounded-md hover:bg-emerald-500/15 text-muted-foreground hover:text-emerald-500"
                                >
                                  <ArchiveRestore className="w-3.5 h-3.5" />
                                </button>
                              ) : (
                                <button
                                  onClick={() => requestDelete('Category', c.id, c.name, async () => {
                                    await deactivateCashbookCategory(c.id)
                                    setCategories((prev: any[]) => prev.map((x: any) => x.id === c.id ? { ...x, is_active: false } : x))
                                  })}
                                  title="Archive category (past entries are preserved)"
                                  className="p-1.5 rounded-md hover:bg-amber-500/15 text-muted-foreground hover:text-amber-400"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              )}
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
                    className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-200 hover:bg-violet-500/20 shrink-0 disabled:opacity-50"
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
                              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${existing.rate_source === 'api' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'}`}>
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
          {tab === 'Matching' && (
            <div className="max-w-4xl space-y-6 animate-in fade-in zoom-in-95 duration-200">
              <div className="flex flex-col gap-1 border-b border-border/50 pb-4 mb-4">
                <h2 className="text-lg font-semibold tracking-tight flex items-center gap-2">
                  <RefreshCw className="w-5 h-5 text-amber-500" />
                  Rebuild Payment Matching
                </h2>
                <p className="text-sm text-muted-foreground">
                  Re-links every recorded payment to its invoices, oldest first, for one client at a time.
                  Use it only when a client&rsquo;s paid/outstanding figures look wrong — it rewrites that
                  client&rsquo;s payment history. You preview and approve before anything is committed.
                </p>
              </div>
              <div className="bg-card border border-border rounded-xl p-5 shadow-sm">
                <AllocationRebuildPanel />
              </div>
            </div>
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
                            {d.name}
                            {d.is_admin ? ' (Admin — full access)'
                              : (props.criticalDesignationIds || []).includes(d.id) ? ' ⚠ critical access' : ''}
                          </option>
                        ))}
                      </AppSelect>
                      {/* The safety net for the exact mistake this exists for:
                          picking a role without realising it carries pricing /
                          earnings visibility. Loud, red, at decision time. */}
                      {form.designation_id && !props.designations.find(d => d.id === form.designation_id)?.is_admin
                        && (props.criticalDesignationIds || []).includes(form.designation_id) && (
                        <p className="mt-1.5 text-xs text-red-600 dark:text-red-400 font-medium">
                          ⚠ This designation includes critical access — confidential pricing, employee earnings or
                          personal data. Check its permissions in Settings → Designations before assigning it.
                        </p>
                      )}
                    </FieldRow>
                  )}

                  {/* Services / task types this employee works on — employee_services junction */}
                  <FieldRow label={<span className="flex items-center gap-1">Services / Task Types <InfoTip text="Which services this employee usually works on. Tick a CATEGORY to grant the whole discipline — services added to it later are included automatically. Tick individual services for anything extra. Contribution scoring offers only the employees assigned to a task's service. Editing the same assignment from Settings → Services updates here too." /></span>}>
                    {(() => {
                      const selectedSvc: string[] = form._serviceIds || []
                      const selectedCat: string[] = form._categoryIds || []
                      const activeSvcs = services.filter((s: any) => s.is_active)

                      // Group the catalog by category, preserving display_order,
                      // with anything unclassified collected at the end. A
                      // service with a category_id pointing at a since-deleted
                      // category also lands there rather than vanishing.
                      const known = new Set(serviceCategories.map((c: any) => c.id))
                      const groups: { cat: any | null; svcs: any[] }[] = serviceCategories
                        .filter((c: any) => c.is_active !== false)
                        .map((c: any) => ({ cat: c, svcs: activeSvcs.filter((s: any) => s.category_id === c.id) }))
                        .filter((g: any) => g.svcs.length > 0)
                      const orphans = activeSvcs.filter((s: any) => !s.category_id || !known.has(s.category_id))
                      if (orphans.length > 0) groups.push({ cat: null, svcs: orphans })

                      const toggleCat = (id: string) => setForm((p: any) => ({
                        ...p,
                        _categoryIds: (p._categoryIds || []).includes(id)
                          ? (p._categoryIds || []).filter((x: string) => x !== id)
                          : [...(p._categoryIds || []), id],
                      }))
                      const toggleSvc = (id: string) => setForm((p: any) => ({
                        ...p,
                        _serviceIds: (p._serviceIds || []).includes(id)
                          ? (p._serviceIds || []).filter((x: string) => x !== id)
                          : [...(p._serviceIds || []), id],
                      }))

                      return (
                        <div className="space-y-3">
                          {groups.map(({ cat, svcs }) => {
                            const catOn = cat ? selectedCat.includes(cat.id) : false
                            return (
                              <div key={cat?.id || '_uncategorised'} className="rounded-lg border border-border/60 p-2.5">
                                <div className="flex items-center justify-between mb-2">
                                  {cat ? (
                                    <label className="flex items-center gap-2 cursor-pointer select-none">
                                      <input type="checkbox" checked={catOn} onChange={() => toggleCat(cat.id)}
                                        className="w-3.5 h-3.5 rounded border-border accent-primary" />
                                      <span className="text-xs font-semibold">{cat.name}</span>
                                      <span className="text-[11px] text-muted-foreground/60">{svcs.length}</span>
                                    </label>
                                  ) : (
                                    <span className="text-xs font-semibold text-muted-foreground">
                                      Uncategorised <span className="text-[11px] font-normal text-muted-foreground/60">{svcs.length}</span>
                                    </span>
                                  )}
                                  {catOn && (
                                    <span className="text-[11px] text-primary">whole category — future services included</span>
                                  )}
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                  {svcs.map((svc: any) => {
                                    const direct = selectedSvc.includes(svc.id)
                                    // In scope via the category: shown as on, but
                                    // not individually removable while the
                                    // category is ticked — untick the category.
                                    const viaCat = catOn && !direct
                                    return (
                                      <button key={svc.id} type="button"
                                        onClick={() => toggleSvc(svc.id)}
                                        title={viaCat ? 'Included by its category. Untick the category to change this individually.' : undefined}
                                        className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                                          direct
                                            ? 'bg-primary/15 text-primary border-primary/30'
                                            : viaCat
                                              ? 'bg-primary/5 text-primary/70 border-primary/20 border-dashed'
                                              : 'bg-secondary text-muted-foreground border-transparent hover:border-border hover:text-foreground'
                                        }`}>
                                        {direct ? '✓ ' : viaCat ? '◇ ' : ''}{svc.name}
                                      </button>
                                    )
                                  })}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )
                    })()}
                    {(form._serviceIds || []).length === 0 && (form._categoryIds || []).length === 0 && (
                      <p className="text-xs text-muted-foreground/60 mt-1.5">No services assigned — this employee appears for every task type in contribution scoring.</p>
                    )}
                  </FieldRow>

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

                  {/* Department — drives employee access + client visibility.
                      Category membership is resolved at read time by the scope
                      engine, so moving a service here re-scopes everyone
                      instantly with no re-assignment. */}
                  <FieldRow label={<span className="flex items-center gap-1">Department <InfoTip text="Employees assigned to this department automatically see this service, its tasks and its clients. Moving the service to another department updates visibility instantly — no employee re-assignment needed. Manage departments in Settings → Departments." /></span>}>
                    <AppSelect
                      value={form.category_id || ''}
                      onChange={e => setForm(p => ({ ...p, category_id: e.target.value || null }))}>
                      <option value="">— No department (uncategorised) —</option>
                      {serviceCategories
                        .filter((c: any) => c.is_active !== false || c.id === form.category_id)
                        .sort((a: any, b: any) => (a.display_order ?? 0) - (b.display_order ?? 0))
                        .map((c: any) => (
                          <option key={c.id} value={c.id}>{c.is_active === false ? `${c.name} (archived)` : c.name}</option>
                        ))}
                    </AppSelect>
                    {!form.category_id && (
                      <p className="text-[11px] text-amber-500/90 mt-1">Uncategorised services are hidden from department-restricted employees unless assigned to them directly.</p>
                    )}
                  </FieldRow>

                  {/* Contribution Groups */}
                  <FieldRow label={<span className="flex items-center gap-1">Contribution Groups <InfoTip text="Select which groups apply to this service — only those appear in the Contribution Entry screen for its tasks. Leave empty to make ALL groups available. Weights auto-normalize per task, so any combination always splits exactly 100%." /></span>}>
                    <div className="space-y-2">
                      {/* Active groups, plus archived ones already linked (badged) so stale links stay visible */}
                      {groups.filter((g: any) => g.is_active !== false || (form._groupIds || []).includes(g.id)).map((g: any) => {
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
                              <p className="font-medium flex items-center gap-2">
                                {g.name}
                                {g.is_active === false && (
                                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">Archived</span>
                                )}
                              </p>
                              <p className="text-xs opacity-60">Relative weight: {g.weight}</p>
                            </div>
                            <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-all ${
                              isSelected ? 'border-primary bg-primary' : 'border-muted-foreground/30'
                            }`}>
                              {isSelected && <span className="text-white text-xs font-bold">✓</span>}
                            </div>
                          </button>
                        )
                      })}
                      {/* Live normalized preview — the split the engine will actually use.
                          Future per-service weight overrides would feed resolved junction
                          weights into normalizeGroupWeights here (see lib/contributions/weights.ts). */}
                      {(() => {
                        const selectedIds: string[] = form._groupIds || []
                        // Scoring only ever sees ACTIVE groups — the preview must mirror that.
                        const selectedGroups = groups.filter((g: any) => selectedIds.includes(g.id) && g.is_active !== false)
                        if (selectedIds.length > 0 && selectedGroups.length === 0) return (
                          <p className="text-xs text-amber-400 mt-1">⚠ Every selected group is archived — tasks of this service will have nothing to score. Restore the groups or select active ones.</p>
                        )
                        if (selectedGroups.length === 0) return (
                          <p className="text-xs text-muted-foreground mt-1">No groups selected — <span className="font-medium text-foreground/80">all groups</span> will be available when scoring tasks of this service.</p>
                        )
                        const split = normalizeGroupWeights(selectedGroups)
                        return (
                          <div className="mt-1 px-3 py-2.5 rounded-lg bg-blue-500/[0.05] border border-blue-500/15">
                            <p className="text-[11px] font-semibold text-blue-500 dark:text-blue-400 mb-1.5">Effective split when scoring (weights auto-normalize to 100%)</p>
                            <div className="flex w-full h-2 rounded-full overflow-hidden bg-secondary mb-1.5">
                              {split.map((g, i) => (
                                <div key={g.id} title={`${g.name}: ${g.pct.toFixed(1)}%`}
                                  className={i % 2 === 0 ? 'bg-primary/70' : 'bg-blue-400/70'}
                                  style={{ width: `${g.pct}%` }} />
                              ))}
                            </div>
                            <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                              {split.map(g => (
                                <span key={g.id} className="text-[11px] text-muted-foreground">
                                  {g.name.replace(' Group', '')} <span className="font-semibold text-foreground">{g.pct.toFixed(g.pct % 1 === 0 ? 0 : 1)}%</span>
                                </span>
                              ))}
                            </div>
                          </div>
                        )
                      })()}
                    </div>
                  </FieldRow>

                  {/* Assigned employees — employee_services junction (same rows as the employee form) */}
                  <FieldRow label={<span className="flex items-center gap-1">Assigned Employees <InfoTip text="Employees who work on this service. Members of this service's department are included automatically and can only be removed by changing their department assignment (Employees → Edit). Direct assignment here adds people from outside the department. Contribution scoring for tasks of this service offers only these employees." /></span>}>
                    <div className="flex flex-wrap gap-1.5">
                      {(() => {
                        // Department members get this service via employee_service_categories —
                        // shown locked so nobody thinks a click here can revoke what the
                        // department grants. Direct (employee_services) pills stay toggleable.
                        const deptMemberIds = new Set(
                          form.category_id ? empCategories.filter(ec => ec.category_id === form.category_id).map(ec => ec.employee_id) : [],
                        )
                        const deptName = serviceCategories.find((c: any) => c.id === form.category_id)?.name
                        return employees.filter((emp: any) => emp.is_active && !emp.is_archived).map((emp: any) => {
                          const selected: string[] = form._employeeIds || []
                          const isSelected = selected.includes(emp.id)
                          const viaDept = deptMemberIds.has(emp.id)
                          if (viaDept) return (
                            <span key={emp.id}
                              title={`Included automatically — member of the ${deptName} department. Manage in Employees → Edit.`}
                              className="px-2.5 py-1 rounded-full text-xs font-medium border bg-violet-500/10 text-violet-500 dark:text-violet-400 border-violet-500/30 cursor-default inline-flex items-center gap-1">
                              <Lock className="w-3 h-3" />
                              {/* eslint-disable-next-line no-restricted-syntax -- deliberate: name shown only when privacy is unlocked, on the admin settings employee picker */}
                              {emp.cqid}{isUnlocked && emp.name ? ` · ${emp.name}` : ''}
                              <span className="opacity-70">· dept</span>
                            </span>
                          )
                          return (
                            <button key={emp.id} type="button"
                              onClick={() => setForm((p: any) => ({
                                ...p,
                                _employeeIds: isSelected
                                  ? (p._employeeIds || []).filter((id: string) => id !== emp.id)
                                  : [...(p._employeeIds || []), emp.id],
                              }))}
                              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                                isSelected
                                  ? 'bg-primary/15 text-primary border-primary/30'
                                  : 'bg-secondary text-muted-foreground border-transparent hover:border-border hover:text-foreground'
                              }`}>
                              {/* eslint-disable-next-line no-restricted-syntax -- deliberate: name shown only when privacy is unlocked, on the admin settings employee picker */}
                              {isSelected ? '✓ ' : ''}{emp.cqid}{isUnlocked && emp.name ? ` · ${emp.name}` : ''}
                            </button>
                          )
                        })
                      })()}
                    </div>
                    {(() => {
                      const deptCount = form.category_id ? empCategories.filter(ec => ec.category_id === form.category_id).length : 0
                      const directCount = (form._employeeIds || []).length
                      if (deptCount + directCount === 0) return (
                        <p className="text-xs text-muted-foreground/60 mt-1.5">No employees assigned — every employee appears for this service in contribution scoring.</p>
                      )
                      if (deptCount > 0) return (
                        <p className="text-xs text-muted-foreground/60 mt-1.5">{deptCount} via department{directCount > 0 ? ` + ${directCount} direct` : ''}.</p>
                      )
                      return null
                    })()}
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
                    <FieldRow label={<span className="flex items-center gap-1">Relative Weight <InfoTip text="Importance relative to other groups — NOT a fixed percentage. When a task is scored, the weights of the groups used on it are normalized to split 100% of the pool (e.g. 50/50/50 → 33.3% each). Weights never need to sum to 100." /></span>}><input type="number" min="0" step="0.01" value={form.weight || ''} onChange={e => setForm(p => ({ ...p, weight: parseFloat(e.target.value) || 0 }))} className={inputCls} placeholder="e.g. 50" /></FieldRow>
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
                            ? 'bg-purple-500/15 border-purple-500/30 text-purple-700 dark:text-purple-300'
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
                              ? 'bg-blue-500/15 border-blue-500/30 text-blue-700 dark:text-blue-300'
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
                  if (!res.ok) { toast.error('Failed to save avatar', res.error); return }
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

      {confirmPrompt && (
        <ConfirmDialog
          title={confirmPrompt.title}
          body={confirmPrompt.body}
          confirmLabel={confirmPrompt.confirmLabel}
          danger={confirmPrompt.danger}
          onConfirm={() => { const fn = confirmPrompt.onConfirm; setConfirmPrompt(null); fn() }}
          onCancel={() => setConfirmPrompt(null)}
        />
      )}

      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
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
  const companyName = companySettings.company_name || 'Cirqle Works'

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

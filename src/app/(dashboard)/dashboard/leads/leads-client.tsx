'use client'

/**
 * Leads CRM — the interactive client. All reads come from the server page as
 * plain props; every write goes through actions.ts. Employee names render via
 * <EmployeeName> so the CQID privacy system is respected (build lint enforces).
 */

import { useMemo, useState, useTransition } from 'react'
import Header from '@/components/layout/header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import AppSelect from '@/components/ui/app-select'
import { EmptyState } from '@/components/ui/empty-state'
import { EmployeeName } from '@/components/ui/employee-name'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ToastContainer, useToast } from '@/components/ui/toast'
import { formatDistanceToNow } from 'date-fns'
import {
  UserPlus, Search, Zap, Trash2, X, Mail, Phone, Megaphone, FileText, Loader2,
} from 'lucide-react'
import {
  createLead, updateLead, updateLeadStatus, assignLead, deleteLead,
  saveAutomationRule, toggleAutomationRule, deleteAutomationRule,
  type LeadStatus,
} from './actions'

// ── Types (mirror the leads / lead_automation_rules rows) ────────────────────

interface Lead {
  id: string
  client_id: string
  source: string
  external_lead_id: string | null
  status: LeadStatus
  full_name: string | null
  email: string | null
  phone: string | null
  raw_fields: Record<string, string> | null
  form_name: string | null
  page_external_id: string | null
  campaign_name: string | null
  adset_name: string | null
  ad_name: string | null
  assigned_to: string | null
  first_contacted_at: string | null
  notes: string | null
  submitted_at: string | null
  created_at: string
}
interface ClientRow { id: string; name: string; is_active?: boolean }
interface EmployeeRow { id: string; cqid: string | null; name: string | null }
interface AutomationRule {
  id: string
  client_id: string | null
  trigger: string
  condition: Record<string, unknown> | null
  action: string
  action_config: Record<string, unknown> | null
  is_active: boolean
}

const STATUSES: LeadStatus[] = ['new', 'contacted', 'qualified', 'won', 'lost']
const STATUS_STYLE: Record<LeadStatus, string> = {
  new: 'bg-violet-500/15 text-violet-400',
  contacted: 'bg-blue-500/15 text-blue-400',
  qualified: 'bg-yellow-500/15 text-yellow-400',
  won: 'bg-green-500/15 text-green-400',
  lost: 'bg-gray-500/15 text-gray-400',
}
const STATUS_LABEL: Record<LeadStatus, string> = {
  new: 'New', contacted: 'Contacted', qualified: 'Qualified', won: 'Won', lost: 'Lost',
}
const TRIGGER_LABEL: Record<string, string> = {
  lead_created: 'When a new lead arrives',
  lead_status_changed: 'When a lead status changes',
  lead_uncontacted: 'When a lead stays uncontacted',
}
const ACTION_LABEL: Record<string, string> = {
  assign_employee: 'Assign to employee',
  create_task_request: 'Create a follow-up task',
  notify_employees: 'Notify employees',
  notify_admins: 'Notify all admins',
}

function rel(dateStr: string | null): string {
  if (!dateStr) return '—'
  try { return formatDistanceToNow(new Date(dateStr), { addSuffix: true }) } catch { return '—' }
}

export default function LeadsClient({
  leads: initialLeads, clients, employees, rules: initialRules,
  statusCounts30d, sourceCounts30d, totalLeads, canManage, initialFilters,
}: {
  leads: Lead[]
  clients: ClientRow[]
  employees: EmployeeRow[]
  rules: AutomationRule[]
  statusCounts30d: Record<string, number>
  sourceCounts30d: Record<string, number>
  totalLeads: number
  canManage: boolean
  initialFilters: { status: string; client: string; assigned: string; q: string }
}) {
  const toast = useToast()
  const [, startTransition] = useTransition()
  const [tab, setTab] = useState<'pipeline' | 'automation'>('pipeline')

  const [leads, setLeads] = useState<Lead[]>(initialLeads)
  const [rules, setRules] = useState<AutomationRule[]>(initialRules)

  // Filters (client-side over the server-loaded window)
  const [status, setStatus] = useState(initialFilters.status)
  const [client, setClient] = useState(initialFilters.client)
  const [assigned, setAssigned] = useState(initialFilters.assigned)
  const [q, setQ] = useState(initialFilters.q)

  const [selected, setSelected] = useState<Lead | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [ruleModal, setRuleModal] = useState<AutomationRule | 'new' | null>(null)
  const [deleteRuleTarget, setDeleteRuleTarget] = useState<AutomationRule | null>(null)

  const empName = useMemo(() => {
    const m = new Map<string, EmployeeRow>()
    for (const e of employees) m.set(e.id, e)
    return m
  }, [employees])
  const clientName = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of clients) m.set(c.id, c.name)
    return m
  }, [clients])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return leads.filter((l) => {
      if (status && l.status !== status) return false
      if (client && l.client_id !== client) return false
      if (assigned === 'unassigned' && l.assigned_to) return false
      else if (assigned && assigned !== 'unassigned' && l.assigned_to !== assigned) return false
      if (needle) {
        const hay = `${l.full_name ?? ''} ${l.email ?? ''} ${l.phone ?? ''} ${l.campaign_name ?? ''}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [leads, status, client, assigned, q])

  const metaShare = useMemo(() => {
    const total = Object.values(sourceCounts30d).reduce((a, b) => a + b, 0)
    if (!total) return 0
    return Math.round(((sourceCounts30d.meta_lead_ad ?? 0) / total) * 100)
  }, [sourceCounts30d])

  // ── mutators (optimistic) ──────────────────────────────────────────────────
  function patchLead(id: string, patch: Partial<Lead>) {
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)))
    setSelected((s) => (s && s.id === id ? { ...s, ...patch } : s))
  }

  function onStatus(lead: Lead, next: LeadStatus) {
    patchLead(lead.id, { status: next })
    startTransition(async () => {
      const res = await updateLeadStatus(lead.id, next)
      if (!res.ok) { toast.error('Could not update status', res.error); patchLead(lead.id, { status: lead.status }) }
      else if (res.data?.first_contacted_at) patchLead(lead.id, { first_contacted_at: res.data.first_contacted_at })
    })
  }

  function onAssign(lead: Lead, employeeId: string | null) {
    patchLead(lead.id, { assigned_to: employeeId })
    startTransition(async () => {
      const res = await assignLead(lead.id, employeeId)
      if (!res.ok) { toast.error('Could not assign', res.error); patchLead(lead.id, { assigned_to: lead.assigned_to }) }
    })
  }

  return (
    <>
      <Header
        title="Leads"
        subtitle="Meta Lead Ads and manual leads across every client"
        actions={
          canManage ? (
            <Button size="sm" onClick={() => setShowAdd(true)}>
              <UserPlus className="w-4 h-4 mr-1.5" /> Add lead
            </Button>
          ) : undefined
        }
      />

      <div className="px-4 sm:px-6 pb-16 max-w-[1400px] mx-auto w-full">
        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-border mb-4">
          {(['pipeline', 'automation'] as const).map((t) => (
            (t === 'automation' && !canManage) ? null : (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  tab === t ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {t === 'pipeline' ? 'Pipeline' : 'Automation'}
              </button>
            )
          ))}
        </div>

        {tab === 'pipeline' && (
          <>
            {/* KPI strip */}
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2.5 mb-4">
              <KpiTile label="Total leads" value={totalLeads} />
              {STATUSES.map((s) => (
                <KpiTile key={s} label={STATUS_LABEL[s]} sub="30d" value={statusCounts30d[s] ?? 0} />
              ))}
              <KpiTile label="From Meta" sub="30d" value={`${metaShare}%`} />
            </div>

            {/* Filters */}
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <div className="relative flex-1 min-w-[180px]">
                <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search name, email, phone, campaign…"
                  className="w-full h-9 pl-8 pr-3 rounded-lg bg-secondary text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <AppSelect value={status} onChange={(e) => setStatus(e.target.value)} wrapperClassName="w-auto">
                <option value="">All statuses</option>
                {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </AppSelect>
              <AppSelect value={client} onChange={(e) => setClient(e.target.value)} wrapperClassName="w-auto">
                <option value="">All clients</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </AppSelect>
              <AppSelect value={assigned} onChange={(e) => setAssigned(e.target.value)} wrapperClassName="w-auto">
                <option value="">Anyone</option>
                <option value="unassigned">Unassigned</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.cqid || e.name}</option>)}
              </AppSelect>
            </div>

            {filtered.length === 0 ? (
              <Card>
                <CardContent className="p-0">
                  <EmptyState
                    icon={UserPlus}
                    title="No leads here"
                    body="Meta Lead Ads land here automatically once a Page with lead forms is connected and its webhook is live. You can also add leads manually."
                    action={canManage ? { label: 'Add lead', onClick: () => setShowAdd(true) } : undefined}
                  />
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="p-0 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground border-b border-border">
                        <th className="font-medium px-3 py-2.5">Lead</th>
                        <th className="font-medium px-3 py-2.5 hidden md:table-cell">Client</th>
                        <th className="font-medium px-3 py-2.5 hidden lg:table-cell">Source / Campaign</th>
                        <th className="font-medium px-3 py-2.5">Status</th>
                        <th className="font-medium px-3 py-2.5 hidden sm:table-cell">Owner</th>
                        <th className="font-medium px-3 py-2.5 hidden xl:table-cell">Received</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((l) => (
                        <tr
                          key={l.id}
                          onClick={() => setSelected(l)}
                          className="border-b border-border/60 last:border-0 hover:bg-secondary/50 cursor-pointer"
                        >
                          <td className="px-3 py-2.5">
                            <div className="font-medium text-foreground">{l.full_name || l.email || l.phone || 'Unnamed lead'}</div>
                            <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
                              {l.email && <span className="inline-flex items-center gap-1"><Mail className="w-3 h-3" />{l.email}</span>}
                              {l.phone && <span className="inline-flex items-center gap-1"><Phone className="w-3 h-3" />{l.phone}</span>}
                            </div>
                          </td>
                          <td className="px-3 py-2.5 hidden md:table-cell text-muted-foreground">{clientName.get(l.client_id) ?? '—'}</td>
                          <td className="px-3 py-2.5 hidden lg:table-cell">
                            {l.source === 'meta_lead_ad'
                              ? <Badge variant="info">Meta</Badge>
                              : <span className="text-xs text-muted-foreground capitalize">{l.source.replace('_', ' ')}</span>}
                            {l.campaign_name && <div className="text-xs text-muted-foreground mt-0.5 truncate max-w-[200px]">{l.campaign_name}</div>}
                          </td>
                          <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                            {canManage ? (
                              <select
                                value={l.status}
                                onChange={(e) => onStatus(l, e.target.value as LeadStatus)}
                                className={`text-xs font-medium rounded-md px-2 py-1 border-0 cursor-pointer ${STATUS_STYLE[l.status]}`}
                              >
                                {STATUSES.map((s) => <option key={s} value={s} className="bg-background text-foreground">{STATUS_LABEL[s]}</option>)}
                              </select>
                            ) : (
                              <span className={`inline-flex px-2 py-0.5 rounded-md text-xs font-medium ${STATUS_STYLE[l.status]}`}>{STATUS_LABEL[l.status]}</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 hidden sm:table-cell" onClick={(e) => e.stopPropagation()}>
                            {canManage ? (
                              <select
                                value={l.assigned_to ?? ''}
                                onChange={(e) => onAssign(l, e.target.value || null)}
                                className="text-xs rounded-md px-2 py-1 bg-secondary border border-border cursor-pointer max-w-[130px]"
                              >
                                <option value="">Unassigned</option>
                                {employees.map((e) => <option key={e.id} value={e.id}>{e.cqid || e.name}</option>)}
                              </select>
                            ) : l.assigned_to ? (
                              <EmployeeName emp={empName.get(l.assigned_to)} className="text-xs" />
                            ) : <span className="text-xs text-muted-foreground">—</span>}
                          </td>
                          <td className="px-3 py-2.5 hidden xl:table-cell text-xs text-muted-foreground">{rel(l.submitted_at || l.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            )}
          </>
        )}

        {tab === 'automation' && canManage && (
          <AutomationTab
            rules={rules}
            clients={clients}
            employees={employees}
            onNew={() => setRuleModal('new')}
            onEdit={(r) => setRuleModal(r)}
            onToggle={(r) => {
              setRules((prev) => prev.map((x) => (x.id === r.id ? { ...x, is_active: !x.is_active } : x)))
              startTransition(async () => {
                const res = await toggleAutomationRule(r.id, !r.is_active)
                if (!res.ok) { toast.error('Could not update rule', res.error); setRules((prev) => prev.map((x) => (x.id === r.id ? { ...x, is_active: r.is_active } : x))) }
              })
            }}
            onDelete={(r) => setDeleteRuleTarget(r)}
          />
        )}
      </div>

      {/* Lead detail drawer */}
      {selected && (
        <LeadDrawer
          lead={selected}
          clientName={clientName.get(selected.client_id) ?? '—'}
          employees={employees}
          empName={empName}
          canManage={canManage}
          onClose={() => setSelected(null)}
          onStatus={(s) => onStatus(selected, s)}
          onAssign={(id) => onAssign(selected, id)}
          onSaveNotes={(notes) => {
            patchLead(selected.id, { notes })
            startTransition(async () => {
              const res = await updateLead(selected.id, { notes })
              if (!res.ok) toast.error('Could not save note', res.error)
              else toast.success('Note saved')
            })
          }}
          onDelete={() => {
            const id = selected.id
            startTransition(async () => {
              const res = await deleteLead(id)
              if (!res.ok) toast.error('Could not delete', res.error)
              else { setLeads((prev) => prev.filter((l) => l.id !== id)); setSelected(null); toast.success('Lead deleted') }
            })
          }}
        />
      )}

      {/* Add lead modal */}
      {showAdd && (
        <AddLeadModal
          clients={clients}
          onClose={() => setShowAdd(false)}
          onCreate={(input) => new Promise((resolve) => {
            startTransition(async () => {
              const res = await createLead(input)
              if (!res.ok) { toast.error('Could not create lead', res.error); resolve(false) }
              else { toast.success('Lead added'); setShowAdd(false); resolve(true) }
            })
          })}
        />
      )}

      {/* Automation rule modal */}
      {ruleModal && (
        <RuleModal
          rule={ruleModal === 'new' ? null : ruleModal}
          clients={clients}
          employees={employees}
          onClose={() => setRuleModal(null)}
          onSave={(input) => new Promise((resolve) => {
            startTransition(async () => {
              const res = await saveAutomationRule(input)
              if (!res.ok) { toast.error('Could not save rule', res.error); resolve(false); return }
              // Reflect locally (simple: reload the row set from the returned id)
              const saved: AutomationRule = {
                id: res.data!.id,
                client_id: input.client_id,
                trigger: input.trigger,
                condition: input.condition,
                action: input.action,
                action_config: input.action_config,
                is_active: input.is_active ?? true,
              }
              setRules((prev) => {
                const exists = prev.some((r) => r.id === saved.id)
                return exists ? prev.map((r) => (r.id === saved.id ? saved : r)) : [...prev, saved]
              })
              toast.success('Rule saved'); setRuleModal(null); resolve(true)
            })
          })}
        />
      )}

      {deleteRuleTarget && (
        <ConfirmDialog
          title="Delete automation rule?"
          body="This rule stops running immediately. Leads already processed are unaffected."
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            const id = deleteRuleTarget.id
            setDeleteRuleTarget(null)
            startTransition(async () => {
              const res = await deleteAutomationRule(id)
              if (!res.ok) toast.error('Could not delete rule', res.error)
              else setRules((prev) => prev.filter((r) => r.id !== id))
            })
          }}
          onCancel={() => setDeleteRuleTarget(null)}
        />
      )}

      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
    </>
  )
}

// ── Small pieces ──────────────────────────────────────────────────────────────

function KpiTile({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5">
      <div className="text-xs text-muted-foreground flex items-center gap-1">
        {label}{sub && <span className="text-[10px] opacity-70">· {sub}</span>}
      </div>
      <div className="text-xl font-semibold text-foreground mt-0.5 tabular-nums">{value}</div>
    </div>
  )
}

function LeadDrawer({
  lead, clientName, employees, empName, canManage, onClose, onStatus, onAssign, onSaveNotes, onDelete,
}: {
  lead: Lead
  clientName: string
  employees: EmployeeRow[]
  empName: Map<string, EmployeeRow>
  canManage: boolean
  onClose: () => void
  onStatus: (s: LeadStatus) => void
  onAssign: (id: string | null) => void
  onSaveNotes: (notes: string) => void
  onDelete: () => void
}) {
  const [notes, setNotes] = useState(lead.notes ?? '')
  const rawEntries = Object.entries(lead.raw_fields ?? {})
  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="bg-card w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between p-4 border-b border-border sticky top-0 bg-card">
          <div>
            <h2 className="text-base font-semibold">{lead.full_name || lead.email || lead.phone || 'Unnamed lead'}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{clientName}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-4 space-y-4">
          {/* Contact */}
          <div className="flex flex-wrap gap-3 text-sm">
            {lead.email && <a href={`mailto:${lead.email}`} className="inline-flex items-center gap-1.5 text-primary"><Mail className="w-4 h-4" />{lead.email}</a>}
            {lead.phone && <a href={`tel:${lead.phone}`} className="inline-flex items-center gap-1.5 text-primary"><Phone className="w-4 h-4" />{lead.phone}</a>}
          </div>

          {/* Status + owner */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Status</label>
              {canManage ? (
                <AppSelect value={lead.status} onChange={(e) => onStatus(e.target.value as LeadStatus)} className="mt-1">
                  {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                </AppSelect>
              ) : <div className="mt-1"><span className={`inline-flex px-2 py-0.5 rounded-md text-xs font-medium ${STATUS_STYLE[lead.status]}`}>{STATUS_LABEL[lead.status]}</span></div>}
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Owner</label>
              {canManage ? (
                <AppSelect value={lead.assigned_to ?? ''} onChange={(e) => onAssign(e.target.value || null)} className="mt-1">
                  <option value="">Unassigned</option>
                  {employees.map((e) => <option key={e.id} value={e.id}>{e.cqid || e.name}</option>)}
                </AppSelect>
              ) : <div className="mt-1 text-sm">{lead.assigned_to ? <EmployeeName emp={empName.get(lead.assigned_to)} /> : '—'}</div>}
            </div>
          </div>

          {/* Attribution */}
          {(lead.campaign_name || lead.adset_name || lead.ad_name || lead.form_name) && (
            <div className="rounded-lg bg-secondary/50 p-3 text-sm space-y-1">
              <div className="text-xs font-medium text-muted-foreground flex items-center gap-1.5 mb-1"><Megaphone className="w-3.5 h-3.5" /> Meta attribution</div>
              {lead.campaign_name && <Row k="Campaign" v={lead.campaign_name} />}
              {lead.adset_name && <Row k="Ad set" v={lead.adset_name} />}
              {lead.ad_name && <Row k="Ad" v={lead.ad_name} />}
              {lead.form_name && <Row k="Form" v={lead.form_name} />}
            </div>
          )}

          {/* Raw form fields */}
          {rawEntries.length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1.5">Form answers</div>
              <div className="rounded-lg border border-border divide-y divide-border">
                {rawEntries.map(([k, v]) => (
                  <div key={k} className="flex gap-3 px-3 py-1.5 text-sm">
                    <span className="text-muted-foreground capitalize min-w-[120px]">{k.replace(/_/g, ' ')}</span>
                    <span className="text-foreground break-all">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Notes */}
          <div>
            <label className="text-xs text-muted-foreground">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={!canManage}
              rows={3}
              className="mt-1 w-full rounded-lg bg-secondary text-sm border border-border p-2.5 focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
              placeholder="Internal notes…"
            />
            {canManage && notes !== (lead.notes ?? '') && (
              <Button size="sm" variant="secondary" className="mt-2" onClick={() => onSaveNotes(notes)}>Save note</Button>
            )}
          </div>

          <div className="text-xs text-muted-foreground">
            Received {rel(lead.submitted_at || lead.created_at)}
            {lead.first_contacted_at && ` · First contacted ${rel(lead.first_contacted_at)}`}
          </div>

          {canManage && (
            <div className="pt-2 border-t border-border">
              <Button size="sm" variant="ghost" className="text-red-400 hover:text-red-300" onClick={onDelete}>
                <Trash2 className="w-4 h-4 mr-1.5" /> Delete lead
              </Button>
            </div>
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex gap-3"><span className="text-muted-foreground min-w-[80px]">{k}</span><span className="text-foreground break-all">{v}</span></div>
}

function AddLeadModal({
  clients, onClose, onCreate,
}: {
  clients: ClientRow[]
  onClose: () => void
  onCreate: (input: { clientId: string; fullName: string; email?: string | null; phone?: string | null; source?: 'manual'; notes?: string | null }) => Promise<boolean>
}) {
  const [clientId, setClientId] = useState('')
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="bg-card w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-base font-semibold">Add lead</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4 space-y-3">
          <Field label="Client *">
            <AppSelect value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">Select a client…</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </AppSelect>
          </Field>
          <Field label="Name"><Input value={fullName} onChange={setFullName} placeholder="Full name" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Email"><Input value={email} onChange={setEmail} placeholder="name@email.com" /></Field>
            <Field label="Phone"><Input value={phone} onChange={setPhone} placeholder="+91…" /></Field>
          </div>
          <Field label="Notes"><Input value={notes} onChange={setNotes} placeholder="Optional" /></Field>
        </div>
        <div className="flex justify-end gap-2 p-4 border-t border-border">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            disabled={!clientId || saving}
            onClick={async () => {
              setSaving(true)
              const ok = await onCreate({ clientId, fullName, email: email || null, phone: phone || null, source: 'manual', notes: notes || null })
              setSaving(false)
              if (!ok) return
            }}
          >
            {saving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />} Add lead
          </Button>
        </div>
      </div>
    </ModalOverlay>
  )
}

function AutomationTab({
  rules, clients, employees, onNew, onEdit, onToggle, onDelete,
}: {
  rules: AutomationRule[]
  clients: ClientRow[]
  employees: EmployeeRow[]
  onNew: () => void
  onEdit: (r: AutomationRule) => void
  onToggle: (r: AutomationRule) => void
  onDelete: (r: AutomationRule) => void
}) {
  const clientName = (id: string | null) => (id ? clients.find((c) => c.id === id)?.name ?? 'Unknown' : 'All clients')
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-muted-foreground">Rules run automatically as leads arrive and change status.</p>
        <Button size="sm" onClick={onNew}><Zap className="w-4 h-4 mr-1.5" /> New rule</Button>
      </div>
      {rules.length === 0 ? (
        <Card><CardContent className="p-0"><EmptyState icon={Zap} title="No automation rules" body="Create rules like “new Meta lead → assign a salesperson” or “qualified → create a follow-up task”. Without rules, new Meta leads still notify all admins." action={{ label: 'New rule', onClick: onNew }} /></CardContent></Card>
      ) : (
        <div className="space-y-2">
          {rules.map((r) => (
            <Card key={r.id}>
              <CardContent className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium flex items-center gap-2">
                    {TRIGGER_LABEL[r.trigger] ?? r.trigger}
                    {!r.is_active && <Badge variant="default">Paused</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
                    <FileText className="w-3 h-3" /> {ACTION_LABEL[r.action] ?? r.action} · {clientName(r.client_id)}
                    {r.trigger === 'lead_uncontacted' && r.condition?.hours ? ` · after ${String(r.condition.hours)}h` : ''}
                    {r.trigger === 'lead_status_changed' && r.condition?.status ? ` · status = ${String(r.condition.status)}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button size="sm" variant="ghost" onClick={() => onToggle(r)}>{r.is_active ? 'Pause' : 'Resume'}</Button>
                  <Button size="sm" variant="ghost" onClick={() => onEdit(r)}>Edit</Button>
                  <Button size="sm" variant="ghost" className="text-red-400 hover:text-red-300" onClick={() => onDelete(r)}><Trash2 className="w-4 h-4" /></Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

function RuleModal({
  rule, clients, employees, onClose, onSave,
}: {
  rule: AutomationRule | null
  clients: ClientRow[]
  employees: EmployeeRow[]
  onClose: () => void
  onSave: (input: {
    id?: string | null; client_id: string | null; trigger: string
    condition: Record<string, unknown> | null; action: string
    action_config: Record<string, unknown> | null; is_active?: boolean
  }) => Promise<boolean>
}) {
  const [clientId, setClientId] = useState(rule?.client_id ?? '')
  const [trigger, setTrigger] = useState(rule?.trigger ?? 'lead_created')
  const [action, setAction] = useState(rule?.action ?? 'notify_admins')
  const [hours, setHours] = useState(String((rule?.condition as { hours?: number } | null)?.hours ?? 24))
  const [condStatus, setCondStatus] = useState(String((rule?.condition as { status?: string } | null)?.status ?? 'qualified'))
  const [employeeId, setEmployeeId] = useState(String((rule?.action_config as { employee_id?: string } | null)?.employee_id ?? ''))
  const [employeeIds, setEmployeeIds] = useState<string[]>(((rule?.action_config as { employee_ids?: string[] } | null)?.employee_ids ?? []))
  const [taskTitle, setTaskTitle] = useState(String((rule?.action_config as { title?: string } | null)?.title ?? ''))
  const [saving, setSaving] = useState(false)

  function build() {
    const condition: Record<string, unknown> | null =
      trigger === 'lead_uncontacted' ? { hours: Number(hours) }
        : trigger === 'lead_status_changed' ? { status: condStatus }
          : null
    let action_config: Record<string, unknown> | null = null
    if (action === 'assign_employee') action_config = { employee_id: employeeId }
    else if (action === 'notify_employees') action_config = { employee_ids: employeeIds }
    else if (action === 'create_task_request') action_config = { title: taskTitle || undefined, employee_id: employeeId || undefined }
    return { id: rule?.id, client_id: clientId || null, trigger, condition, action, action_config, is_active: rule?.is_active ?? true }
  }

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="bg-card w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-card">
          <h2 className="text-base font-semibold">{rule ? 'Edit rule' : 'New automation rule'}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4 space-y-3">
          <Field label="Applies to">
            <AppSelect value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">All clients</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </AppSelect>
          </Field>
          <Field label="When">
            <AppSelect value={trigger} onChange={(e) => setTrigger(e.target.value)}>
              {Object.entries(TRIGGER_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </AppSelect>
          </Field>
          {trigger === 'lead_uncontacted' && (
            <Field label="Hours uncontacted"><Input value={hours} onChange={setHours} type="number" /></Field>
          )}
          {trigger === 'lead_status_changed' && (
            <Field label="New status equals">
              <AppSelect value={condStatus} onChange={(e) => setCondStatus(e.target.value)}>
                {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </AppSelect>
            </Field>
          )}
          <Field label="Then">
            <AppSelect value={action} onChange={(e) => setAction(e.target.value)}>
              {Object.entries(ACTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </AppSelect>
          </Field>
          {(action === 'assign_employee' || action === 'create_task_request') && (
            <Field label={action === 'assign_employee' ? 'Assign to' : 'Assign task to (optional)'}>
              <AppSelect value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                <option value="">{action === 'assign_employee' ? 'Select…' : 'No one'}</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.cqid || e.name}</option>)}
              </AppSelect>
            </Field>
          )}
          {action === 'create_task_request' && (
            <Field label="Task title (optional)"><Input value={taskTitle} onChange={setTaskTitle} placeholder="Follow up new lead" /></Field>
          )}
          {action === 'notify_employees' && (
            <Field label="Notify">
              <div className="space-y-1 max-h-40 overflow-y-auto rounded-lg border border-border p-2">
                {employees.map((e) => (
                  <label key={e.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={employeeIds.includes(e.id)}
                      onChange={(ev) => setEmployeeIds((prev) => ev.target.checked ? [...prev, e.id] : prev.filter((x) => x !== e.id))}
                    />
                    {e.cqid || e.name}
                  </label>
                ))}
              </div>
            </Field>
          )}
        </div>
        <div className="flex justify-end gap-2 p-4 border-t border-border">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={saving} onClick={async () => { setSaving(true); const ok = await onSave(build()); setSaving(false); if (ok) return }}>
            {saving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />} Save rule
          </Button>
        </div>
      </div>
    </ModalOverlay>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="text-xs text-muted-foreground">{label}</label><div className="mt-1">{children}</div></div>
}
function Input({ value, onChange, placeholder, type = 'text' }: { value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full h-9 px-3 rounded-lg bg-secondary text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary"
    />
  )
}

'use client'

/**
 * Ownership hub — programs and their rules.
 *
 * Kept deliberately plain: a list of programs, each expanding to its rules,
 * plus a "what would this pay" preview. Every reward type is the same form
 * with different values, which is the whole point of the engine — there is no
 * separate screen for bonuses, incentives or profit sharing.
 */

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Trash2, Loader2, Play, Eye, AlertTriangle, ChevronDown, Power } from 'lucide-react'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import AppSelect from '@/components/ui/app-select'
import type { OwnershipProgram, OwnershipRule, OwnershipBasis, OwnershipPeriodType, OwnershipScopeKind } from '@/lib/ownership/types'
import { saveProgram, setProgramActive, deleteProgram, saveRule, deleteRule, previewMonth, runAwardsForMonth } from './actions'

const BASIS_LABEL: Record<OwnershipBasis, string> = {
  billing: '% of billing', collected: '% of collections', profit: '% of profit', fixed: 'Fixed amount',
}
const PERIOD_LABEL: Record<OwnershipPeriodType, string> = {
  monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly', one_time: 'One-time',
}
const SCOPE_LABEL: Record<OwnershipScopeKind, string> = {
  company: 'Whole company', client: 'One client', service: 'One service',
  service_category: 'One department', org_unit: 'One team / branch',
}

const inr = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`
const today = () => new Date().toISOString().slice(0, 10)

interface Props {
  programs: OwnershipProgram[]
  rules: OwnershipRule[]
  employees: { id: string; cqid: string }[]
  designations: { id: string; name: string }[]
  clients: { id: string; name: string }[]
  services: { id: string; name: string }[]
  categories: { id: string; name: string }[]
  orgUnits: { id: string; name: string; type: string }[]
  currentMonth: number
  currentYear: number
}

export default function OwnershipClient(p: Props) {
  const router = useRouter()
  const { toasts, dismiss, success, error: toastError } = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  const [programModal, setProgramModal] = useState<OwnershipProgram | 'new' | null>(null)
  const [ruleModal, setRuleModal] = useState<{ programId: string; rule: OwnershipRule | null } | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewMonth>>['data'] | null>(null)

  const refresh = () => startTransition(() => router.refresh())

  const employeeLabel = (id: string) => p.employees.find(e => e.id === id)?.cqid ?? '—'
  const designationLabel = (id: string) => p.designations.find(d => d.id === id)?.name ?? '—'

  function scopeLabel(prog: OwnershipProgram): string {
    if (prog.scopeKind === 'company') return 'Whole company'
    const find = (list: { id: string; name: string }[]) => list.find(x => x.id === prog.scopeId)?.name
    const name =
      prog.scopeKind === 'client' ? find(p.clients)
      : prog.scopeKind === 'service' ? find(p.services)
      : prog.scopeKind === 'service_category' ? find(p.categories)
      : p.orgUnits.find(u => u.id === prog.scopeId)?.name
    return name ? `${SCOPE_LABEL[prog.scopeKind]}: ${name}` : SCOPE_LABEL[prog.scopeKind]
  }

  async function onPreview() {
    setBusy('preview')
    const res = await previewMonth(p.currentMonth, p.currentYear)
    setBusy(null)
    if (!res.ok) { toastError('Could not preview', res.error); return }
    setPreview(res.data ?? null)
  }

  async function onRun() {
    setBusy('run')
    const res = await runAwardsForMonth(p.currentMonth, p.currentYear)
    setBusy(null)
    if (!res.ok) { toastError('Could not run', res.error); return }
    if (res.data?.skipped === 'finalized') {
      toastError('This month is closed', 'Awards keep the figures they were paid with. Reopen the month to recompute.')
      return
    }
    success(`${res.data?.persisted ?? 0} award${res.data?.persisted === 1 ? '' : 's'} computed`, 'They will appear in this month’s payroll.')
    refresh()
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-6">
      <div className="pl-14 md:pl-0 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Ownership</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Revenue share, profit share, incentives and bonuses — all the same engine.
            A program says what to measure and when; its rules say who earns and how much.
            Awards are computed into payroll, never typed in.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onPreview} disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-50">
            {busy === 'preview' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} Preview
          </button>
          <button onClick={onRun} disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-50">
            {busy === 'run' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Run now
          </button>
          <button onClick={() => setProgramModal('new')}
            className="inline-flex items-center gap-1.5 rounded-lg gradient-bg px-3 py-2 text-sm font-medium text-white hover:opacity-90">
            <Plus className="h-4 w-4" /> New program
          </button>
        </div>
      </div>

      {/* Over-commitment guard: nothing stops rules promising 130% of profit,
          and payday is a bad time to find out. */}
      {preview && preview.profitSharePercent > 100 && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-medium text-foreground">
              Active rules promise {preview.profitSharePercent}% of company profit
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              More than 100% means the company pays out more profit than it makes. Reduce a percentage or deactivate a program.
            </p>
          </div>
        </div>
      )}

      {preview && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">If this month paid today</h2>
            <span className="text-sm font-semibold tabular-nums">{inr(preview.totalInr)}</span>
          </div>
          {preview.rows.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">No program pays in this month.</p>
          ) : (
            <div className="mt-2 divide-y divide-border text-xs">
              {preview.rows.map((r, i) => (
                <div key={i} className="flex items-center justify-between py-1.5">
                  <span className="min-w-0 truncate">
                    {employeeLabel(r.employeeId)} · {r.programName}
                    {r.label ? <span className="text-muted-foreground"> · {r.label}</span> : null}
                  </span>
                  <span className="tabular-nums font-medium">{inr(r.earnedInr)}</span>
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">
            Profit share committed across active programs: {preview.profitSharePercent}%
          </p>
        </div>
      )}

      {p.programs.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center">
          <p className="text-sm font-medium">No programs yet</p>
          <p className="mt-1 text-xs text-muted-foreground max-w-md mx-auto">
            Start with something small — e.g. &ldquo;Managers earn 2% of monthly billing&rdquo;.
            Everyone with no program keeps earning exactly as they do today.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {p.programs.map(prog => {
          const progRules = p.rules.filter(r => r.programId === prog.id)
          const open = expanded === prog.id
          return (
            <div key={prog.id} className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-3">
                <button onClick={() => setExpanded(open ? null : prog.id)} className="flex items-center gap-2 min-w-0 text-left">
                  <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`} />
                  <span className="font-semibold truncate">{prog.name}</span>
                  {!prog.isActive && (
                    <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">Paused</span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {BASIS_LABEL[prog.basis]} · {PERIOD_LABEL[prog.periodType]} · {scopeLabel(prog)}
                  </span>
                </button>
                <div className="flex items-center gap-1.5">
                  <button onClick={async () => {
                    setBusy(prog.id)
                    const res = await setProgramActive(prog.id, !prog.isActive)
                    setBusy(null)
                    if (!res.ok) { toastError('Could not update', res.error); return }
                    refresh()
                  }} disabled={busy === prog.id}
                    title={prog.isActive ? 'Pause this program' : 'Resume this program'}
                    className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-50">
                    <Power className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => setProgramModal(prog)}
                    className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium hover:bg-secondary">Edit</button>
                  <button onClick={async () => {
                    if (!confirm(`Delete "${prog.name}"? Its rules and computed awards go with it.`)) return
                    setBusy(prog.id)
                    const res = await deleteProgram(prog.id)
                    setBusy(null)
                    if (!res.ok) { toastError('Could not delete', res.error); return }
                    success('Program deleted'); refresh()
                  }} disabled={busy === prog.id}
                    className="rounded-md p-1.5 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 disabled:opacity-50">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {open && (
                <div className="p-4 space-y-2">
                  {progRules.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No rules yet — nobody earns from this program.</p>
                  ) : progRules.map(r => (
                    <div key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                      <div className="min-w-0">
                        <span className="font-medium">
                          {r.employeeId ? employeeLabel(r.employeeId) : designationLabel(r.designationId!)}
                        </span>
                        {r.employeeId && <span className="ml-1.5 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">override</span>}
                        {r.label && <span className="ml-1.5 text-xs text-muted-foreground">· {r.label}</span>}
                        <span className="ml-2 text-xs text-muted-foreground">
                          {r.percent != null ? `${r.percent}%` : inr(r.fixedAmountInr ?? 0)}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button onClick={() => setRuleModal({ programId: prog.id, rule: r })}
                          className="rounded-lg border border-border px-2 py-1 text-xs hover:bg-secondary">Edit</button>
                        <button onClick={async () => {
                          if (!confirm('Delete this rule?')) return
                          const res = await deleteRule(r.id)
                          if (!res.ok) { toastError('Could not delete', res.error); return }
                          refresh()
                        }} className="rounded-md p-1 text-muted-foreground hover:text-red-500">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                  <button onClick={() => setRuleModal({ programId: prog.id, rule: null })}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline">
                    <Plus className="h-3.5 w-3.5" /> Add rule
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {programModal && (
        <ProgramModal
          initial={programModal === 'new' ? null : programModal}
          clients={p.clients} services={p.services} categories={p.categories} orgUnits={p.orgUnits}
          onClose={() => setProgramModal(null)}
          onSaved={() => { setProgramModal(null); success('Program saved'); refresh() }}
          onError={(m) => toastError('Could not save', m)}
        />
      )}
      {ruleModal && (
        <RuleModal
          programId={ruleModal.programId} initial={ruleModal.rule}
          employees={p.employees} designations={p.designations}
          onClose={() => setRuleModal(null)}
          onSaved={() => { setRuleModal(null); success('Rule saved'); refresh() }}
          onError={(m) => toastError('Could not save', m)}
        />
      )}

      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}

// ── Program form ─────────────────────────────────────────────────────────────

function ProgramModal({ initial, clients, services, categories, orgUnits, onClose, onSaved, onError }: {
  initial: OwnershipProgram | null
  clients: { id: string; name: string }[]
  services: { id: string; name: string }[]
  categories: { id: string; name: string }[]
  orgUnits: { id: string; name: string; type: string }[]
  onClose: () => void
  onSaved: () => void
  onError: (m?: string) => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [basis, setBasis] = useState<OwnershipBasis>(initial?.basis ?? 'billing')
  const [periodType, setPeriodType] = useState<OwnershipPeriodType>(initial?.periodType ?? 'monthly')
  const [scopeKind, setScopeKind] = useState<OwnershipScopeKind>(initial?.scopeKind ?? 'company')
  const [scopeId, setScopeId] = useState(initial?.scopeId ?? '')
  const [periodStart, setPeriodStart] = useState(initial?.periodStart ?? today())
  const [periodEnd, setPeriodEnd] = useState(initial?.periodEnd ?? today())
  const [effectiveFrom, setEffectiveFrom] = useState(initial?.effectiveFrom ?? today())
  const [saving, setSaving] = useState(false)

  // Profit is company-wide; collections have no service dimension. Mirroring
  // the DB constraints here means the operator never meets a Postgres error.
  const scopeOptions: OwnershipScopeKind[] =
    basis === 'profit' ? ['company']
    : basis === 'collected' ? ['company', 'client', 'org_unit']
    : ['company', 'client', 'service', 'service_category', 'org_unit']

  const scopeList =
    scopeKind === 'client' ? clients
    : scopeKind === 'service' ? services
    : scopeKind === 'service_category' ? categories
    : scopeKind === 'org_unit' ? orgUnits
    : []

  async function submit() {
    setSaving(true)
    const res = await saveProgram({
      id: initial?.id, name, programType: basis === 'fixed' ? 'bonus' : 'revenue_share',
      basis, periodType,
      scopeKind: scopeOptions.includes(scopeKind) ? scopeKind : 'company',
      scopeId: scopeKind === 'company' ? null : scopeId,
      periodStart: periodType === 'one_time' ? periodStart : null,
      periodEnd: periodType === 'one_time' ? periodEnd : null,
      effectiveFrom,
    })
    setSaving(false)
    if (!res.ok) { onError(res.error); return }
    onSaved()
  }

  const field = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm'

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="w-full sm:max-w-lg bg-card border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[90dvh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="font-semibold">{initial ? 'Edit program' : 'New program'}</h2>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">Name</label>
            <input value={name} onChange={e => setName(e.target.value)} className={field}
              placeholder="e.g. Manager revenue share, Diwali bonus" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">Measure</label>
              <AppSelect value={basis} onChange={e => {
                const b = e.target.value as OwnershipBasis
                setBasis(b)
                if (b === 'profit') { setScopeKind('company'); setScopeId('') }
              }}>
                {(Object.keys(BASIS_LABEL) as OwnershipBasis[]).map(b => (
                  <option key={b} value={b}>{BASIS_LABEL[b]}</option>
                ))}
              </AppSelect>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">How often</label>
              <AppSelect value={periodType} onChange={e => setPeriodType(e.target.value as OwnershipPeriodType)}>
                {(Object.keys(PERIOD_LABEL) as OwnershipPeriodType[]).map(t => (
                  <option key={t} value={t}>{PERIOD_LABEL[t]}</option>
                ))}
              </AppSelect>
            </div>
          </div>

          {basis !== 'fixed' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Measured over</label>
                <AppSelect value={scopeKind} onChange={e => { setScopeKind(e.target.value as OwnershipScopeKind); setScopeId('') }}>
                  {scopeOptions.map(s => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
                </AppSelect>
              </div>
              {scopeKind !== 'company' && (
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Which one</label>
                  <AppSelect value={scopeId} onChange={e => setScopeId(e.target.value)}>
                    <option value="">— select —</option>
                    {scopeList.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </AppSelect>
                </div>
              )}
            </div>
          )}

          {periodType === 'one_time' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">From</label>
                <input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} className={field} />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">To (pays in this month)</label>
                <input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} className={field} />
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">Starts from</label>
            <input type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} className={field} />
          </div>
        </div>
        <div className="flex gap-3 px-6 py-4 border-t border-border">
          <button onClick={onClose} className="flex-1 rounded-lg border border-border py-2 text-sm font-medium hover:bg-secondary">Cancel</button>
          <button onClick={submit} disabled={saving || !name.trim()}
            className="flex-1 rounded-lg gradient-bg py-2 text-sm font-medium text-white disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

// ── Rule form ────────────────────────────────────────────────────────────────

function RuleModal({ programId, initial, employees, designations, onClose, onSaved, onError }: {
  programId: string
  initial: OwnershipRule | null
  employees: { id: string; cqid: string }[]
  designations: { id: string; name: string }[]
  onClose: () => void
  onSaved: () => void
  onError: (m?: string) => void
}) {
  const [target, setTarget] = useState<'designation' | 'employee'>(initial?.employeeId ? 'employee' : 'designation')
  const [employeeId, setEmployeeId] = useState(initial?.employeeId ?? '')
  const [designationId, setDesignationId] = useState(initial?.designationId ?? '')
  const [mode, setMode] = useState<'percent' | 'fixed'>(initial?.fixedAmountInr != null ? 'fixed' : 'percent')
  const [percent, setPercent] = useState(initial?.percent != null ? String(initial.percent) : '')
  const [fixed, setFixed] = useState(initial?.fixedAmountInr != null ? String(initial.fixedAmountInr) : '')
  const [label, setLabel] = useState(initial?.label ?? '')
  const [effectiveFrom, setEffectiveFrom] = useState(initial?.effectiveFrom ?? today())
  const [saving, setSaving] = useState(false)

  async function submit() {
    setSaving(true)
    const res = await saveRule({
      id: initial?.id, programId,
      employeeId: target === 'employee' ? employeeId : null,
      designationId: target === 'designation' ? designationId : null,
      percent: mode === 'percent' ? Number(percent) || 0 : null,
      fixedAmountInr: mode === 'fixed' ? Number(fixed) || 0 : null,
      label: label || null,
      effectiveFrom,
    })
    setSaving(false)
    if (!res.ok) { onError(res.error); return }
    onSaved()
  }

  const field = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm'

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="w-full sm:max-w-md bg-card border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[90dvh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="font-semibold">{initial ? 'Edit rule' : 'Add rule'}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            A rule for one person overrides the rule for their designation.
          </p>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">Applies to</label>
            <AppSelect value={target} onChange={e => setTarget(e.target.value as 'designation' | 'employee')}>
              <option value="designation">Everyone with a designation</option>
              <option value="employee">One employee (override)</option>
            </AppSelect>
          </div>
          {target === 'designation' ? (
            <AppSelect value={designationId} onChange={e => setDesignationId(e.target.value)}>
              <option value="">— select designation —</option>
              {designations.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </AppSelect>
          ) : (
            <AppSelect value={employeeId} onChange={e => setEmployeeId(e.target.value)}>
              <option value="">— select employee —</option>
              {employees.map(e => <option key={e.id} value={e.id}>{e.cqid}</option>)}
            </AppSelect>
          )}

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">Earns</label>
            <div className="flex gap-2">
              <AppSelect value={mode} onChange={e => setMode(e.target.value as 'percent' | 'fixed')}>
                <option value="percent">Percentage</option>
                <option value="fixed">Fixed ₹</option>
              </AppSelect>
              {mode === 'percent' ? (
                <input type="number" step="0.01" min="0" value={percent} onChange={e => setPercent(e.target.value)}
                  className={field} placeholder="2.5" />
              ) : (
                <input type="number" step="1" min="0" value={fixed} onChange={e => setFixed(e.target.value)}
                  className={field} placeholder="5000" />
              )}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Role label <span className="text-muted-foreground/60">(shown on the payslip)</span>
            </label>
            <input value={label} onChange={e => setLabel(e.target.value)} className={field}
              placeholder="e.g. Team Lead, Ops Manager, HR" />
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">Starts from</label>
            <input type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} className={field} />
          </div>
        </div>
        <div className="flex gap-3 px-6 py-4 border-t border-border">
          <button onClick={onClose} className="flex-1 rounded-lg border border-border py-2 text-sm font-medium hover:bg-secondary">Cancel</button>
          <button onClick={submit} disabled={saving}
            className="flex-1 rounded-lg gradient-bg py-2 text-sm font-medium text-white disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

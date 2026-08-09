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
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Plus, Trash2, Loader2, Play, Eye, AlertTriangle, ChevronDown, Power, ArrowUpRight } from 'lucide-react'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
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

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']
const pad2 = (n: number) => String(n).padStart(2, '0')

/**
 * `<input type="month">` can be cleared or hold a partial value, and month/year
 * go straight into a money computation — so parse defensively and let the
 * caller disable the buttons rather than running against NaN.
 */
function parsePeriod(value: string): { month: number; year: number } | null {
  const [y, m] = value.split('-').map(Number)
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return null
  return { month: m, year: y }
}

const periodLabel = (value: string) => {
  const p = parsePeriod(value)
  return p ? `${MONTH_NAMES[p.month - 1]} ${p.year}` : '—'
}

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
  // In-app confirmation. NOT window.confirm: the desktop shell returns false
  // from it immediately without ever drawing a dialog, so these delete buttons
  // would sit there dead with nothing to explain why.
  const [confirmPrompt, setConfirmPrompt] = useState<{
    title: string
    body: string
    confirmLabel: string
    danger?: boolean
    onConfirm: () => void
  } | null>(null)
  const [, startTransition] = useTransition()
  const [programModal, setProgramModal] = useState<OwnershipProgram | 'new' | null>(null)
  const [ruleModal, setRuleModal] = useState<{ programId: string; rule: OwnershipRule | null } | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewMonth>>['data'] | null>(null)
  const [runConfirm, setRunConfirm] = useState(false)

  // Which month Preview and Run act on. Defaults to today, so the common case
  // is unchanged — but an unpaid earlier month is reachable, which it was not
  // when both buttons were hard-wired to the current month.
  const thisMonth = `${p.currentYear}-${pad2(p.currentMonth)}`
  const [periodValue, setPeriodValue] = useState(thisMonth)
  const period = parsePeriod(periodValue)
  const label = periodLabel(periodValue)

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
    if (!period) return
    setBusy('preview')
    const res = await previewMonth(period.month, period.year)
    setBusy(null)
    if (!res.ok) { toastError('Could not preview', res.error); return }
    setPreview(res.data ?? null)
  }

  // "Run now" persists real award rows that payroll then pays — it must never
  // fire straight off the button. The dialog restates the month (a mis-set
  // picker pays the wrong period) and, when a preview was taken, its total.
  function confirmRun() {
    if (!period) return
    setRunConfirm(true)
  }

  async function onRun() {
    if (!period) return
    setRunConfirm(false)
    setBusy('run')
    const res = await runAwardsForMonth(period.month, period.year)
    setBusy(null)
    if (!res.ok) { toastError('Could not run', res.error); return }
    if (res.data?.skipped === 'finalized') {
      toastError(`${label} is closed`, 'Awards keep the figures they were paid with. Reopen the month to recompute.')
      return
    }
    success(`${res.data?.persisted ?? 0} award${res.data?.persisted === 1 ? '' : 's'} computed`, `They will appear in ${label}’s payroll.`)
    refresh()
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-6">
      <div className="pl-14 md:pl-0 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Ownership</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Pay people a share of the business — revenue share, profit share, incentives and bonuses.
            Amounts are calculated into payroll, never typed in by hand.
          </p>
          {/* The engine detail and the which-tool-when comparison matter once,
              when you are deciding where a rule belongs — not on every visit. */}
          <details className="group mt-1.5">
            <summary className="cursor-pointer select-none list-none text-xs text-muted-foreground hover:text-foreground">
              How this differs from the Pricing Matrix and Employee Agreements
            </summary>
            <p className="text-xs text-muted-foreground mt-1.5 max-w-2xl leading-relaxed">
              This screen pays <b>roles</b>, independent of tasks — someone running Accounts or HR earns
              here even though they score no tasks. The share of a task&rsquo;s price that the people who
              did the work split lives in the <b>Pricing Matrix</b>; one person&rsquo;s special rate on
              particular work is an <b>Employee Agreement</b>. A program says what to measure and when;
              its rules say who earns and how much.
            </p>
          </details>
          {/* Preview answers "what would pay this month"; the report answers
              "what has each role earned so far" from the stored awards. */}
          <Link
            href="/dashboard/reports/role-earnings"
            className="inline-flex items-center gap-1 mt-2 text-xs text-muted-foreground hover:text-foreground"
          >
            What each role has earned <ArrowUpRight className="h-3 w-3" />
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Changing the month drops any preview: a result labelled for one
              month while the picker reads another is worse than none. `max`
              stops a future month, which no period can have closed yet. */}
          <input
            type="month"
            value={periodValue}
            max={thisMonth}
            onChange={e => { setPeriodValue(e.target.value); setPreview(null) }}
            aria-label="Month to preview or run"
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          <button onClick={onPreview} disabled={busy !== null || !period}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-50">
            {busy === 'preview' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} Preview
          </button>
          <button onClick={confirmRun} disabled={busy !== null || !period}
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
            <h2 className="text-sm font-semibold">If {label} paid today</h2>
            <span className="text-sm font-semibold tabular-nums">{inr(preview.totalInr)}</span>
          </div>
          {preview.rows.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">No program pays in {label}.</p>
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
                  <button onClick={() => setConfirmPrompt({
                    title: `Delete the "${prog.name}" program?`,
                    body: `Its ${progRules.length} rule${progRules.length === 1 ? '' : 's'} and every award already computed from it are removed. Nobody earns from this program again, and awards already paid out on past payslips are unaffected.`,
                    confirmLabel: 'Delete program',
                    danger: true,
                    onConfirm: async () => {
                      setBusy(prog.id)
                      const res = await deleteProgram(prog.id)
                      setBusy(null)
                      if (!res.ok) { toastError('Could not delete', res.error); return }
                      success('Program deleted'); refresh()
                    },
                  })} disabled={busy === prog.id}
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
                        <button onClick={() => setConfirmPrompt({
                          title: 'Delete this rule?',
                          body: `${r.employeeId ? employeeLabel(r.employeeId) : designationLabel(r.designationId!)} stops earning ${r.percent != null ? `${r.percent}%` : inr(r.fixedAmountInr ?? 0)} from "${prog.name}". Awards already on past payslips stay as they are.`,
                          confirmLabel: 'Delete rule',
                          danger: true,
                          onConfirm: async () => {
                            const res = await deleteRule(r.id)
                            if (!res.ok) { toastError('Could not delete', res.error); return }
                            refresh()
                          },
                        })} className="rounded-md p-1 text-muted-foreground hover:text-red-500">
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

      {runConfirm && period && (
        <ConfirmDialog
          title={`Compute ${label}'s awards into payroll?`}
          body={
            (preview
              ? `Preview showed ${preview.rows.length} award${preview.rows.length === 1 ? '' : 's'} totalling ${inr(preview.totalInr)}. `
              : '') +
            `Existing awards for ${label} are replaced with freshly computed ones. Nothing is paid out by this — ` +
            `the amounts appear on ${label}'s payslips when payroll is generated or recalculated. A closed month is never touched.`
          }
          confirmLabel="Compute awards"
          onConfirm={() => { void onRun() }}
          onCancel={() => setRunConfirm(false)}
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
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">Pay a share of…</label>
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
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">Pays…</label>
              <AppSelect value={periodType} onChange={e => setPeriodType(e.target.value as OwnershipPeriodType)}>
                {(Object.keys(PERIOD_LABEL) as OwnershipPeriodType[]).map(t => (
                  <option key={t} value={t}>{PERIOD_LABEL[t]}</option>
                ))}
              </AppSelect>
            </div>
          </div>

          {/* Scope defaults to the whole company, which is what a small agency
              wants. Limiting a program to one client/service/team is real
              power but rarely needed, so it opens on demand — and opens itself
              when an existing program already uses it. */}
          {basis !== 'fixed' && (
            <details open={scopeKind !== 'company'} className="group rounded-lg border border-border bg-secondary/20">
              <summary className="flex items-center justify-between gap-2 px-3 py-2 cursor-pointer select-none list-none">
                <span className="text-xs font-medium">
                  Limit to one client, service or team
                  <span className="text-muted-foreground font-normal ml-1.5">
                    · {scopeKind === 'company' ? 'whole company' : SCOPE_LABEL[scopeKind]}
                  </span>
                </span>
                <ChevronDown className="w-4 h-4 text-muted-foreground group-open:rotate-180 transition-transform" />
              </summary>
            <div className="grid grid-cols-2 gap-3 px-3 pb-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Counted across</label>
                <AppSelect value={scopeKind} onChange={e => { setScopeKind(e.target.value as OwnershipScopeKind); setScopeId('') }}>
                  {scopeOptions.map(s => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
                </AppSelect>
              </div>
              {scopeKind !== 'company' && (
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Which one?</label>
                  <AppSelect value={scopeId} onChange={e => setScopeId(e.target.value)}>
                    <option value="">— select —</option>
                    {scopeList.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </AppSelect>
                </div>
              )}
            </div>
            </details>
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

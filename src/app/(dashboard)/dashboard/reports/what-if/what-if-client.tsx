'use client'

/**
 * What-If Planner UI — two-stage workflow: Simulation → Review → Apply.
 *
 * All simulation is client-side over the raw inputs (zero writes); the only
 * write path is the Apply review modal → applyWhatIfScenario server action,
 * which snapshots every affected record before changing anything.
 */

import { useMemo, useState } from 'react'
import { usePrivacy } from '@/contexts/privacy-context'
import Header from '@/components/layout/header'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { DateFilter, matchesDateFilter, getDateFilterLabel, type DateFilterValue } from '@/components/ui/date-filter'
import {
  Plus, X, Copy as CopyIcon, Target, AlertTriangle, CheckCircle2, Loader2, FlaskConical, ChevronDown,
} from 'lucide-react'
import type { EmployeeColumn } from '@/lib/reports/contribution-analysis'
import {
  emptyScenario, isScenarioEmpty, baselineRows, simulateScenario, compareScenario,
  goalSeek, resolveIncrement,
  type Scenario, type WhatIfRawInputs, type ScenarioComparison, type MetricDelta,
  type DraftOwnershipRule, type GoalMetric, type GoalLever,
} from '@/lib/reports/what-if'
import { applyWhatIfScenario, type SelectedChange } from './apply-actions'

// ─── Formatting ────────────────────────────────────────────────────────────────

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
const pct1 = (n: number) => `${n.toFixed(1)}%`

function DeltaBadge({ d, invert = false, money = true }: { d: number; invert?: boolean; money?: boolean }) {
  if (Math.round(money ? d : d * 10) === 0) return <span className="text-muted-foreground">—</span>
  const good = invert ? d < 0 : d > 0
  return (
    <span className={good ? 'text-emerald-500 font-medium' : 'text-red-500 font-medium'}>
      {d > 0 ? '+' : '−'}{money ? inr(Math.abs(d)).slice(0) : `${Math.abs(d).toFixed(1)}%`}
    </span>
  )
}

const inputCls = 'bg-secondary border border-border rounded-lg px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 w-full'
const cardCls = 'bg-secondary/40 border border-border rounded-xl p-4'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  raw: WhatIfRawInputs
  employees: EmployeeColumn[]
  baseSalaries: Record<string, number> | null
  /** client|service → current price (pairings without a price hide the price lever) */
  currentPrices: Record<string, number>
  canApply: { rating: boolean; salary: boolean; pricing: boolean }
}

let scenarioSeq = 1

export default function WhatIfClient({ raw, employees: rawEmployees, baseSalaries, currentPrices, canApply }: Props) {
  // Privacy: mask names ONCE here so every downstream panel/table/apply-payload
  // renders the CQID when locked (and the real name only when unlocked) without
  // each sub-component having to remember. `dn` keys on the whole employee.
  const { dn } = usePrivacy()
  const employees = useMemo(
    () => rawEmployees.map(e => ({ ...e, name: dn(e) })),
    [rawEmployees, dn],
  )

  // ── Baseline period ─────────────────────────────────────────────────────────
  const [dateFilter, setDateFilter] = useState<DateFilterValue>({ type: 'lastMonth' })
  const [normalizeMonthly, setNormalizeMonthly] = useState(false)

  const filteredRaw = useMemo<WhatIfRawInputs>(() => {
    const tasks = raw.tasks.filter(t => matchesDateFilter(t.task_date, dateFilter))
    const taskIds = new Set(tasks.map(t => t.id))
    return { ...raw, tasks, scores: raw.scores.filter(s => taskIds.has(s.task_id)) }
  }, [raw, dateFilter])

  const monthsInBaseline = useMemo(() => {
    const months = new Set(filteredRaw.tasks.map(t => (t.task_date || '').slice(0, 7)).filter(Boolean))
    return Math.max(1, months.size)
  }, [filteredRaw])
  const divisor = normalizeMonthly ? monthsInBaseline : 1

  // ── Scenarios (session-only; the Scenario object itself is persistence-ready) ─
  const [scenarios, setScenarios] = useState<Scenario[]>([emptyScenario('sc-1', 'Scenario A')])
  const [activeId, setActiveId] = useState('sc-1')
  const active = scenarios.find(s => s.id === activeId) ?? scenarios[0]

  function updateActive(mut: (s: Scenario) => Scenario) {
    setScenarios(prev => prev.map(s => (s.id === active.id ? mut(structuredClone(s)) : s)))
  }
  function addScenario(from?: Scenario) {
    scenarioSeq++
    const letter = String.fromCharCode(64 + ((scenarioSeq - 1) % 26) + 1)
    const s = from
      ? { ...structuredClone(from), id: `sc-${scenarioSeq}`, name: `${from.name} (copy)` }
      : emptyScenario(`sc-${scenarioSeq}`, `Scenario ${letter}`)
    setScenarios(prev => [...prev, s])
    setActiveId(s.id)
  }
  function removeScenario(id: string) {
    setScenarios(prev => {
      const next = prev.filter(s => s.id !== id)
      return next.length ? next : [emptyScenario('sc-1', 'Scenario A')]
    })
    if (activeId === id) setActiveId(scenarios.find(s => s.id !== id)?.id ?? 'sc-1')
  }

  // ── Engine runs ─────────────────────────────────────────────────────────────
  const baseline = useMemo(() => baselineRows(filteredRaw), [filteredRaw])
  const comparisons = useMemo(() => {
    const map = new Map<string, ScenarioComparison>()
    for (const s of scenarios) {
      map.set(s.id, compareScenario(baseline, simulateScenario(filteredRaw, s), employees, baseSalaries, s))
    }
    return map
  }, [baseline, filteredRaw, scenarios, employees, baseSalaries])
  const activeCmp = comparisons.get(active.id)!

  // Pairings present in the baseline (drive the commission/price levers).
  const pairings = useMemo(() => {
    const clientName = new Map(raw.clients.map(c => [c.id, c.name]))
    const serviceName = new Map(raw.services.map(s => [s.id, s.name]))
    const seen = new Map<string, { key: string; label: string; commission: number; price: number | null }>()
    const pmap = new Map(raw.pricing.map(p => [`${p.client_id}|${p.service_id}`, p.commission_percentage ?? 50]))
    for (const t of filteredRaw.tasks) {
      if (!t.client_id || !t.service_id) continue
      const key = `${t.client_id}|${t.service_id}`
      if (seen.has(key)) continue
      seen.set(key, {
        key,
        label: `${clientName.get(t.client_id) || '—'} × ${serviceName.get(t.service_id) || '—'}`,
        commission: pmap.get(key) ?? 50,
        price: currentPrices[key] ?? null,
      })
    }
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label))
  }, [raw, filteredRaw, currentPrices])

  const [applyOpen, setApplyOpen] = useState(false)

  const periodLabel = getDateFilterLabel(dateFilter)

  return (
    <>
      <Header
        title="What-If Planner"
        subtitle={`Projected from ${periodLabel}${normalizeMonthly && monthsInBaseline > 1 ? ` (monthly average of ${monthsInBaseline} months)` : ''} — simulation only, nothing changes until you apply`}
      />

      <div className="p-4 sm:p-6 space-y-4">
        {/* ── Controls: baseline period + scenario tabs ── */}
        <div className="flex flex-wrap items-center gap-2">
          <DateFilter value={dateFilter} onChange={setDateFilter} />
          {monthsInBaseline > 1 && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
              <input type="checkbox" checked={normalizeMonthly} onChange={e => setNormalizeMonthly(e.target.checked)} />
              Monthly average ({monthsInBaseline} months)
            </label>
          )}
          <div className="flex-1" />
          <div className="flex items-center gap-1 flex-wrap">
            {scenarios.map(s => (
              <div key={s.id} className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium ${s.id === active.id ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border bg-secondary text-muted-foreground'}`}>
                <button onClick={() => setActiveId(s.id)}>{s.name}{!isScenarioEmpty(s) && ' •'}</button>
                <button onClick={() => addScenario(s)} title="Duplicate"><CopyIcon className="w-3 h-3 opacity-60 hover:opacity-100" /></button>
                {scenarios.length > 1 && (
                  <button onClick={() => removeScenario(s.id)} title="Delete"><X className="w-3 h-3 opacity-60 hover:opacity-100" /></button>
                )}
              </div>
            ))}
            <button onClick={() => addScenario()} className="flex items-center gap-1 rounded-lg border border-dashed border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground">
              <Plus className="w-3 h-3" /> Scenario
            </button>
          </div>
        </div>

        {baseline.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground text-sm">
            No tasks in the selected period — pick a different baseline.
          </div>
        ) : (
          <div className="grid lg:grid-cols-[380px_1fr] gap-4 items-start">
            {/* ── Left: adjustment levers for the active scenario ── */}
            <div className="space-y-3">
              <ScenarioNameCard active={active} updateActive={updateActive} />
              <EmployeeLevers
                employees={employees}
                raw={raw}
                baseSalaries={baseSalaries}
                active={active}
                updateActive={updateActive}
              />
              <LeverSection
                title="Prices & commission"
                subtitle="What if I charge a client more, or change a commission rate?"
                active={Object.keys(active.commissionOverrides).length > 0 || Object.keys(active.priceOverrides).length > 0}
              >
                <PairingLevers pairings={pairings} active={active} updateActive={updateActive} />
              </LeverSection>
              <LeverSection
                title="Business growth"
                subtitle="What if overall volume goes up or down?"
                active={active.billingGrowthPct !== 0}
              >
                <BillingGrowthLever active={active} updateActive={updateActive} />
              </LeverSection>
              <LeverSection
                title="Roles to delegate"
                subtitle="What would it cost to pay someone for Accounts, HR or Ops?"
                active={(active.draftOwnershipRules ?? []).length > 0}
              >
                <DraftRolesLever active={active} updateActive={updateActive} />
              </LeverSection>
              <LeverSection
                title="Goal seek"
                subtitle="Work backwards from a target profit or margin."
              >
                <GoalSeekPanel
                  raw={filteredRaw}
                  active={active}
                  updateActive={updateActive}
                  employees={employees}
                  pairings={pairings}
                  baseSalaries={baseSalaries}
                />
              </LeverSection>
            </div>

            {/* ── Right: comparison dashboard ── */}
            <div className="space-y-4">
              <TotalsComparison scenarios={scenarios} comparisons={comparisons} divisor={divisor} baseSalaries={baseSalaries} />
              <PerEmployeeTable cmp={activeCmp} divisor={divisor} scenarioName={active.name} />
              <GroupTable title="Client profitability" groups={activeCmp.perClient} divisor={divisor} />
              <GroupTable title="Service profitability" groups={activeCmp.perService} divisor={divisor} />

              <div className="flex items-center justify-between gap-3 pt-1">
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <FlaskConical className="w-3.5 h-3.5" />
                  Simulation only — no data changes until you review &amp; apply.
                </p>
                <button
                  onClick={() => setApplyOpen(true)}
                  disabled={isScenarioEmpty(active)}
                  className="gradient-bg text-white text-sm font-medium px-4 py-2 rounded-lg disabled:opacity-40"
                >
                  Apply “{active.name}”…
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {applyOpen && (
        <ApplyReviewModal
          active={active}
          cmp={activeCmp}
          raw={raw}
          employees={employees}
          baseSalaries={baseSalaries}
          pairings={pairings}
          canApply={canApply}
          onClose={() => setApplyOpen(false)}
        />
      )}
    </>
  )
}

// ─── Lever panels ──────────────────────────────────────────────────────────────

function ScenarioNameCard({ active, updateActive }: { active: Scenario; updateActive: (m: (s: Scenario) => Scenario) => void }) {
  return (
    <div className={cardCls}>
      <label className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5">Scenario name</label>
      <input value={active.name} onChange={e => updateActive(s => ({ ...s, name: e.target.value }))} className={inputCls} />
    </div>
  )
}

function EmployeeLevers({ employees, raw, baseSalaries, active, updateActive }: {
  employees: EmployeeColumn[]
  raw: WhatIfRawInputs
  baseSalaries: Record<string, number> | null
  active: Scenario
  updateActive: (m: (s: Scenario) => Scenario) => void
}) {
  return (
    <div className={cardCls}>
      <h3 className="text-sm font-semibold text-foreground mb-1">Employees</h3>
      <p className="text-[11px] text-muted-foreground mb-3">Performance rating drives earnings (pool × share × rating). Increments add to base salary{baseSalaries ? '' : ' — hidden: you lack payroll amount access'}.</p>
      <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
        {employees.map(e => {
          const currentRating = raw.empRating[e.id] ?? 100
          const override = active.ratingOverrides[e.id]
          const inc = active.salaryIncrements[e.id]
          return (
            <div key={e.id} className="grid grid-cols-[1fr_74px_100px] items-center gap-2">
              <div className="min-w-0">
                {/* eslint-disable-next-line no-restricted-syntax -- `employees` is pre-masked with dn() in WhatIfClient's useMemo, so this `.name` IS the CQID when locked. */}
                <p className="text-xs font-medium text-foreground truncate">{e.name}</p>
                <p className="text-[10px] text-muted-foreground">rating {currentRating}{baseSalaries ? ` · base ${inr(baseSalaries[e.id] ?? 0)}` : ''}</p>
              </div>
              <input
                type="number" min={0} max={100} placeholder={String(currentRating)}
                value={override ?? ''}
                onChange={ev => updateActive(s => {
                  const v = ev.target.value
                  if (v === '') delete s.ratingOverrides[e.id]
                  else s.ratingOverrides[e.id] = Math.max(0, Math.min(100, Number(v)))
                  return s
                })}
                className={inputCls}
                title="New performance rating"
              />
              {baseSalaries ? (
                <div className="flex items-center gap-1">
                  <input
                    type="number" placeholder="+₹/%"
                    value={inc?.value ?? ''}
                    onChange={ev => updateActive(s => {
                      const v = ev.target.value
                      if (v === '') delete s.salaryIncrements[e.id]
                      else s.salaryIncrements[e.id] = { mode: inc?.mode ?? 'amount', value: Number(v) }
                      return s
                    })}
                    className={inputCls}
                    title="Salary increment"
                  />
                  <button
                    onClick={() => updateActive(s => {
                      const cur = s.salaryIncrements[e.id]
                      if (cur) s.salaryIncrements[e.id] = { ...cur, mode: cur.mode === 'amount' ? 'pct' : 'amount' }
                      return s
                    })}
                    className="text-[10px] font-mono text-muted-foreground border border-border rounded px-1 py-1 shrink-0 hover:text-foreground"
                    title="Toggle ₹ / %"
                  >
                    {(inc?.mode ?? 'amount') === 'amount' ? '₹' : '%'}
                  </button>
                </div>
              ) : <span />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PairingLevers({ pairings, active, updateActive }: {
  pairings: { key: string; label: string; commission: number; price: number | null }[]
  active: Scenario
  updateActive: (m: (s: Scenario) => Scenario) => void
}) {
  if (pairings.length === 0) return null
  return (
    <div className={cardCls}>
      <h3 className="text-sm font-semibold text-foreground mb-1">Client × Service</h3>
      <p className="text-[11px] text-muted-foreground mb-3">Commission % changes the employee pool. Price changes scale that pairing’s billings (assumes same task volume).</p>
      <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
        {pairings.map(p => (
          <div key={p.key} className="grid grid-cols-[1fr_74px_100px] items-center gap-2">
            <div className="min-w-0">
              <p className="text-xs font-medium text-foreground truncate" title={p.label}>{p.label}</p>
              <p className="text-[10px] text-muted-foreground">comm {p.commission}%{p.price != null ? ` · price ${inr(p.price)}` : ''}</p>
            </div>
            <input
              type="number" min={0} max={100} placeholder={`${p.commission}%`}
              value={active.commissionOverrides[p.key] ?? ''}
              onChange={ev => updateActive(s => {
                const v = ev.target.value
                if (v === '') delete s.commissionOverrides[p.key]
                else s.commissionOverrides[p.key] = Math.max(0, Math.min(100, Number(v)))
                return s
              })}
              className={inputCls}
              title="New commission %"
            />
            {p.price != null ? (
              <input
                type="number" min={0} placeholder={`₹${p.price}`}
                value={active.priceOverrides[p.key]?.newPrice ?? ''}
                onChange={ev => updateActive(s => {
                  const v = ev.target.value
                  if (v === '') delete s.priceOverrides[p.key]
                  else s.priceOverrides[p.key] = { oldPrice: p.price!, newPrice: Number(v) }
                  return s
                })}
                className={inputCls}
                title="New price"
              />
            ) : <span className="text-[10px] text-muted-foreground text-center">no price set</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Collapsible lever card.
 *
 * Six panels rendered fully expanded put simulation-only tools (goal seek,
 * draft roles) in the way of the everyday question — "what if I give someone a
 * raise". Each panel now states what it answers and opens on demand; a panel
 * holding scenario changes opens itself so configured data is never hidden.
 */
function LeverSection({ title, subtitle, active: isActive, children, defaultOpen }: {
  title: string
  subtitle: string
  active?: boolean
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen ?? false)
  const show = open || isActive
  return (
    <div className={cardCls}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-start justify-between gap-2 text-left"
      >
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            {title}
            {isActive && <span className="text-[10px] rounded-full bg-primary/15 text-primary px-1.5 py-0.5 font-medium">in use</span>}
          </h3>
          <p className="text-[11px] text-muted-foreground">{subtitle}</p>
        </div>
        <ChevronDown className={`h-4 w-4 shrink-0 mt-0.5 text-muted-foreground transition-transform ${show ? 'rotate-180' : ''}`} />
      </button>
      {show && <div className="mt-3">{children}</div>}
    </div>
  )
}

function BillingGrowthLever({ active, updateActive }: { active: Scenario; updateActive: (m: (s: Scenario) => Scenario) => void }) {
  return (
    <div className={cardCls}>
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Billing growth %</h3>
          <p className="text-[11px] text-muted-foreground">“What if business grows/shrinks N%” — simulation only, never applied.</p>
        </div>
        <div className="flex items-center gap-1">
          <input
            type="number" min={-90} max={500} placeholder="0"
            value={active.billingGrowthPct || ''}
            onChange={ev => updateActive(s => ({ ...s, billingGrowthPct: Number(ev.target.value) || 0 }))}
            className={`${inputCls} w-20 text-right`}
          />
          <span className="text-sm text-muted-foreground">%</span>
        </div>
      </div>
    </div>
  )
}

const ROLE_BASIS_LABEL: Record<DraftOwnershipRule['basis'], string> = {
  billing: '% of billing',
  profit: '% of profit',
  fixed: 'Fixed ₹',
}

/** inputCls without its `w-full` — that width fights flex sizing in a shared row. */
const roleFieldCls = 'bg-secondary border border-border rounded-lg px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50'

/**
 * Draft roles — "what would delegating Accounts cost me".
 *
 * Deliberately identity-free: no employee, no dates, no scope. The cost of a
 * hat is the same whoever wears it, and the real program still gets created in
 * Settings → Ownership. Nothing here is ever applied.
 */
function DraftRolesLever({ active, updateActive }: { active: Scenario; updateActive: (m: (s: Scenario) => Scenario) => void }) {
  const [form, setForm] = useState<{ label: string; basis: DraftOwnershipRule['basis']; value: string }>(
    { label: '', basis: 'billing', value: '' },
  )
  const rules = active.draftOwnershipRules ?? []

  function add() {
    const value = Number(form.value)
    if (!form.label.trim() || !(value > 0)) return
    const rule: DraftOwnershipRule = {
      id: crypto.randomUUID(),
      label: form.label.trim(),
      basis: form.basis,
      percent: form.basis === 'fixed' ? null : value,
      fixedAmountInr: form.basis === 'fixed' ? value : null,
    }
    updateActive(s => ({ ...s, draftOwnershipRules: [...(s.draftOwnershipRules ?? []), rule] }))
    setForm({ label: '', basis: form.basis, value: '' })
  }

  return (
    <div className={cardCls}>
      <div className="mb-2">
        <h3 className="text-sm font-semibold text-foreground">Roles to delegate</h3>
        <p className="text-[11px] text-muted-foreground">
          What a hat would cost if someone else wore it — simulation only, never applied.
        </p>
      </div>

      {rules.length > 0 && (
        <div className="space-y-1 mb-2">
          {rules.map(r => (
            <div key={r.id} className="flex items-center justify-between gap-2 bg-secondary/60 border border-border rounded-lg px-2.5 py-1.5">
              <span className="min-w-0 truncate text-xs">
                <span className="font-medium text-foreground">{r.label}</span>
                <span className="text-muted-foreground ml-1.5">
                  {r.basis === 'fixed' ? inr(r.fixedAmountInr ?? 0) : `${r.percent}% of ${r.basis}`}
                </span>
              </span>
              <button
                onClick={() => updateActive(s => ({
                  ...s, draftOwnershipRules: (s.draftOwnershipRules ?? []).filter(x => x.id !== r.id),
                }))}
                className="text-muted-foreground hover:text-red-500 shrink-0"
                aria-label={`Remove ${r.label}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* The name gets its own row: in a 380px lever column, sharing one row
          with the basis select and the amount squeezed it to nothing. */}
      <input
        placeholder="Role, e.g. Accounts"
        value={form.label}
        onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
        className={`${inputCls} mb-1.5`}
      />
      <div className="flex items-center gap-1.5">
        <select
          value={form.basis}
          onChange={e => setForm(f => ({ ...f, basis: e.target.value as DraftOwnershipRule['basis'] }))}
          className={`${roleFieldCls} flex-1 min-w-0`}
        >
          {(Object.keys(ROLE_BASIS_LABEL) as DraftOwnershipRule['basis'][]).map(b => (
            <option key={b} value={b}>{ROLE_BASIS_LABEL[b]}</option>
          ))}
        </select>
        <input
          type="number" min={0} step="0.01" placeholder={form.basis === 'fixed' ? '₹' : '%'}
          value={form.value}
          onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
          className={`${roleFieldCls} w-24 shrink-0 text-right`}
        />
        <button onClick={add} className="rounded-lg bg-primary/15 text-primary px-2 py-1.5 hover:bg-primary/25" aria-label="Add role">
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {rules.some(r => r.basis === 'profit') && (
        <p className="text-[11px] text-muted-foreground mt-2">
          The planner&rsquo;s profit is billing minus contribution earnings. It does not subtract
          base salaries or company expenses, so a %-of-profit role costs more here than it will
          in payroll.
        </p>
      )}
    </div>
  )
}

// ─── Goal Seek ─────────────────────────────────────────────────────────────────

function GoalSeekPanel({ raw, active, updateActive, employees, pairings, baseSalaries }: {
  raw: WhatIfRawInputs
  active: Scenario
  updateActive: (m: (s: Scenario) => Scenario) => void
  employees: EmployeeColumn[]
  pairings: { key: string; label: string; commission: number; price: number | null }[]
  baseSalaries: Record<string, number> | null
}) {
  const [goalKind, setGoalKind] = useState<'profit_margin_pct' | 'monthly_profit' | 'payroll_pct_of_revenue' | 'employee_earnings'>('profit_margin_pct')
  const [goalEmp, setGoalEmp] = useState('')
  const [target, setTarget] = useState('')
  const [leverKind, setLeverKind] = useState<'global_commission_pct' | 'billing_growth_pct' | 'client_service_price' | 'employee_rating'>('global_commission_pct')
  const [leverEmp, setLeverEmp] = useState('')
  const [leverPairing, setLeverPairing] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [solvedValue, setSolvedValue] = useState<number | null>(null)

  function solve() {
    const t = Number(target)
    if (!Number.isFinite(t)) return
    const goal: GoalMetric =
      goalKind === 'employee_earnings'
        ? { kind: 'employee_earnings', employeeId: goalEmp, target: t }
        : { kind: goalKind, target: t }
    let lever: GoalLever
    if (leverKind === 'employee_rating') lever = { kind: 'employee_rating', employeeId: leverEmp }
    else if (leverKind === 'client_service_price') {
      const p = pairings.find(x => x.key === leverPairing)
      if (!p || p.price == null) { setResult('Pick a pairing with a price set.'); setSolvedValue(null); return }
      lever = { kind: 'client_service_price', key: p.key, oldPrice: p.price }
    } else lever = { kind: leverKind }

    const res = goalSeek(raw, active, goal, lever, baseSalaries)
    if (res.value === null) {
      setResult(`Unreachable with this lever — closest achievable is ${goalKind.includes('pct') ? pct1(res.achieved) : inr(res.achieved)}.`)
      setSolvedValue(null)
    } else {
      const leverLabel =
        leverKind === 'global_commission_pct' ? `set every commission % to ${res.value.toFixed(1)}%`
        : leverKind === 'billing_growth_pct' ? `billing must change by ${res.value.toFixed(1)}%`
        : leverKind === 'client_service_price' ? `set that price to ${inr(res.value)}`
        : `set the rating to ${res.value.toFixed(1)}`
      setResult(`To hit the target, ${leverLabel}.`)
      setSolvedValue(res.value)
    }
  }

  function loadIntoScenario() {
    if (solvedValue === null) return
    updateActive(s => {
      if (leverKind === 'global_commission_pct') {
        for (const p of pairings) s.commissionOverrides[p.key] = Math.round(solvedValue * 10) / 10
      } else if (leverKind === 'billing_growth_pct') {
        s.billingGrowthPct = Math.round(solvedValue * 10) / 10
      } else if (leverKind === 'client_service_price') {
        const p = pairings.find(x => x.key === leverPairing)
        if (p?.price != null) s.priceOverrides[p.key] = { oldPrice: p.price, newPrice: Math.round(solvedValue) }
      } else if (leverKind === 'employee_rating' && leverEmp) {
        s.ratingOverrides[leverEmp] = Math.round(solvedValue)
      }
      return s
    })
  }

  return (
    <div className={cardCls}>
      <h3 className="text-sm font-semibold text-foreground mb-1 flex items-center gap-1.5"><Target className="w-3.5 h-3.5" /> Goal seek</h3>
      <p className="text-[11px] text-muted-foreground mb-3">“What should I change to achieve this goal?” — solves one lever for a target.</p>
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <select value={goalKind} onChange={e => setGoalKind(e.target.value as typeof goalKind)} className={inputCls}>
            <option value="profit_margin_pct">Profit margin %</option>
            <option value="monthly_profit">Profit ₹</option>
            <option value="payroll_pct_of_revenue">Payroll % of revenue</option>
            <option value="employee_earnings">Employee earnings ₹</option>
          </select>
          <input type="number" placeholder="Target" value={target} onChange={e => setTarget(e.target.value)} className={inputCls} />
        </div>
        {goalKind === 'employee_earnings' && (
          <select value={goalEmp} onChange={e => setGoalEmp(e.target.value)} className={inputCls}>
            <option value="">Whose earnings…</option>
            {/* eslint-disable-next-line no-restricted-syntax -- `employees` is pre-masked with dn() in WhatIfClient's useMemo, so this `.name` IS the CQID when locked. */}
            {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        )}
        <select value={leverKind} onChange={e => setLeverKind(e.target.value as typeof leverKind)} className={inputCls}>
          <option value="global_commission_pct">Solve: commission % (all pairings)</option>
          <option value="billing_growth_pct">Solve: billing growth %</option>
          <option value="client_service_price">Solve: one client×service price</option>
          <option value="employee_rating">Solve: one employee’s rating</option>
        </select>
        {leverKind === 'employee_rating' && (
          <select value={leverEmp} onChange={e => setLeverEmp(e.target.value)} className={inputCls}>
            <option value="">Which employee…</option>
            {/* eslint-disable-next-line no-restricted-syntax -- `employees` is pre-masked with dn() in WhatIfClient's useMemo, so this `.name` IS the CQID when locked. */}
            {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        )}
        {leverKind === 'client_service_price' && (
          <select value={leverPairing} onChange={e => setLeverPairing(e.target.value)} className={inputCls}>
            <option value="">Which pairing…</option>
            {pairings.filter(p => p.price != null).map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        )}
        <button onClick={solve} disabled={!target || (goalKind === 'employee_earnings' && !goalEmp) || (leverKind === 'employee_rating' && !leverEmp) || (leverKind === 'client_service_price' && !leverPairing)} className="w-full text-xs font-medium border border-border rounded-lg py-1.5 text-foreground hover:bg-secondary disabled:opacity-40">
          Solve
        </button>
        {result && (
          <div className="text-[11px] text-foreground bg-background/60 border border-border rounded-lg px-2.5 py-2 space-y-1.5">
            <p>{result}</p>
            {solvedValue !== null && (
              <button onClick={loadIntoScenario} className="text-primary font-medium hover:underline">Load into scenario →</button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Comparison dashboard ──────────────────────────────────────────────────────

function TotalsComparison({ scenarios, comparisons, divisor, baseSalaries }: {
  scenarios: Scenario[]
  comparisons: Map<string, ScenarioComparison>
  divisor: number
  baseSalaries: Record<string, number> | null
}) {
  const first = comparisons.get(scenarios[0].id)!
  const metrics: { label: string; get: (c: ScenarioComparison) => MetricDelta; money?: boolean; invert?: boolean }[] = [
    { label: 'Revenue', get: c => c.revenue },
    { label: 'Commission cost', get: c => c.commissionCost, invert: true },
    { label: baseSalaries ? 'Payroll cost (base + commission)' : 'Payroll cost (commission only)', get: c => c.payrollCost, invert: true },
    { label: 'Profit', get: c => c.profit },
    { label: 'Margin %', get: c => c.marginPct, money: false },
    { label: 'ROI (profit ÷ payroll) %', get: c => c.roi, money: false },
  ]
  // Only shown once a role is drafted — an always-visible ₹0 "role cost" row
  // would read as a claim that delegation is free.
  if ([...comparisons.values()].some(c => c.ownershipCost.simulated !== 0)) {
    metrics.push(
      { label: 'Role cost (draft)', get: c => c.ownershipCost, invert: true },
      { label: 'Profit after roles', get: c => c.profitAfterOwnership },
    )
  }
  const fmt = (v: number, money: boolean) => (money ? inr(v / divisor) : pct1(v))
  return (
    <div className="bg-secondary/40 border border-border rounded-xl overflow-hidden">
      {/* overflow-x-auto: column count is dynamic (one per scenario) — the
          outer overflow-hidden alone would silently clip scenarios beyond
          the visible width with no way to reach them. */}
      <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground border-b border-border">
            <th className="px-4 py-2.5 font-medium">Metric</th>
            <th className="px-4 py-2.5 font-medium text-right">Current</th>
            {scenarios.map(s => (
              <th key={s.id} className="px-4 py-2.5 font-medium text-right">{s.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {metrics.map(m => (
            <tr key={m.label} className="border-b border-border/50 last:border-0">
              <td className="px-4 py-2.5 text-foreground">{m.label}</td>
              <td className="px-4 py-2.5 text-right text-muted-foreground tabular-nums">{fmt(m.get(first).current, m.money !== false)}</td>
              {scenarios.map(s => {
                const d = m.get(comparisons.get(s.id)!)
                return (
                  <td key={s.id} className="px-4 py-2.5 text-right tabular-nums">
                    <span className="text-foreground">{fmt(d.simulated, m.money !== false)}</span>
                    <span className="ml-2 text-xs">
                      <DeltaBadge d={m.money !== false ? d.delta / divisor : d.delta} invert={m.invert} money={m.money !== false} />
                    </span>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  )
}

function PerEmployeeTable({ cmp, divisor, scenarioName }: { cmp: ScenarioComparison; divisor: number; scenarioName: string }) {
  const rows = cmp.perEmployee.filter(e => e.earnings.current !== 0 || e.earnings.simulated !== 0 || e.increment !== 0)
  if (rows.length === 0) return null
  const hasSalary = rows.some(e => e.projectedSalary != null)
  return (
    <div className="bg-secondary/40 border border-border rounded-xl overflow-hidden">
      <p className="px-4 pt-3 pb-1 text-xs font-semibold text-foreground">Employees — {scenarioName}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground border-b border-border">
              <th className="px-4 py-2 font-medium">Employee</th>
              <th className="px-4 py-2 font-medium text-right">Earnings now</th>
              <th className="px-4 py-2 font-medium text-right">Simulated</th>
              <th className="px-4 py-2 font-medium text-right">Δ</th>
              {hasSalary && <th className="px-4 py-2 font-medium text-right">Salary now*</th>}
              {hasSalary && <th className="px-4 py-2 font-medium text-right">Projected*</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(e => (
              <tr key={e.id} className="border-b border-border/50 last:border-0">
                {/* eslint-disable-next-line no-restricted-syntax -- `employees` is pre-masked with dn() in WhatIfClient's useMemo, so this `.name` IS the CQID when locked. */}
                <td className="px-4 py-2 text-foreground">{e.name}</td>
                <td className="px-4 py-2 text-right text-muted-foreground tabular-nums">{inr(e.earnings.current / divisor)}</td>
                <td className="px-4 py-2 text-right text-foreground tabular-nums">{inr(e.earnings.simulated / divisor)}</td>
                <td className="px-4 py-2 text-right text-xs"><DeltaBadge d={e.earnings.delta / divisor} /></td>
                {hasSalary && <td className="px-4 py-2 text-right text-muted-foreground tabular-nums">{e.currentSalary != null ? inr(e.baseSalary! + e.earnings.current / divisor) : '—'}</td>}
                {hasSalary && <td className="px-4 py-2 text-right text-foreground tabular-nums font-medium">{e.projectedSalary != null ? inr(e.baseSalary! + e.increment + e.earnings.simulated / divisor) : '—'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-2 text-[10px] text-muted-foreground">*base + increment + commission for the period{divisor > 1 ? ' (monthly average)' : ''} — before advances/deductions.</p>
    </div>
  )
}

function GroupTable({ title, groups, divisor }: { title: string; groups: ScenarioComparison['perClient']; divisor: number }) {
  if (groups.length === 0) return null
  return (
    <div className="bg-secondary/40 border border-border rounded-xl overflow-hidden">
      <p className="px-4 pt-3 pb-1 text-xs font-semibold text-foreground">{title}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground border-b border-border">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium text-right">Revenue</th>
              <th className="px-4 py-2 font-medium text-right">Profit now</th>
              <th className="px-4 py-2 font-medium text-right">Simulated</th>
              <th className="px-4 py-2 font-medium text-right">Margin now</th>
              <th className="px-4 py-2 font-medium text-right">Simulated</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(g => (
              <tr key={g.key} className={`border-b border-border/50 last:border-0 ${g.profit.simulated < 0 ? 'bg-red-500/5' : ''}`}>
                <td className="px-4 py-2 text-foreground">{g.label}</td>
                <td className="px-4 py-2 text-right text-muted-foreground tabular-nums">{inr(g.billing.simulated / divisor)}</td>
                <td className="px-4 py-2 text-right text-muted-foreground tabular-nums">{inr(g.profit.current / divisor)}</td>
                <td className={`px-4 py-2 text-right tabular-nums ${g.profit.simulated < 0 ? 'text-red-500 font-medium' : 'text-foreground'}`}>{inr(g.profit.simulated / divisor)}</td>
                <td className="px-4 py-2 text-right text-muted-foreground tabular-nums">{pct1(g.marginPct.current)}</td>
                <td className={`px-4 py-2 text-right tabular-nums ${g.marginPct.simulated < 0 ? 'text-red-500 font-medium' : 'text-foreground'}`}>{pct1(g.marginPct.simulated)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Apply review modal (Stage 2: Review → Snapshot → Apply) ──────────────────

function ApplyReviewModal({ active, cmp, raw, employees, baseSalaries, pairings, canApply, onClose }: {
  active: Scenario
  cmp: ScenarioComparison
  raw: WhatIfRawInputs
  employees: EmployeeColumn[]
  baseSalaries: Record<string, number> | null
  pairings: { key: string; label: string; commission: number; price: number | null }[]
  canApply: Props['canApply']
  onClose: () => void
}) {
  const empName = (id: string) => employees.find(e => e.id === id)?.name || '—'
  const pairingLabel = (key: string) => pairings.find(p => p.key === key)?.label || key.replace('|', ' × ')

  // Build the concrete change list from the scenario.
  const allChanges = useMemo<{ change: SelectedChange; allowed: boolean }[]>(() => {
    const list: { change: SelectedChange; allowed: boolean }[] = []
    for (const [empId, to] of Object.entries(active.ratingOverrides)) {
      list.push({
        allowed: canApply.rating,
        change: { kind: 'rating', employeeId: empId, employeeName: empName(empId), from: raw.empRating[empId] ?? 100, to },
      })
    }
    if (baseSalaries) {
      for (const [empId, inc] of Object.entries(active.salaryIncrements)) {
        const base = baseSalaries[empId] ?? 0
        list.push({
          allowed: canApply.salary,
          change: { kind: 'base_salary', employeeId: empId, employeeName: empName(empId), from: base, to: base + resolveIncrement(base, inc) },
        })
      }
    }
    for (const [key, to] of Object.entries(active.commissionOverrides)) {
      const [clientId, serviceId] = key.split('|')
      const from = pairings.find(p => p.key === key)?.commission ?? 50
      list.push({ allowed: canApply.pricing, change: { kind: 'commission_pct', clientId, serviceId, label: pairingLabel(key), from, to } })
    }
    for (const [key, pr] of Object.entries(active.priceOverrides)) {
      const [clientId, serviceId] = key.split('|')
      list.push({ allowed: canApply.pricing, change: { kind: 'price', clientId, serviceId, label: pairingLabel(key), from: pr.oldPrice, to: pr.newPrice } })
    }
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, raw, baseSalaries, pairings, canApply])

  const [selected, setSelected] = useState<Set<number>>(() => new Set(allChanges.map((c, i) => (c.allowed ? i : -1)).filter(i => i >= 0)))
  const [notes, setNotes] = useState('')
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null)

  const hasRatingChange = allChanges.some((c, i) => selected.has(i) && c.change.kind === 'rating')

  function describe(c: SelectedChange): { group: string; text: string } {
    switch (c.kind) {
      case 'rating': return { group: 'Employee changes', text: `${c.employeeName}: performance rating ${c.from} → ${c.to}` }
      case 'base_salary': return { group: 'Employee changes', text: `${c.employeeName}: base salary ${inr(c.from)} → ${inr(c.to)}` }
      case 'commission_pct': return { group: 'Pricing changes', text: `${c.label}: commission ${c.from}% → ${c.to}%` }
      case 'price': return { group: 'Pricing changes', text: `${c.label}: price ${inr(c.from)} → ${inr(c.to)} (future tasks only)` }
    }
  }

  const grouped = useMemo(() => {
    const g = new Map<string, { index: number; text: string; allowed: boolean }[]>()
    allChanges.forEach((c, index) => {
      const { group, text } = describe(c.change)
      if (!g.has(group)) g.set(group, [])
      g.get(group)!.push({ index, text, allowed: c.allowed })
    })
    return g
     
  }, [allChanges])

  async function submit() {
    setBusy(true)
    setOutcome(null)
    const changes = allChanges
      .filter((_, i) => selected.has(i))
      .map(c => c.change)
    const res = await applyWhatIfScenario({
      scenarioName: active.name,
      notes: notes.trim() || null,
      scenarioJson: active as unknown as Record<string, unknown>,
      changes,
    })
    setBusy(false)
    setOutcome(res.ok
      ? { ok: true, message: `${res.applied} change(s) applied. Snapshot saved${res.error ? ` — but: ${res.error}` : ''}.` }
      : { ok: false, message: res.error || 'Apply failed.' })
  }

  const impact: { label: string; d: MetricDelta; money?: boolean; invert?: boolean }[] = [
    { label: 'Revenue', d: cmp.revenue },
    { label: 'Payroll', d: cmp.payrollCost, invert: true },
    { label: 'Employee earnings', d: cmp.commissionCost },
    { label: 'Profit', d: cmp.profit },
    { label: 'Margin', d: cmp.marginPct, money: false },
  ]

  return (
    <ModalOverlay onClose={busy ? () => {} : onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-2xl shadow-2xl max-h-[88vh] overflow-y-auto">
        <div className="px-5 py-4 border-b border-border sticky top-0 bg-card rounded-t-2xl z-10 flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-sm">Apply “{active.name}” to production</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">Review → Snapshot → Apply. A backup of every affected record is created first.</p>
          </div>
          <button onClick={onClose} disabled={busy} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-4">
          {outcome ? (
            <div className={`flex items-start gap-2 rounded-lg border px-3 py-3 text-sm ${outcome.ok ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-600' : 'bg-destructive/10 border-destructive/30 text-destructive'}`}>
              {outcome.ok ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
              <p>{outcome.message}</p>
            </div>
          ) : (
            <>
              {/* Change list */}
              {[...grouped.entries()].map(([group, items]) => (
                <div key={group}>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5">{group}</p>
                  <div className="space-y-1">
                    {items.map(it => (
                      <label key={it.index} className={`flex items-start gap-2 text-sm rounded-lg px-2 py-1.5 ${it.allowed ? 'cursor-pointer hover:bg-secondary/60' : 'opacity-50'}`}>
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          disabled={!it.allowed}
                          checked={selected.has(it.index)}
                          onChange={e => setSelected(prev => {
                            const n = new Set(prev)
                            if (e.target.checked) n.add(it.index); else n.delete(it.index)
                            return n
                          })}
                        />
                        <span className="text-foreground">{it.text}{!it.allowed && <span className="text-[10px] text-muted-foreground ml-1">(no permission)</span>}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}

              {active.billingGrowthPct !== 0 && (
                <p className="text-[11px] text-muted-foreground bg-secondary/60 border border-border rounded-lg px-3 py-2">
                  Billing growth ({active.billingGrowthPct > 0 ? '+' : ''}{active.billingGrowthPct}%) is a simulation assumption about future volume — it is never applied to production.
                </p>
              )}

              {/* Financial impact */}
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5">Financial impact (from the simulation)</p>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                  {impact.map(m => (
                    <div key={m.label} className="bg-secondary/60 border border-border rounded-lg px-2.5 py-2">
                      <p className="text-[10px] text-muted-foreground">{m.label}</p>
                      <p className="text-sm"><DeltaBadge d={m.d.delta} invert={m.invert} money={m.money !== false} /></p>
                    </div>
                  ))}
                </div>
              </div>

              {hasRatingChange && (
                <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">
                    Performance-rating changes also affect how PAST unsynced earnings are displayed in Contribution Analysis (it recomputes from the current rating). Paid payroll records are immutable and unaffected.
                  </p>
                </div>
              )}

              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5">Reason / notes (stored with the snapshot)</label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} className={`${inputCls} resize-none`} placeholder="e.g. April increment plan approved on review call" />
              </div>

              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5">Type APPLY to confirm</label>
                <input value={confirmText} onChange={e => setConfirmText(e.target.value)} className={inputCls} placeholder="APPLY" />
              </div>
            </>
          )}
        </div>

        <div className="flex gap-3 px-5 pb-5">
          <button onClick={onClose} disabled={busy} className="flex-1 bg-secondary text-sm font-medium py-2.5 rounded-lg hover:bg-secondary/80">
            {outcome?.ok ? 'Close' : 'Cancel'}
          </button>
          {!outcome?.ok && (
            <button
              onClick={submit}
              disabled={busy || selected.size === 0 || confirmText !== 'APPLY'}
              className="flex-1 gradient-bg text-white text-sm font-medium py-2.5 rounded-lg disabled:opacity-40 flex items-center justify-center gap-2"
            >
              {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Applying…</> : `Snapshot & apply ${selected.size} change(s)`}
            </button>
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}

'use client'

/**
 * Performance Scorecards — minimal single-owner UI.
 * Score an employee, an applicant (CV) or just a name. Live %, draft/final,
 * optional "Apply to pay" (writes the existing performance-history register).
 * Criteria, sub-parameters, weights, units and targets are all editable
 * behind the Advanced button.
 */

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Header from '@/components/layout/header'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import AppSelect from '@/components/ui/app-select'
import { EmptyState } from '@/components/ui/empty-state'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ToastContainer, useToast } from '@/components/ui/toast'
import { Loader2, Plus, Trash2, SlidersHorizontal, X, Lock, Unlock, BadgeCheck, Gauge } from 'lucide-react'
import { calcAssessment, normalizeScore } from '@/lib/performance/calc'
import { UNIT_LABEL, type AutoResult, type PerfAssessment, type PerfCriterion, type PerfUnit, type PerfApplicantOption, type PerfEmployeeOption } from '@/lib/performance/types'
import {
  saveCriterion, removeCriterion, createAssessment, saveScores,
  finalizeAssessment, reopenAssessment, deleteAssessment, applyToEmployee,
} from '@/lib/performance/actions'

interface ScoreRow { assessment_id: string; criteria_id: string; value: number }

const scoreColor = (n: number | null) =>
  n == null ? 'text-muted-foreground' : n >= 75 ? 'text-emerald-500' : n >= 50 ? 'text-amber-500' : 'text-red-500'

export default function PerformanceClient({
  criteria: initialCriteria, employees, applicants, assessments: initialAssessments, scores: initialScores, auto,
}: {
  criteria: PerfCriterion[]
  employees: PerfEmployeeOption[]
  applicants: PerfApplicantOption[]
  assessments: PerfAssessment[]
  scores: ScoreRow[]
  auto: Record<string, AutoResult>
}) {
  const router = useRouter()
  const toast = useToast()
  const [, startTransition] = useTransition()

  const [assessments, setAssessments] = useState(initialAssessments)
  const [selectedId, setSelectedId] = useState<string | null>(initialAssessments[0]?.id ?? null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<'finalize' | 'delete' | 'apply' | null>(null)
  const [applyDate, setApplyDate] = useState(() => new Date().toISOString().slice(0, 10))

  // subject picker
  const [subject, setSubject] = useState('')       // "e:<id>" | "a:<id>"
  const [quickName, setQuickName] = useState('')

  // criteria_id → raw value, per assessment (local edits before Save)
  const [values, setValues] = useState<Record<string, Record<string, number>>>(() => {
    const by: Record<string, Record<string, number>> = {}
    for (const s of initialScores) (by[s.assessment_id] ??= {})[s.criteria_id] = Number(s.value)
    return by
  })
  const [notes, setNotes] = useState<Record<string, string>>(() =>
    Object.fromEntries(initialAssessments.map(a => [a.id, a.note ?? ''])))

  const selected = assessments.find(a => a.id === selectedId) ?? null
  const groups = useMemo(() => initialCriteria.filter(c => !c.parent_id), [initialCriteria])
  const subsOf = (gid: string) => initialCriteria.filter(c => c.parent_id === gid)

  const live = useMemo(() => {
    if (!selected) return null
    return calcAssessment(initialCriteria, new Map(Object.entries(values[selected.id] ?? {})))
  }, [selected, values, initialCriteria])

  const [showMetrics, setShowMetrics] = useState(false)

  // Auto Performance for the selected subject: the finalize-time snapshot for
  // final scorecards, the live computation for drafts. Read-only either way.
  const selectedAuto: AutoResult | null = useMemo(() => {
    if (!selected?.employee_id) return null
    if (selected.status === 'final' && selected.auto_score != null)
      return { score: selected.auto_score, metrics: selected.auto_metrics ?? [] }
    return auto[selected.employee_id] ?? null
  }, [selected, auto])

  // Growth % vs this employee's PREVIOUS final scorecard (competency only).
  const growth: number | null = useMemo(() => {
    if (!selected?.employee_id) return null
    const current = selected.status === 'final' ? selected.final_score : live?.final
    if (current == null) return null
    const prev = assessments
      .filter(a => a.employee_id === selected.employee_id && a.status === 'final'
        && a.final_score != null && a.id !== selected.id && a.created_at < selected.created_at)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
    if (!prev || !prev.final_score) return null
    return Math.round(((current - prev.final_score) / prev.final_score) * 1000) / 10
  }, [selected, live, assessments])

  const subjectLabel = (a: PerfAssessment) => {
    if (a.employee_id) {
      const e = employees.find(x => x.id === a.employee_id)
      return e ? e.cqid : 'Employee'
    }
    if (a.application_id) {
      const p = applicants.find(x => x.id === a.application_id)
      return p ? `${p.full_name} — ${p.position_title}` : 'Applicant'
    }
    return a.subject_name || 'Unnamed'
  }

  const setValue = (cid: string, v: number | null) => {
    if (!selected) return
    setValues(prev => {
      const cur = { ...(prev[selected.id] ?? {}) }
      if (v == null) delete cur[cid]; else cur[cid] = v
      return { ...prev, [selected.id]: cur }
    })
  }

  const doCreate = () => {
    const input: { employee_id?: string; application_id?: string; subject_name?: string } =
      subject.startsWith('e:') ? { employee_id: subject.slice(2) }
      : subject.startsWith('a:') ? { application_id: subject.slice(2) }
      : { subject_name: quickName }
    if (!input.employee_id && !input.application_id && !quickName.trim()) {
      toast.error('Pick someone', 'Choose an employee or applicant, or type a name.'); return
    }
    setBusy(true)
    startTransition(async () => {
      const r = await createAssessment(input)
      setBusy(false)
      if (!r.ok || !r.data) { toast.error('Could not create', r.error); return }
      setQuickName(''); setSubject('')
      router.refresh()
      const a: PerfAssessment = {
        id: r.data.id, employee_id: input.employee_id ?? null, application_id: input.application_id ?? null,
        subject_name: input.subject_name?.trim() || null, status: 'draft', final_score: null, breakdown: null,
        note: null, auto_score: null, auto_metrics: null, applied_history_id: null, applied_at: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }
      setAssessments(p => [a, ...p]); setSelectedId(a.id)
    })
  }

  const doSave = (onDone?: () => void) => {
    if (!selected) return
    setBusy(true)
    const rows = initialCriteria.filter(c => c.parent_id).map(c => ({
      criteria_id: c.id, value: values[selected.id]?.[c.id] ?? null,
    }))
    startTransition(async () => {
      const r = await saveScores(selected.id, rows, notes[selected.id] || null)
      setBusy(false)
      if (!r.ok) { toast.error('Could not save', r.error); return }
      if (onDone) onDone(); else toast.success('Saved')
    })
  }

  const doFinalize = () => {
    if (!selected) return
    doSave(() => startTransition(async () => {
      const r = await finalizeAssessment(selected.id)
      if (!r.ok || !r.data) { toast.error('Could not finalize', r.error); return }
      const final = r.data.final
      setAssessments(p => p.map(a => a.id === selected.id ? { ...a, status: 'final', final_score: final } : a))
      toast.success('Final', `${final}%`)
    }))
  }

  const doReopen = () => {
    if (!selected) return
    startTransition(async () => {
      const r = await reopenAssessment(selected.id)
      if (!r.ok) { toast.error('Failed', r.error); return }
      setAssessments(p => p.map(a => a.id === selected.id ? { ...a, status: 'draft' } : a))
    })
  }

  const doDelete = () => {
    if (!selected) return
    const id = selected.id
    startTransition(async () => {
      const r = await deleteAssessment(id)
      if (!r.ok) { toast.error('Failed', r.error); return }
      setAssessments(p => { const next = p.filter(a => a.id !== id); setSelectedId(next[0]?.id ?? null); return next })
    })
  }

  const doApply = () => {
    if (!selected) return
    startTransition(async () => {
      const r = await applyToEmployee(selected.id, applyDate)
      if (!r.ok) { toast.error('Could not apply', r.error); return }
      setAssessments(p => p.map(a => a.id === selected.id ? { ...a, applied_at: new Date().toISOString(), applied_history_id: 'applied' } : a))
      toast.success('Applied', 'Rating updated from the chosen date.')
      router.refresh()
    })
  }

  const editable = selected?.status === 'draft'

  return (
    <>
      <Header
        title="Performance"
        subtitle="Scorecards"
        actions={
          <Button size="sm" variant="secondary" onClick={() => setShowAdvanced(true)}>
            <SlidersHorizontal className="w-4 h-4 mr-1.5" /> Advanced
          </Button>
        }
      />

      <div className="px-4 sm:px-6 pb-16 max-w-[1200px] mx-auto w-full">
        {/* New scorecard */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <AppSelect value={subject} onChange={e => { setSubject(e.target.value); setQuickName('') }} wrapperClassName="w-64">
            <option value="">Choose employee or applicant…</option>
            <optgroup label="Employees">
              {employees.map(e => <option key={e.id} value={`e:${e.id}`}>{e.cqid} — {e.performance_rating}%</option>)}
            </optgroup>
            <optgroup label="Applicants">
              {applicants.map(a => <option key={a.id} value={`a:${a.id}`}>{a.full_name} — {a.position_title}</option>)}
            </optgroup>
          </AppSelect>
          <span className="text-xs text-muted-foreground">or</span>
          <input
            type="text" value={quickName} spellCheck lang="en"
            onChange={e => { setQuickName(e.target.value); setSubject('') }}
            placeholder="Just a name (quick measure)"
            className="w-52 bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          <Button size="sm" onClick={doCreate} disabled={busy}>
            {busy ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Plus className="w-4 h-4 mr-1.5" />} New scorecard
          </Button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
          {/* List */}
          <div className="space-y-1.5">
            {assessments.length === 0 && <p className="text-sm text-muted-foreground">No scorecards yet.</p>}
            {assessments.map(a => (
              <button
                key={a.id} onClick={() => setSelectedId(a.id)}
                className={`w-full text-left px-3 py-2.5 rounded-lg border text-sm transition-colors ${a.id === selectedId ? 'border-primary/50 bg-primary/5' : 'border-border hover:bg-secondary/40'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{subjectLabel(a)}</span>
                  <span className={`font-semibold ${scoreColor(a.final_score)}`}>
                    {a.final_score != null ? `${Math.round(a.final_score)}%` : '—'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-muted-foreground">
                  <span className={`px-1.5 py-0.5 rounded ${a.status === 'final' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-secondary'}`}>
                    {a.status === 'final' ? 'Final' : 'Draft'}
                  </span>
                  {a.applied_history_id && <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500 inline-flex items-center gap-1"><BadgeCheck className="w-3 h-3" /> Applied</span>}
                  <span>{new Date(a.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</span>
                </div>
              </button>
            ))}
          </div>

          {/* Editor */}
          {!selected ? (
            <EmptyState icon={Gauge} title="Pick or create a scorecard" body="Choose someone above and press New scorecard." />
          ) : (
            <div className="space-y-3">
              {/* Scores: Competency (manual) · Auto (from app data) · Growth */}
              <Card>
                <CardContent className="pt-4">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <div className="text-sm font-semibold">{subjectLabel(selected)}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {selected.status === 'final' ? 'Final scorecard' : 'Draft — updates live as you fill'}
                      </div>
                    </div>
                    {selectedAuto && selectedAuto.metrics.length > 0 && (
                      <button
                        onClick={() => setShowMetrics(v => !v)}
                        className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
                      >
                        {showMetrics ? 'Hide details' : 'Details'}
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-2.5">
                    <div className="rounded-lg border border-border px-3 py-2.5">
                      <div className="text-[11px] text-muted-foreground">Competency</div>
                      <div className={`text-2xl font-bold ${scoreColor(live?.final ?? null)}`}>
                        {live?.final != null ? `${live.final}%` : '—'}
                      </div>
                    </div>
                    <div className="rounded-lg border border-border px-3 py-2.5">
                      <div className="text-[11px] text-muted-foreground">Auto performance</div>
                      <div className={`text-2xl font-bold ${scoreColor(selectedAuto?.score ?? null)}`}>
                        {selectedAuto?.score != null ? `${selectedAuto.score}%` : '—'}
                      </div>
                    </div>
                    <div className="rounded-lg border border-border px-3 py-2.5">
                      <div className="text-[11px] text-muted-foreground">Growth</div>
                      <div className={`text-2xl font-bold ${growth == null ? 'text-muted-foreground' : growth >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                        {growth != null ? `${growth > 0 ? '+' : ''}${growth}%` : '—'}
                      </div>
                    </div>
                  </div>
                  {showMetrics && selectedAuto && (
                    <div className="mt-3 border-t border-border pt-2.5 space-y-1.5">
                      {selectedAuto.metrics.map(m => (
                        <div key={m.key} className="grid grid-cols-[160px_1fr_48px] items-center gap-2 text-xs">
                          <span className="text-muted-foreground">{m.label}</span>
                          <span className="truncate">{m.display}</span>
                          <span className={`text-right font-medium ${scoreColor(m.score)}`}>
                            {m.score != null ? `${Math.round(m.score)}%` : '—'}
                          </span>
                        </div>
                      ))}
                      <p className="text-[11px] text-muted-foreground pt-1">
                        Last 12 months, from tasks, contributions and requests. Read-only — never changes pay by itself.
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Groups */}
              {groups.map(g => {
                const subs = subsOf(g.id)
                const gScore = live?.groups.find(x => x.group_id === g.id)?.score ?? null
                return (
                  <Card key={g.id}>
                    <CardContent className="pt-4">
                      <div className="flex items-center justify-between mb-3">
                        <div className="text-sm font-semibold">{g.name} <span className="text-[11px] text-muted-foreground font-normal">· weight {g.weight}</span></div>
                        <span className={`text-sm font-semibold ${scoreColor(gScore)}`}>{gScore != null ? `${Math.round(gScore)}%` : '—'}</span>
                      </div>
                      <div className="space-y-2.5">
                        {subs.map(c => {
                          const raw = values[selected.id]?.[c.id]
                          const norm = raw != null ? Math.round(normalizeScore(c, raw)) : null
                          return (
                            <div key={c.id} className="grid grid-cols-[1fr_auto] sm:grid-cols-[200px_1fr_52px] items-center gap-2.5">
                              <div className="text-sm truncate" title={c.name}>{c.name}</div>
                              {c.unit === 'percent' || c.unit === 'level' ? (
                                <input
                                  type="range" disabled={!editable}
                                  min={c.unit === 'level' ? 1 : 0} max={c.unit === 'level' ? 5 : 100} step={1}
                                  value={raw ?? (c.unit === 'level' ? 1 : 0)}
                                  onChange={e => setValue(c.id, Number(e.target.value))}
                                  className="w-full accent-[var(--primary,#6366f1)] disabled:opacity-50"
                                />
                              ) : (
                                <div className="flex items-center gap-2">
                                  <input
                                    type="number" disabled={!editable} min={0} step="0.5"
                                    value={raw ?? ''}
                                    onChange={e => setValue(c.id, e.target.value === '' ? null : Number(e.target.value))}
                                    placeholder={UNIT_LABEL[c.unit]}
                                    className="w-24 bg-background border border-border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
                                  />
                                  <span className="text-[11px] text-muted-foreground">
                                    {c.unit === 'time' ? `target ${c.target ?? 60} min · faster = higher`
                                      : c.unit === 'years' ? `${c.target ?? 8}+ yrs = 100%`
                                      : `target ${c.target ?? 10}`}
                                  </span>
                                </div>
                              )}
                              <span className={`text-xs font-medium text-right ${scoreColor(norm)}`}>
                                {c.unit === 'percent' && raw != null ? `${raw}%` : norm != null ? `${norm}%` : '—'}
                              </span>
                            </div>
                          )
                        })}
                        {subs.length === 0 && <p className="text-xs text-muted-foreground">No items — add some in Advanced.</p>}
                      </div>
                    </CardContent>
                  </Card>
                )
              })}

              {/* Note + actions */}
              <Card>
                <CardContent className="pt-4 space-y-3">
                  <textarea
                    value={notes[selected.id] ?? ''} disabled={!editable} spellCheck lang="en"
                    onChange={e => setNotes(p => ({ ...p, [selected.id]: e.target.value }))}
                    placeholder="Note (optional)" rows={2}
                    className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    {editable && <Button size="sm" onClick={() => doSave()} disabled={busy}>Save</Button>}
                    {editable && (
                      <Button size="sm" variant="secondary" onClick={() => setConfirm('finalize')} disabled={busy}>
                        <Lock className="w-4 h-4 mr-1.5" /> Finalize
                      </Button>
                    )}
                    {!editable && !selected.applied_history_id && (
                      <Button size="sm" variant="secondary" onClick={doReopen}>
                        <Unlock className="w-4 h-4 mr-1.5" /> Reopen
                      </Button>
                    )}
                    {selected.status === 'final' && selected.employee_id && !selected.applied_history_id && (
                      <>
                        <input
                          type="date" value={applyDate} onChange={e => setApplyDate(e.target.value)}
                          className="bg-background border border-border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                        />
                        <Button size="sm" onClick={() => setConfirm('apply')}>
                          <BadgeCheck className="w-4 h-4 mr-1.5" /> Apply to pay
                        </Button>
                      </>
                    )}
                    <span className="flex-1" />
                    <Button size="sm" variant="ghost" onClick={() => setConfirm('delete')} className="text-destructive">
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                  {selected.status === 'final' && !selected.employee_id && (
                    <p className="text-[11px] text-muted-foreground">Measure-only: this scorecard never touches pay. Applicant scores become the baseline if they join.</p>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </div>

      {showAdvanced && (
        <CriteriaEditor
          criteria={initialCriteria}
          onClose={() => { setShowAdvanced(false); router.refresh() }}
          toastError={(t, d) => toast.error(t, d)}
        />
      )}

      {confirm === 'finalize' && (
        <ConfirmDialog
          title="Finalize this scorecard?"
          body={`Locks the score at ${live?.final ?? 0}%. You can reopen it later if needed.`}
          confirmLabel="Finalize"
          onConfirm={() => { setConfirm(null); doFinalize() }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === 'delete' && (
        <ConfirmDialog
          title="Delete this scorecard?"
          body="The scorecard and its scores are removed. Applied performance-history records are NOT touched."
          confirmLabel="Delete" danger
          onConfirm={() => { setConfirm(null); doDelete() }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === 'apply' && (
        <ConfirmDialog
          title="Apply to pay?"
          body={`Adds a ${selected?.final_score ?? 0}% record to the performance history register, effective ${applyDate}. Contributions from that date use it.`}
          confirmLabel="Apply"
          onConfirm={() => { setConfirm(null); doApply() }}
          onCancel={() => setConfirm(null)}
        />
      )}

      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
    </>
  )
}

// ── Advanced: criteria editor ────────────────────────────────────────────────

const UNITS: Array<{ v: PerfUnit; label: string }> = [
  { v: 'percent', label: '% slider' },
  { v: 'level', label: 'Level 1–5' },
  { v: 'years', label: 'Years vs target' },
  { v: 'time', label: 'Time vs target (min)' },
  { v: 'count', label: 'Count vs target' },
]

function CriteriaEditor({
  criteria: initial, onClose, toastError,
}: {
  criteria: PerfCriterion[]
  onClose: () => void
  toastError: (title: string, detail?: string) => void
}) {
  const [items, setItems] = useState<PerfCriterion[]>(initial)
  const [, startTransition] = useTransition()
  const [deleteTarget, setDeleteTarget] = useState<PerfCriterion | null>(null)

  const groups = items.filter(c => !c.parent_id && c.is_active).sort((a, b) => a.sort - b.sort)

  const patch = (id: string, p: Partial<PerfCriterion>) =>
    setItems(prev => prev.map(c => (c.id === id ? { ...c, ...p } : c)))

  const persist = (c: PerfCriterion) =>
    startTransition(async () => {
      const r = await saveCriterion({ id: c.id, parent_id: c.parent_id, name: c.name, weight: c.weight, unit: c.unit, target: c.target, sort: c.sort })
      if (!r.ok) toastError('Could not save', r.error)
    })

  const add = (parentId: string | null) =>
    startTransition(async () => {
      const sort = items.filter(c => c.parent_id === parentId).length + 1
      const draft = { parent_id: parentId, name: parentId ? 'New item' : 'New group', weight: 10, unit: 'percent' as PerfUnit, target: null, sort }
      const r = await saveCriterion(draft)
      if (!r.ok || !r.data) { toastError('Could not add', r.error); return }
      setItems(prev => [...prev, { id: r.data!.id, ...draft, is_active: true }])
    })

  const remove = (c: PerfCriterion) =>
    startTransition(async () => {
      const r = await removeCriterion(c.id)
      if (!r.ok) { toastError('Could not remove', r.error); return }
      setItems(prev => prev.map(x => (x.id === c.id || x.parent_id === c.id ? { ...x, is_active: false } : x)))
    })

  return (
    <ModalOverlay onClose={onClose}>
      <div onClick={e => e.stopPropagation()} className="bg-background rounded-xl w-[760px] max-w-full max-h-[90vh] flex flex-col shadow-2xl border border-border">
        <div className="flex items-center justify-between p-4 border-b border-border bg-sidebar/50">
          <div>
            <h2 className="text-lg font-semibold">Criteria</h2>
            <p className="text-xs text-muted-foreground">Weights are relative — they need not total 100. Changes affect new calculations only.</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-secondary rounded-lg text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto">
          {groups.map(g => (
            <div key={g.id} className="border border-border rounded-xl p-3 space-y-2">
              <div className="flex items-center gap-2">
                <input
                  value={g.name} spellCheck lang="en"
                  onChange={e => patch(g.id, { name: e.target.value })} onBlur={() => persist(items.find(c => c.id === g.id)!)}
                  className="flex-1 bg-background border border-border rounded-lg px-2.5 py-1.5 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <label className="text-[11px] text-muted-foreground">Weight</label>
                <input
                  type="number" min={0} value={g.weight}
                  onChange={e => patch(g.id, { weight: Number(e.target.value) })} onBlur={() => persist(items.find(c => c.id === g.id)!)}
                  className="w-16 bg-background border border-border rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <button onClick={() => setDeleteTarget(g)} className="p-1.5 hover:bg-destructive/10 text-destructive/70 hover:text-destructive rounded" title="Remove group">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              {items.filter(c => c.parent_id === g.id && c.is_active).sort((a, b) => a.sort - b.sort).map(c => (
                <div key={c.id} className="grid grid-cols-[1fr_64px_150px_86px_32px] items-center gap-2 pl-3">
                  <input
                    value={c.name} spellCheck lang="en"
                    onChange={e => patch(c.id, { name: e.target.value })} onBlur={() => persist(items.find(x => x.id === c.id)!)}
                    className="bg-background border border-border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <input
                    type="number" min={0} value={c.weight} title="Weight"
                    onChange={e => patch(c.id, { weight: Number(e.target.value) })} onBlur={() => persist(items.find(x => x.id === c.id)!)}
                    className="bg-background border border-border rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <AppSelect
                    value={c.unit}
                    onChange={e => { patch(c.id, { unit: e.target.value as PerfUnit }); persist({ ...items.find(x => x.id === c.id)!, unit: e.target.value as PerfUnit }) }}
                  >
                    {UNITS.map(u => <option key={u.v} value={u.v}>{u.label}</option>)}
                  </AppSelect>
                  {c.unit === 'percent' || c.unit === 'level' ? <span className="text-[11px] text-muted-foreground text-center">—</span> : (
                    <input
                      type="number" min={0} value={c.target ?? ''} placeholder="Target"
                      onChange={e => patch(c.id, { target: e.target.value === '' ? null : Number(e.target.value) })}
                      onBlur={() => persist(items.find(x => x.id === c.id)!)}
                      className="bg-background border border-border rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                  )}
                  <button onClick={() => setDeleteTarget(c)} className="p-1.5 hover:bg-destructive/10 text-destructive/70 hover:text-destructive rounded" title="Remove">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}

              <Button size="sm" variant="ghost" onClick={() => add(g.id)} className="ml-3">
                <Plus className="w-3.5 h-3.5 mr-1" /> Add item
              </Button>
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => add(null)}>
            <Plus className="w-4 h-4 mr-1.5" /> Add group
          </Button>
        </div>
      </div>

      {deleteTarget && (
        <ConfirmDialog
          title={`Remove "${deleteTarget.name}"?`}
          body="It stops appearing on new scorecards. Old scorecards keep their saved results."
          confirmLabel="Remove" danger
          onConfirm={() => { const t = deleteTarget; setDeleteTarget(null); remove(t) }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </ModalOverlay>
  )
}

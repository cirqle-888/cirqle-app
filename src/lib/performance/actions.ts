'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import { revalidatePath } from 'next/cache'
import { calcAssessment } from './calc'
import { computeAutoForEmployees } from './auto'
import type { PerfCriterion, PerfUnit } from './types'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

const REVALIDATE = '/dashboard/performance'
const UNITS: PerfUnit[] = ['percent', 'level', 'years', 'time', 'count']

// ── Criteria (groups + sub-parameters) ──────────────────────────────────────

export interface CriterionInput {
  id?: string | null
  parent_id?: string | null
  name: string
  weight: number
  unit?: PerfUnit
  target?: number | null
  sort?: number
}

export async function saveCriterion(input: CriterionInput): Promise<ActionResult<{ id: string }>> {
  const guard = await requirePermission(PERMS.PERFORMANCE_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const name = (input.name || '').trim()
  if (!name) return { ok: false, error: 'Enter a name.' }
  if (!Number.isFinite(input.weight) || input.weight < 0) return { ok: false, error: 'Enter a valid weight.' }
  const unit = input.unit && UNITS.includes(input.unit) ? input.unit : 'percent'
  const target = input.target != null && Number.isFinite(input.target) && input.target > 0 ? input.target : null

  const admin = createAdminClient()
  const row = {
    parent_id: input.parent_id || null,
    name,
    weight: input.weight,
    unit,
    target,
    sort: input.sort ?? 0,
    updated_at: new Date().toISOString(),
  }
  let id = input.id ?? null
  if (id) {
    const { error } = await admin.from('perf_criteria').update(row).eq('id', id)
    if (error) return { ok: false, error: error.message }
  } else {
    const { data, error } = await admin.from('perf_criteria').insert(row).select('id').single()
    if (error) return { ok: false, error: error.message }
    id = (data as { id: string }).id
  }
  revalidatePath(REVALIDATE)
  return { ok: true, data: { id: id! } }
}

/** Soft delete — keeps old scorecards intact; the item just stops appearing. */
export async function removeCriterion(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PERFORMANCE_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('perf_criteria')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .or(`id.eq.${id},parent_id.eq.${id}`)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ── Assessments ─────────────────────────────────────────────────────────────

export interface NewAssessmentInput {
  employee_id?: string | null
  application_id?: string | null
  subject_name?: string | null
}

export async function createAssessment(input: NewAssessmentInput): Promise<ActionResult<{ id: string }>> {
  const guard = await requirePermission(PERMS.PERFORMANCE_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!input.employee_id && !input.application_id && !(input.subject_name || '').trim())
    return { ok: false, error: 'Pick an employee, an applicant, or type a name.' }

  const admin = createAdminClient()
  const { data, error } = await admin.from('perf_assessments').insert({
    employee_id: input.employee_id || null,
    application_id: input.application_id || null,
    subject_name: (input.subject_name || '').trim() || null,
    created_by: guard.employeeId ?? null,
  }).select('id').single()
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true, data: { id: (data as { id: string }).id } }
}

/** Upsert the raw values typed/slid in the editor. */
export async function saveScores(
  assessmentId: string,
  scores: Array<{ criteria_id: string; value: number | null }>,
  note?: string | null,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PERFORMANCE_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()

  const { data: a } = await admin.from('perf_assessments').select('id, status').eq('id', assessmentId).maybeSingle()
  if (!a) return { ok: false, error: 'Scorecard not found.' }
  if ((a as { status: string }).status === 'final') return { ok: false, error: 'This scorecard is final. Reopen it to edit.' }

  const now = new Date().toISOString()
  const toUpsert = scores.filter(s => s.value != null && Number.isFinite(s.value))
    .map(s => ({ assessment_id: assessmentId, criteria_id: s.criteria_id, value: s.value as number, updated_at: now }))
  const toClear = scores.filter(s => s.value == null).map(s => s.criteria_id)

  if (toUpsert.length > 0) {
    const { error } = await admin.from('perf_scores').upsert(toUpsert, { onConflict: 'assessment_id,criteria_id' })
    if (error) return { ok: false, error: error.message }
  }
  if (toClear.length > 0) {
    const { error } = await admin.from('perf_scores').delete().eq('assessment_id', assessmentId).in('criteria_id', toClear)
    if (error) return { ok: false, error: error.message }
  }
  const { error } = await admin.from('perf_assessments')
    .update({ note: note ?? null, updated_at: now }).eq('id', assessmentId)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/** Lock the scorecard and store the computed result (server-side math). */
export async function finalizeAssessment(assessmentId: string): Promise<ActionResult<{ final: number }>> {
  const guard = await requirePermission(PERMS.PERFORMANCE_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()

  const [{ data: criteria }, { data: rows }, { data: asmRow }] = await Promise.all([
    admin.from('perf_criteria').select('*'),
    admin.from('perf_scores').select('criteria_id, value').eq('assessment_id', assessmentId),
    admin.from('perf_assessments').select('employee_id').eq('id', assessmentId).maybeSingle(),
  ])
  const map = new Map<string, number>((rows ?? []).map(r => [r.criteria_id as string, Number(r.value)]))
  const result = calcAssessment((criteria ?? []) as PerfCriterion[], map)
  if (result.final == null) return { ok: false, error: 'Nothing is scored yet.' }

  // Snapshot the Auto Performance Score for employee subjects (read-only;
  // never touches pay). Best-effort: finalize still works if it fails.
  let autoPatch: Record<string, unknown> = {}
  const employeeId = (asmRow as { employee_id: string | null } | null)?.employee_id
  if (employeeId) {
    try {
      const { data: emp } = await admin.from('employees').select('id, joined_date').eq('id', employeeId).maybeSingle()
      if (emp) {
        const auto = (await computeAutoForEmployees(admin, [emp as { id: string; joined_date: string | null }]))[employeeId]
        if (auto) autoPatch = { auto_score: auto.score, auto_metrics: auto.metrics }
      }
    } catch { /* auto snapshot is optional */ }
  }

  const basePatch = {
    status: 'final',
    final_score: result.final,
    breakdown: result.groups,
    updated_at: new Date().toISOString(),
  }
  let { error } = await admin.from('perf_assessments').update({ ...basePatch, ...autoPatch }).eq('id', assessmentId)
  if (error && Object.keys(autoPatch).length > 0) {
    // Migration 029 not applied yet — finalize without the auto snapshot.
    ;({ error } = await admin.from('perf_assessments').update(basePatch).eq('id', assessmentId))
  }
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true, data: { final: result.final } }
}

export async function reopenAssessment(assessmentId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PERFORMANCE_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('perf_assessments')
    .update({ status: 'draft', updated_at: new Date().toISOString() })
    .eq('id', assessmentId)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

export async function deleteAssessment(assessmentId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PERFORMANCE_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('perf_assessments').delete().eq('id', assessmentId)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/**
 * Apply a FINAL employee scorecard to pay: one row in the existing
 * employee_performance_history register + the profile rating, exactly like
 * adding a record in the Performance History modal. Contributions pick it up
 * from the effective date onward, as they always have.
 */
export async function applyToEmployee(assessmentId: string, effectiveFrom: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PERFORMANCE_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) return { ok: false, error: 'Pick a valid date.' }

  const admin = createAdminClient()
  const { data: a } = await admin.from('perf_assessments')
    .select('id, employee_id, status, final_score, applied_history_id')
    .eq('id', assessmentId).maybeSingle()
  if (!a) return { ok: false, error: 'Scorecard not found.' }
  const asm = a as { employee_id: string | null; status: string; final_score: number | null; applied_history_id: string | null }
  if (!asm.employee_id) return { ok: false, error: 'Only employee scorecards can be applied to pay.' }
  if (asm.status !== 'final' || asm.final_score == null) return { ok: false, error: 'Finalize the scorecard first.' }
  if (asm.applied_history_id) return { ok: false, error: 'Already applied.' }

  const rating = Math.round(asm.final_score * 100) / 100
  const { data: hist, error: histErr } = await admin.from('employee_performance_history').insert({
    employee_id: asm.employee_id,
    effective_from: effectiveFrom,
    performance_rating: rating,
    reason: 'Performance scorecard',
  }).select('id').single()
  if (histErr) return { ok: false, error: histErr.message }

  const { error: empErr } = await admin.from('employees')
    .update({ performance_rating: rating }).eq('id', asm.employee_id)
  if (empErr) return { ok: false, error: empErr.message }

  await admin.from('perf_assessments').update({
    applied_history_id: (hist as { id: string }).id,
    applied_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', assessmentId)

  void logActivity({
    actorId: guard.employeeId,
    subjectId: asm.employee_id,
    entityType: 'employee',
    entityId: asm.employee_id,
    action: 'edited',
    detail: [{ field: 'performance_rating', from: null, to: `${rating}%` }],
  })
  revalidatePath(REVALIDATE)
  return { ok: true }
}

'use server'

/**
 * What-If Planner — the Apply stage of the two-stage workflow:
 *   Simulation → Review → Snapshot → Apply → Production.
 *
 * Simulation is entirely client-side; this file is the ONLY write path. Each
 * change is one individually-selected item with its own permission guard.
 * Before any write, every affected record's prior state is captured into
 * scenario_snapshots / scenario_snapshot_records (generic backup tables — the
 * seed of a universal rollback mechanism). If the snapshot cannot be created,
 * the whole apply is ABORTED: never write without a backup.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import type { AgreementType } from '@/lib/calculations/agreements'

export type SelectedChange =
  | { kind: 'rating'; employeeId: string; employeeName: string; from: number; to: number }
  | { kind: 'base_salary'; employeeId: string; employeeName: string; from: number; to: number }
  | { kind: 'commission_pct'; clientId: string; serviceId: string; label: string; from: number; to: number }
  | { kind: 'price'; clientId: string; serviceId: string; label: string; from: number; to: number }
  | {
      kind: 'agreement'
      employeeId: string
      employeeName: string
      clientId: string | null
      serviceId: string | null
      agreementType: AgreementType
      agreementValue: number
      effectiveFrom: string           // YYYY-MM-DD, chosen in the review UI
      replacesAgreementId: string | null
    }

export interface ApplyInput {
  scenarioName: string
  notes: string | null
  scenarioJson: Record<string, unknown>   // full Scenario object for the snapshot
  changes: SelectedChange[]
}

interface ActionResult {
  ok: boolean
  error?: string
  snapshotId?: string
  applied?: number
}

const PERM_FOR_KIND: Record<SelectedChange['kind'], string> = {
  rating: PERMS.PAYROLL_EDIT,
  base_salary: PERMS.PAYROLL_EDIT,
  commission_pct: PERMS.SETTINGS_ACCESS,
  price: PERMS.SETTINGS_ACCESS,
  agreement: PERMS.EMPLOYEES_MANAGE_AGREEMENTS,
}

export async function applyWhatIfScenario(input: ApplyInput): Promise<ActionResult> {
  if (!input.changes.length) return { ok: false, error: 'No changes selected.' }

  // Guard every change type present BEFORE doing anything — a partial
  // permission failure must not produce a partial apply.
  const kinds = [...new Set(input.changes.map(c => c.kind))]
  let employeeId = ''
  for (const kind of kinds) {
    const guard = await requirePermission(PERM_FOR_KIND[kind])
    if (!guard.ok) return { ok: false, error: `Permission denied for ${kind.replace('_', ' ')} changes: ${guard.error}` }
    employeeId = guard.employeeId
  }

  const admin = createAdminClient()

  // ── 1. Capture the snapshot (backup-before-apply) ───────────────────────────
  const snapshotRecords: { table_name: string; record_id: string; old_values: Record<string, unknown>; new_values: Record<string, unknown> }[] = []

  for (const c of input.changes) {
    if (c.kind === 'rating' || c.kind === 'base_salary') {
      const field = c.kind === 'rating' ? 'performance_rating' : 'base_salary'
      const { data } = await admin.from('employees').select(`id, ${field}`).eq('id', c.employeeId).maybeSingle()
      if (!data) return { ok: false, error: `Employee not found for ${c.kind} change (${c.employeeName}).` }
      snapshotRecords.push({
        table_name: 'employees',
        record_id: c.employeeId,
        old_values: { [field]: (data as Record<string, unknown>)[field] },
        new_values: { [field]: c.to },
      })
    } else if (c.kind === 'commission_pct' || c.kind === 'price') {
      const field = c.kind === 'commission_pct' ? 'commission_percentage' : 'price'
      const { data } = await admin
        .from('client_service_pricing')
        .select(`id, client_id, service_id, is_active, ${field}`)
        .eq('client_id', c.clientId).eq('service_id', c.serviceId)
        .maybeSingle()
      // is_active is snapshotted so a restore can undo a REVIVAL as well as a
      // value change — applying a scenario to a deactivated pair re-commits
      // it, and without this the rollback would leave it live.
      snapshotRecords.push({
        table_name: 'client_service_pricing',
        record_id: data ? String((data as Record<string, unknown>).id) : `${c.clientId}|${c.serviceId}`,
        old_values: data
          ? { [field]: (data as Record<string, unknown>)[field], is_active: (data as Record<string, unknown>).is_active }
          : { [field]: null, is_active: false, missing_row: true },
        new_values: { [field]: c.to, is_active: true },
      })
    } else if (c.kind === 'agreement') {
      if (c.replacesAgreementId) {
        const { data } = await admin
          .from('employee_commission_agreements')
          .select('id, agreement_type, agreement_value, client_id, service_id, effective_from, effective_to, is_active')
          .eq('id', c.replacesAgreementId).maybeSingle()
        if (data) {
          snapshotRecords.push({
            table_name: 'employee_commission_agreements',
            record_id: c.replacesAgreementId,
            old_values: data as Record<string, unknown>,
            new_values: { is_active: false, replaced_by_new_agreement: true },
          })
        }
      }
      // Brand-new agreements have no prior state — record the creation intent
      // so a future restore knows to deactivate what this apply created.
      snapshotRecords.push({
        table_name: 'employee_commission_agreements',
        record_id: `new:${c.employeeId}:${c.agreementType}`,
        old_values: { created_by_apply: true },
        new_values: {
          employee_id: c.employeeId, client_id: c.clientId, service_id: c.serviceId,
          agreement_type: c.agreementType, agreement_value: c.agreementValue,
          effective_from: c.effectiveFrom,
        },
      })
    }
  }

  const { data: snapshot, error: snapErr } = await admin
    .from('scenario_snapshots')
    .insert({
      scenario_name: input.scenarioName,
      notes: input.notes,
      scenario_json: input.scenarioJson,
      record_count: snapshotRecords.length,
      created_by: employeeId || null,
    })
    .select('id')
    .single()

  if (snapErr || !snapshot) {
    return { ok: false, error: `Snapshot could not be created — apply aborted. ${snapErr?.message ?? ''}` }
  }

  const { error: recErr } = await admin
    .from('scenario_snapshot_records')
    .insert(snapshotRecords.map(r => ({ ...r, snapshot_id: snapshot.id })))
  if (recErr) {
    return { ok: false, error: `Snapshot records could not be written — apply aborted. ${recErr.message}` }
  }

  // ── 2. Apply the writes ──────────────────────────────────────────────────────
  let applied = 0
  const failures: string[] = []
  for (const c of input.changes) {
    let error: { message: string } | null = null
    if (c.kind === 'rating') {
      ;({ error } = await admin.from('employees').update({ performance_rating: c.to }).eq('id', c.employeeId))
    } else if (c.kind === 'base_salary') {
      ;({ error } = await admin.from('employees').update({ base_salary: c.to }).eq('id', c.employeeId))
    } else if (c.kind === 'commission_pct' || c.kind === 'price') {
      const field = c.kind === 'commission_pct' ? 'commission_percentage' : 'price'
      // Applying a priced scenario commits the client to that service, so the
      // deactivation stamp is cleared alongside is_active — a live row must
      // never carry a stale "removed on" date. The prior is_active is captured
      // in the snapshot above so a restore can reverse this.
      ;({ error } = await admin
        .from('client_service_pricing')
        .upsert(
          {
            client_id: c.clientId, service_id: c.serviceId, [field]: c.to,
            is_active: true, deactivated_at: null, deactivated_by: null,
          },
          { onConflict: 'client_id,service_id' },
        ))
    } else if (c.kind === 'agreement') {
      if (c.replacesAgreementId) {
        const { error: deactErr } = await admin
          .from('employee_commission_agreements')
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq('id', c.replacesAgreementId)
        if (deactErr) { failures.push(`deactivate agreement: ${deactErr.message}`); continue }
      }
      ;({ error } = await admin.from('employee_commission_agreements').insert({
        employee_id: c.employeeId,
        client_id: c.clientId,
        service_id: c.serviceId,
        agreement_type: c.agreementType,
        agreement_value: c.agreementValue,
        effective_from: c.effectiveFrom,
        is_active: true,
        notes: `Created from What-If scenario "${input.scenarioName}"`,
        created_by: employeeId || null,
      }))
    }
    if (error) failures.push(`${c.kind}: ${error.message}`)
    else applied++
  }

  // ── 3. Stamp the snapshot + audit trail ──────────────────────────────────────
  await admin
    .from('scenario_snapshots')
    .update({ applied_by: employeeId || null, applied_at: new Date().toISOString() })
    .eq('id', snapshot.id)

  void logActivity({
    actorId: employeeId || null,
    entityType: 'payroll',
    entityId: snapshot.id,
    action: 'scenario_applied',
    detail: {
      snapshot_id: snapshot.id,
      scenario_name: input.scenarioName,
      applied,
      failed: failures.length,
      changes: input.changes.map(c => ({ ...c })),
    },
    note: input.notes,
  })

  revalidatePath('/dashboard/reports/what-if')
  revalidatePath('/dashboard/reports/contribution-analysis')
  revalidatePath('/dashboard/payroll')

  if (failures.length) {
    return {
      ok: applied > 0,
      error: `${applied} change(s) applied, ${failures.length} failed: ${failures.join('; ')}`,
      snapshotId: snapshot.id,
      applied,
    }
  }
  return { ok: true, snapshotId: snapshot.id, applied }
}

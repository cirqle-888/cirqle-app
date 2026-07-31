'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/auth/enforce'
import { PERMS } from '@/lib/permissions/keys'
import { generateAgreementNumber } from '@/lib/agreements/numbering'
import { logAgreementEvent } from '@/lib/agreements/events'
import type {
  AgreementStatus, Visibility, RenewalType, CommitmentType, Cycle, CarryForwardRule,
} from '@/lib/agreements/types'

type ActionResult<T = void> = { ok: true; data?: T } | { ok: false; error: string }

/** Helper to grab current user details for the audit log */
async function getActor() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: emp } = await supabase
    .from('employees')
    .select('id, name')
    .eq('auth_id', user.id)
    .single()

  return emp ? { id: emp.id, name: emp.name } : null
}

export async function createAgreement(input: {
  clientId: string
  title: string
  startDate: string
  endDate?: string | null
  renewalType: RenewalType
  notes?: string
}): Promise<ActionResult<string>> {
  const guard = await requirePermission(PERMS.AGREEMENTS_MANAGE)
  if (!guard.ok) return guard

  if (!input.clientId) return { ok: false, error: 'Select a client' }
  if (!input.title?.trim()) return { ok: false, error: 'Enter an agreement title' }
  if (!input.startDate) return { ok: false, error: 'Pick a start date' }
  if (input.endDate && input.endDate < input.startDate)
    return { ok: false, error: 'End date is before the start date' }

  const supabase = await createClient()

  // Get client code for numbering (column is `code`, not `client_code`).
  const { data: client } = await supabase
    .from('clients')
    .select('code')
    .eq('id', input.clientId)
    .single()

  if (!client) return { ok: false, error: 'Client not found' }

  const creationDate = new Date()
  const { agreementNumber } = await generateAgreementNumber(supabase, creationDate, client.code)

  const { data, error } = await supabase
    .from('client_agreements')
    .insert({
      agreement_number: agreementNumber,
      client_id: input.clientId,
      title: input.title.trim(),
      status: 'draft',
      start_date: input.startDate,
      end_date: input.endDate || null,
      renewal_type: input.renewalType,
      notes: input.notes?.trim() || null,
      created_by: guard.employeeId,
    })
    .select('id')
    .single()

  if (error || !data) return { ok: false, error: error?.message || 'Failed to create agreement' }

  const actor = await getActor()
  await logAgreementEvent(supabase, {
    agreementId: data.id,
    actorType: 'admin',
    actorId: actor?.id,
    actorLabel: actor?.name,
    action: 'created',
  })

  revalidatePath('/dashboard/agreements')
  return { ok: true, data: data.id }
}

/** Edit the agreement header (draft-safe fields only — never touches items). */
export async function updateAgreementDetails(
  agreementId: string,
  input: {
    title: string
    startDate: string
    endDate?: string | null
    renewalType: RenewalType
    notes?: string | null
    signedDocumentUrl?: string | null
  },
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.AGREEMENTS_MANAGE)
  if (!guard.ok) return guard

  if (!input.title?.trim()) return { ok: false, error: 'Enter an agreement title' }
  if (!input.startDate) return { ok: false, error: 'Pick a start date' }
  if (input.endDate && input.endDate < input.startDate)
    return { ok: false, error: 'End date is before the start date' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('client_agreements')
    .update({
      title: input.title.trim(),
      start_date: input.startDate,
      end_date: input.endDate || null,
      renewal_type: input.renewalType,
      notes: input.notes?.trim() || null,
      signed_document_url: input.signedDocumentUrl || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', agreementId)

  if (error) return { ok: false, error: error.message }

  const actor = await getActor()
  await logAgreementEvent(supabase, {
    agreementId,
    actorType: 'admin',
    actorId: actor?.id,
    actorLabel: actor?.name,
    action: 'updated',
  })

  revalidatePath('/dashboard/agreements')
  revalidatePath(`/dashboard/agreements/${agreementId}`)
  return { ok: true }
}

export async function setAgreementStatus(
  agreementId: string,
  status: AgreementStatus,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.AGREEMENTS_MANAGE)
  if (!guard.ok) return guard

  const supabase = await createClient()
  const { error } = await supabase
    .from('client_agreements')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', agreementId)

  if (error) return { ok: false, error: error.message }

  let action: any = 'updated'
  if (status === 'active') action = 'activated'
  if (status === 'paused') action = 'paused'
  if (status === 'completed') action = 'completed'
  if (status === 'cancelled') action = 'cancelled'
  if (status === 'expired') action = 'expired'

  const actor = await getActor()
  await logAgreementEvent(supabase, {
    agreementId,
    actorType: 'admin',
    actorId: actor?.id,
    actorLabel: actor?.name,
    action,
    detail: { status },
  })

  revalidatePath('/dashboard/agreements')
  revalidatePath(`/dashboard/agreements/${agreementId}`)
  return { ok: true }
}

/** Soft-delete an agreement (house norm — sets deleted_at). */
export async function deleteAgreement(agreementId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.AGREEMENTS_MANAGE)
  if (!guard.ok) return guard

  const supabase = await createClient()
  const { error } = await supabase
    .from('client_agreements')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', agreementId)

  if (error) return { ok: false, error: error.message }

  revalidatePath('/dashboard/agreements')
  return { ok: true }
}

// ─── Items (with nested deliverables + milestones) ───────────────────────────

export interface AgreementDeliverableInput {
  id?: string
  label: string
  content_types: string[]
  committed_quantity: number
  display_order: number
  notes?: string | null
}

export interface AgreementMilestoneInput {
  id?: string
  label: string
  display_order: number
  due_date?: string | null
  visibility: Visibility
}

export interface AgreementItemInput {
  id?: string
  service_id: string | null
  commitment_type: CommitmentType
  committed_quantity: number | null
  cycle: Cycle | null
  effective_from: string
  effective_to?: string | null
  unit_price: number | null
  currency: string
  carry_forward_rule: CarryForwardRule
  extra_unit_price: number | null
  display_order: number
  notes?: string | null
  // Internal retainer allocation (retainer items only). Never client billing.
  creative_allocation_amount?: number | null
  management_allocation_amount?: number | null
  included_quantity?: number | null
  /** Services this retainer item covers (Phase 2b). undefined = leave unchanged. */
  coveredServiceIds?: string[]
  deliverables: AgreementDeliverableInput[]
  milestones: AgreementMilestoneInput[]
}

/** Read the agreement status so we can enforce the draft-only in-place edit rule. */
async function agreementStatus(supabase: any, agreementId: string): Promise<AgreementStatus | null> {
  const { data } = await supabase
    .from('client_agreements')
    .select('status')
    .eq('id', agreementId)
    .single()
  return data?.status ?? null
}

/** Persist an item's own nested deliverables + milestones. */
async function syncItemChildren(
  supabase: any,
  itemId: string,
  deliverables: AgreementDeliverableInput[],
  milestones: AgreementMilestoneInput[],
): Promise<string | null> {
  // Deliverables are pure config (no derived state) → replace wholesale.
  const delDelete = await supabase.from('client_agreement_deliverables').delete().eq('item_id', itemId)
  if (delDelete.error) return delDelete.error.message
  if (deliverables.length > 0) {
    const rows = deliverables.map((d, i) => ({
      item_id: itemId,
      label: d.label.trim(),
      content_types: d.content_types ?? [],
      committed_quantity: Number(d.committed_quantity) || 0,
      display_order: d.display_order ?? i,
      notes: d.notes?.trim() || null,
    }))
    const ins = await supabase.from('client_agreement_deliverables').insert(rows)
    if (ins.error) return ins.error.message
  }

  // Milestones can carry completion state (completed_at / task_id) → upsert by id,
  // delete only the ones the editor removed.
  const { data: existing } = await supabase
    .from('client_agreement_milestones')
    .select('id')
    .eq('item_id', itemId)
  const keepIds = new Set(milestones.map(m => m.id).filter(Boolean) as string[])
  const toDelete = (existing || []).map((m: any) => m.id).filter((id: string) => !keepIds.has(id))
  if (toDelete.length > 0) {
    const del = await supabase.from('client_agreement_milestones').delete().in('id', toDelete)
    if (del.error) return del.error.message
  }
  for (const [i, m] of milestones.entries()) {
    const payload: any = {
      item_id: itemId,
      label: m.label.trim(),
      display_order: m.display_order ?? i,
      due_date: m.due_date || null,
      visibility: m.visibility,
      updated_at: new Date().toISOString(),
    }
    if (m.id) payload.id = m.id
    const up = await supabase.from('client_agreement_milestones').upsert(payload)
    if (up.error) return up.error.message
  }
  return null
}

/**
 * Create a new item, or edit an existing one in place.
 *
 * Doctrine (design §2.3): an active agreement's terms are never UPDATEd in
 * place — a change closes the row and inserts a successor. So in-place edits of
 * an existing item are allowed only while the agreement is draft/pending; use
 * `changeAgreementItemTerms` for active agreements. Adding a brand-new item is
 * always additive and therefore always allowed.
 */
export async function saveAgreementItem(
  agreementId: string,
  item: AgreementItemInput,
): Promise<ActionResult<string>> {
  const guard = await requirePermission(PERMS.AGREEMENTS_MANAGE)
  if (!guard.ok) return guard

  if (!item.effective_from) return { ok: false, error: 'Pick an effective-from date' }
  if (item.effective_to && item.effective_to < item.effective_from)
    return { ok: false, error: 'Effective-to date is before effective-from' }

  const supabase = await createClient()
  const status = await agreementStatus(supabase, agreementId)

  if (item.id && status && status !== 'draft' && status !== 'pending_approval') {
    return {
      ok: false,
      error: 'This agreement is active — edit existing terms through "Change terms" instead.',
    }
  }

  const itemRow = {
    agreement_id: agreementId,
    service_id: item.service_id || null,
    commitment_type: item.commitment_type,
    committed_quantity: item.committed_quantity != null ? Number(item.committed_quantity) : null,
    cycle: item.commitment_type === 'retainer' ? (item.cycle || 'monthly') : null,
    effective_from: item.effective_from,
    effective_to: item.effective_to || null,
    unit_price: item.unit_price != null ? Number(item.unit_price) : null,
    currency: item.currency || 'INR',
    carry_forward_rule: item.carry_forward_rule,
    extra_unit_price: item.extra_unit_price != null ? Number(item.extra_unit_price) : null,
    display_order: item.display_order ?? 0,
    notes: item.notes?.trim() || null,
    // Internal allocation (retainer only). allocated_unit_value is a GENERATED
    // column — never written here; the DB computes it.
    creative_allocation_amount:
      item.commitment_type === 'retainer' && item.creative_allocation_amount != null
        ? Number(item.creative_allocation_amount) : null,
    management_allocation_amount:
      item.commitment_type === 'retainer' && item.management_allocation_amount != null
        ? Number(item.management_allocation_amount) : null,
    included_quantity:
      item.commitment_type === 'retainer' && item.included_quantity != null
        ? Number(item.included_quantity) : null,
    updated_at: new Date().toISOString(),
  }

  let itemId = item.id
  if (itemId) {
    const { error } = await supabase.from('client_agreement_items').update(itemRow).eq('id', itemId)
    if (error) return { ok: false, error: error.message }
  } else {
    const { data, error } = await supabase
      .from('client_agreement_items')
      .insert(itemRow)
      .select('id')
      .single()
    if (error || !data) return { ok: false, error: error?.message || 'Failed to save item' }
    itemId = data.id
  }

  const childErr = await syncItemChildren(supabase, itemId!, item.deliverables || [], item.milestones || [])
  if (childErr) return { ok: false, error: childErr }

  // Covered services (retainer only). undefined ⇒ leave the mapping untouched.
  if (item.coveredServiceIds !== undefined && item.commitment_type === 'retainer') {
    const del = await supabase.from('agreement_item_services').delete().eq('agreement_item_id', itemId!)
    if (del.error) return { ok: false, error: del.error.message }
    const rows = Array.from(new Set(item.coveredServiceIds.filter(Boolean)))
      .map(sid => ({ agreement_item_id: itemId!, service_id: sid }))
    if (rows.length > 0) {
      const ins = await supabase.from('agreement_item_services').insert(rows)
      if (ins.error) return { ok: false, error: ins.error.message }
    }
  }

  const actor = await getActor()
  await logAgreementEvent(supabase, {
    agreementId,
    actorType: 'admin',
    actorId: actor?.id,
    actorLabel: actor?.name,
    action: item.id ? 'item_updated' : 'item_added',
  })

  revalidatePath(`/dashboard/agreements/${agreementId}`)
  return { ok: true, data: itemId }
}

/**
 * Change the terms of an item on an ACTIVE agreement (§2.3 close-and-replace):
 * the current term row is closed the day before `effectiveFrom`, and a
 * successor row carrying the new terms + copied deliverables/milestones is
 * inserted. History for past months therefore resolves the original terms.
 */
export async function changeAgreementItemTerms(
  agreementId: string,
  currentItemId: string,
  newTerms: AgreementItemInput,
): Promise<ActionResult<string>> {
  const guard = await requirePermission(PERMS.AGREEMENTS_MANAGE)
  if (!guard.ok) return guard

  if (!newTerms.effective_from) return { ok: false, error: 'Pick when the new terms take effect' }

  const supabase = await createClient()

  // Close the current row the day before the new terms start.
  const from = new Date(newTerms.effective_from + 'T00:00:00')
  from.setDate(from.getDate() - 1)
  const y = from.getFullYear()
  const m = String(from.getMonth() + 1).padStart(2, '0')
  const d = String(from.getDate()).padStart(2, '0')
  const closeDate = `${y}-${m}-${d}`

  const { data: current } = await supabase
    .from('client_agreement_items')
    .select('effective_from')
    .eq('id', currentItemId)
    .single()
  if (current && newTerms.effective_from <= current.effective_from)
    return { ok: false, error: 'New terms must start after the current term began' }

  const closeRes = await supabase
    .from('client_agreement_items')
    .update({ effective_to: closeDate, updated_at: new Date().toISOString() })
    .eq('id', currentItemId)
  if (closeRes.error) return { ok: false, error: closeRes.error.message }

  // Insert successor (drop the id so a fresh term row is created).
  const successor: AgreementItemInput = { ...newTerms, id: undefined, effective_to: null }
  const res = await saveAgreementItem(agreementId, successor)
  if (!res.ok) return res

  const actor = await getActor()
  await logAgreementEvent(supabase, {
    agreementId,
    actorType: 'admin',
    actorId: actor?.id,
    actorLabel: actor?.name,
    action: 'term_changed',
    detail: { from_item_id: currentItemId, to_item_id: res.data },
  })

  revalidatePath(`/dashboard/agreements/${agreementId}`)
  return res
}

export async function deleteAgreementItem(
  agreementId: string,
  itemId: string,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.AGREEMENTS_MANAGE)
  if (!guard.ok) return guard

  const supabase = await createClient()
  const status = await agreementStatus(supabase, agreementId)
  if (status && status !== 'draft' && status !== 'pending_approval')
    return { ok: false, error: 'Items on an active agreement cannot be deleted — change their terms instead.' }

  // Deliverables/milestones cascade via ON DELETE CASCADE.
  const { error } = await supabase.from('client_agreement_items').delete().eq('id', itemId)
  if (error) return { ok: false, error: error.message }

  const actor = await getActor()
  await logAgreementEvent(supabase, {
    agreementId,
    actorType: 'admin',
    actorId: actor?.id,
    actorLabel: actor?.name,
    action: 'item_removed',
  })

  revalidatePath(`/dashboard/agreements/${agreementId}`)
  return { ok: true }
}

/** Manually check a milestone off / on (unlinked milestones only). */
export async function toggleMilestone(
  agreementId: string,
  milestoneId: string,
  done: boolean,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.AGREEMENTS_MANAGE)
  if (!guard.ok) return guard

  const supabase = await createClient()
  const actor = await getActor()
  const { error } = await supabase
    .from('client_agreement_milestones')
    .update({
      completed_at: done ? new Date().toISOString() : null,
      completed_by: done ? actor?.id ?? null : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', milestoneId)

  if (error) return { ok: false, error: error.message }
  revalidatePath(`/dashboard/agreements/${agreementId}`)
  return { ok: true }
}

export async function addAgreementNote(
  agreementId: string,
  text: string,
  visibility: Visibility,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.AGREEMENTS_MANAGE)
  if (!guard.ok) return guard

  if (!text?.trim()) return { ok: false, error: 'Note is empty' }

  const supabase = await createClient()
  const actor = await getActor()

  const ok = await logAgreementEvent(supabase, {
    agreementId,
    actorType: 'admin',
    actorId: actor?.id,
    actorLabel: actor?.name,
    action: 'note',
    visibility,
    detail: { text: text.trim() },
  })

  if (!ok) return { ok: false, error: 'Failed to add note' }

  revalidatePath(`/dashboard/agreements/${agreementId}`)
  return { ok: true }
}

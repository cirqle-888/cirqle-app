'use server'

/**
 * Business Partner server actions.
 *
 * All mutations here touch only `business_partners` and (for linking) the
 * single `clients.business_partner_id` column — never `invoices`,
 * `invoice_items`, `payments`, or `cashbook_entries`.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { loadCurrentUser } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { getPartnerStatementData, type PartnerStatementData } from '@/lib/partners/queries'
import { todayISO } from '@/lib/utils/local-date'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

export interface PartnerInput {
  partnerCode: string
  name: string
  company: string | null
  phone: string | null
  email: string | null
  commissionType: 'percentage' | 'flat' | null
  commissionValue: number | null
  notes: string | null
}

export async function createPartner(input: PartnerInput): Promise<ActionResult<{ id: string }>> {
  const guard = await requirePermission(PERMS.PARTNERS_CREATE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()

  // The form pre-fills the next BP-XXX code, but a blank submit still gets one
  // (same convention as the auto 3-digit client code in quick-create-actions).
  let partnerCode = input.partnerCode?.trim()
  if (!partnerCode) {
    const { data: codes } = await admin.from('business_partners').select('partner_code')
    const nums = (codes ?? [])
      .map(r => parseInt(String(r.partner_code).replace(/\D/g, ''), 10))
      .filter(n => Number.isFinite(n))
    partnerCode = `BP-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0')}`
  }

  const { data, error } = await admin
    .from('business_partners')
    .insert({
      partner_code:     partnerCode,
      name:             input.name,
      company:          input.company || null,
      phone:            input.phone || null,
      email:            input.email || null,
      commission_type:  input.commissionType,
      commission_value: input.commissionValue,
      notes:            input.notes || null,
    })
    .select('id')
    .single()

  if (error) return { ok: false, error: error.message }

  revalidatePath('/dashboard/partners')
  return { ok: true, data: { id: data.id } }
}

export async function updatePartner(id: string, input: PartnerInput): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PARTNERS_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { error } = await admin
    .from('business_partners')
    .update({
      partner_code:     input.partnerCode,
      name:             input.name,
      company:          input.company || null,
      phone:            input.phone || null,
      email:            input.email || null,
      commission_type:  input.commissionType,
      commission_value: input.commissionValue,
      notes:            input.notes || null,
      updated_at:       new Date().toISOString(),
    })
    .eq('id', id)

  if (error) return { ok: false, error: error.message }

  revalidatePath('/dashboard/partners')
  revalidatePath(`/dashboard/partners/${id}`)
  return { ok: true }
}

export async function setPartnerStatus(id: string, status: 'active' | 'inactive'): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PARTNERS_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { error } = await admin
    .from('business_partners')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)

  if (error) return { ok: false, error: error.message }

  revalidatePath('/dashboard/partners')
  revalidatePath(`/dashboard/partners/${id}`)
  return { ok: true }
}

/**
 * Link (or unlink, when partnerId is null) a client to a partner.
 * The only write in this module that touches the `clients` table, and only
 * the `business_partner_id` column — invoices/payments are never modified.
 */
export async function linkClientToPartner(clientId: string, partnerId: string | null): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PARTNERS_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  // Unlinking drops the handover date with the link, so re-linking later doesn't
  // silently inherit the old partner's attribution window.
  const { error } = await admin
    .from('clients')
    .update(partnerId ? { business_partner_id: partnerId } : { business_partner_id: null, partner_since: null })
    .eq('id', clientId)

  if (error) {
    // Pre-migration DBs have no partner_since column — unlink still has to work.
    if (!partnerId && /partner_since/i.test(error.message)) {
      const { error: fallbackError } = await admin
        .from('clients')
        .update({ business_partner_id: null })
        .eq('id', clientId)
      if (fallbackError) return { ok: false, error: fallbackError.message }
    } else {
      return { ok: false, error: error.message }
    }
  }

  revalidatePath('/dashboard/partners')
  if (partnerId) revalidatePath(`/dashboard/partners/${partnerId}`)
  return { ok: true }
}

/**
 * Set (or clear) the date a partner took a client over. Only invoices issued on
 * or after it count towards that partner's collected / pending / statement
 * figures — see `attributedToPartner` in lib/partners/queries.ts. Clearing it
 * (null) means "this client was theirs from the start".
 */
export async function setClientPartnerSince(clientId: string, since: string | null): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PARTNERS_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('clients')
    .update({ partner_since: since || null })
    .eq('id', clientId)
    .select('business_partner_id')
    .single()

  if (error) {
    return /partner_since/i.test(error.message)
      ? { ok: false, error: 'Apply migration 20260714170000_client_partner_since.sql first.' }
      : { ok: false, error: error.message }
  }

  revalidatePath('/dashboard/partners')
  if (data?.business_partner_id) revalidatePath(`/dashboard/partners/${data.business_partner_id}`)
  return { ok: true }
}

/**
 * Save the partner's commission rate straight from the planner.
 *
 * Nothing else reads this yet — it's the remembered starting point for the next
 * planning session, not an agreement and not a payable. Settlement (who was
 * actually paid what, when) is still the "Coming Soon" card.
 */
export async function setPartnerCommissionRate(partnerId: string, percent: number | null): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PARTNERS_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  if (percent != null && (!Number.isFinite(percent) || percent < 0 || percent > 100)) {
    return { ok: false, error: 'Commission must be between 0 and 100%.' }
  }

  const admin = createAdminClient()
  const { error } = await admin
    .from('business_partners')
    .update({
      commission_type:  percent == null ? null : 'percentage',
      commission_value: percent,
      updated_at:       new Date().toISOString(),
    })
    .eq('id', partnerId)

  if (error) return { ok: false, error: error.message }

  revalidatePath(`/dashboard/partners/${partnerId}`)
  return { ok: true }
}

export interface CommissionPaymentInput {
  partnerId: string
  amountInr: number
  paidOn: string
  method: string | null
  reference: string | null
  /** Snapshot of what the payout was computed under — the rate can change later. */
  percent: number | null
  basis: 'net_collected' | 'net_invoiced' | 'profit' | null
  periodFrom: string | null
  periodTo: string | null
  notes: string | null
}

const MIGRATION_HINT = 'Apply migration 20260714180000_partner_commission_payments.sql first.'

/** Record a commission payout. The register stores what was PAID — never what is owed. */
export async function recordCommissionPayment(input: CommissionPaymentInput): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PARTNERS_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  if (!(input.amountInr > 0)) return { ok: false, error: 'Enter an amount greater than zero.' }

  const me = await loadCurrentUser().catch(() => null)
  const admin = createAdminClient()
  const { error } = await admin.from('partner_commission_payments').insert({
    partner_id:  input.partnerId,
    amount_inr:  input.amountInr,
    paid_on:     input.paidOn || todayISO(),
    method:      input.method || null,
    reference:   input.reference || null,
    percent:     input.percent,
    basis:       input.basis,
    period_from: input.periodFrom || null,
    period_to:   input.periodTo || null,
    notes:       input.notes || null,
    created_by:  me?.employeeId ?? null,
  })

  if (error) {
    return /relation|does not exist|schema cache/i.test(error.message)
      ? { ok: false, error: MIGRATION_HINT }
      : { ok: false, error: error.message }
  }

  revalidatePath(`/dashboard/partners/${input.partnerId}`)
  return { ok: true }
}

/** Soft-delete a payout — the row stays for audit, it just stops counting. */
export async function deleteCommissionPayment(id: string, partnerId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PARTNERS_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { error } = await admin
    .from('partner_commission_payments')
    .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)

  if (error) return { ok: false, error: error.message }

  revalidatePath(`/dashboard/partners/${partnerId}`)
  return { ok: true }
}

/** Fetch the client-wise statement data for export (WhatsApp/Image/PDF/Email). */
export async function fetchPartnerStatement(partnerId: string): Promise<ActionResult<PartnerStatementData>> {
  const guard = await requirePermission(PERMS.PARTNERS_EXPORT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const data = await getPartnerStatementData(partnerId)
  if (!data) return { ok: false, error: 'Business partner not found.' }
  return { ok: true, data }
}

export async function setPartnerGreeting(partnerId: string, greetingName: string | null): Promise<ActionResult> {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) return { ok: false, error: 'Not logged in' }

  const admin = createAdminClient()
  if (greetingName) {
    const { error } = await admin
      .from('employee_partner_preferences')
      .upsert({
        employee_id: me.employeeId,
        business_partner_id: partnerId,
        greeting_name: greetingName,
        updated_at: new Date().toISOString()
      }, { onConflict: 'employee_id, business_partner_id' })
    if (error) {
      return /relation|does not exist/i.test(error.message)
        ? { ok: false, error: 'Apply migration 20260801000000_employee_partner_preferences.sql first.' }
        : { ok: false, error: error.message }
    }
  } else {
    const { error } = await admin
      .from('employee_partner_preferences')
      .delete()
      .eq('employee_id', me.employeeId)
      .eq('business_partner_id', partnerId)
    if (error) {
      return /relation|does not exist/i.test(error.message)
        ? { ok: false, error: 'Apply migration 20260801000000_employee_partner_preferences.sql first.' }
        : { ok: false, error: error.message }
    }
  }
  return { ok: true }
}


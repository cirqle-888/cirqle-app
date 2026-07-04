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
import { requirePermission } from '@/lib/auth/enforce'
import { PERMS } from '@/lib/permissions/keys'
import { getPartnerStatementData, type PartnerStatementData } from '@/lib/partners/queries'

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
  const { error } = await admin
    .from('clients')
    .update({ business_partner_id: partnerId })
    .eq('id', clientId)

  if (error) return { ok: false, error: error.message }

  revalidatePath('/dashboard/partners')
  if (partnerId) revalidatePath(`/dashboard/partners/${partnerId}`)
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

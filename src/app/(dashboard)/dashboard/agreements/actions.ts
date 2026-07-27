'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/auth/enforce'
import { PERMS } from '@/lib/permissions/keys'
import { generateAgreementNumber } from '@/lib/agreements/numbering'
import { logAgreementEvent } from '@/lib/agreements/events'
import type { AgreementStatus, Visibility } from '@/lib/agreements/types'

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
  renewalType: 'none' | 'manual' | 'auto'
  notes?: string
}): Promise<ActionResult<string>> {
  const guard = await requirePermission(PERMS.AGREEMENTS_MANAGE)
  if (!guard.ok) return guard

  const supabase = await createClient()
  
  // Get client code for numbering
  const { data: client } = await supabase
    .from('clients')
    .select('client_code')
    .eq('id', input.clientId)
    .single()
    
  if (!client) return { ok: false, error: 'Client not found' }

  const creationDate = new Date()
  const { agreementNumber } = await generateAgreementNumber(supabase, creationDate, client.client_code)
  
  const { data, error } = await supabase
    .from('client_agreements')
    .insert({
      agreement_number: agreementNumber,
      client_id: input.clientId,
      title: input.title,
      status: 'draft',
      start_date: input.startDate,
      end_date: input.endDate || null,
      renewal_type: input.renewalType,
      notes: input.notes,
      created_by: guard.employeeId
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

export async function setAgreementStatus(
  agreementId: string, 
  status: AgreementStatus
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
  if (status === 'completed') action = 'completed'
  if (status === 'cancelled') action = 'cancelled'
  
  const actor = await getActor()
  await logAgreementEvent(supabase, {
    agreementId,
    actorType: 'admin',
    actorId: actor?.id,
    actorLabel: actor?.name,
    action,
    detail: { status }
  })
  
  revalidatePath('/dashboard/agreements')
  revalidatePath(`/dashboard/agreements/${agreementId}`)
  return { ok: true }
}

export async function saveAgreementItem(
  agreementId: string,
  input: any // Simplified for plan phase
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.AGREEMENTS_MANAGE)
  if (!guard.ok) return guard

  const supabase = await createClient()
  
  const { error } = await supabase
    .from('client_agreement_items')
    .upsert({
      ...input,
      agreement_id: agreementId,
      updated_at: new Date().toISOString()
    })
    
  if (error) return { ok: false, error: error.message }
  
  const actor = await getActor()
  await logAgreementEvent(supabase, {
    agreementId,
    actorType: 'admin',
    actorId: actor?.id,
    actorLabel: actor?.name,
    action: input.id ? 'item_updated' : 'item_added',
  })
  
  revalidatePath(`/dashboard/agreements/${agreementId}`)
  return { ok: true }
}

export async function addAgreementNote(
  agreementId: string,
  text: string,
  visibility: Visibility
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.AGREEMENTS_MANAGE)
  if (!guard.ok) return guard

  const supabase = await createClient()
  const actor = await getActor()
  
  const ok = await logAgreementEvent(supabase, {
    agreementId,
    actorType: 'admin',
    actorId: actor?.id,
    actorLabel: actor?.name,
    action: 'note',
    visibility,
    detail: { text }
  })
  
  if (!ok) return { ok: false, error: 'Failed to add note' }
  
  revalidatePath(`/dashboard/agreements/${agreementId}`)
  return { ok: true }
}

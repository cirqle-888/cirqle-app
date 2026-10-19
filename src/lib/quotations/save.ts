/**
 * Quotation writes: create, edit (header + replace lines) and delete-a-draft.
 *
 * Browser-side, through the cookie-session client, like the rest of the
 * Quotations page. Supabase gives the browser no transaction, so the edit is
 * ordered to leave nothing half-done on the failures that can actually happen:
 *
 *   1. read the current line ids         fails → nothing changed
 *   2. update the header, guarded on status still draft/sent
 *                                        no row → someone approved/converted
 *                                        it meanwhile; nothing changed
 *   3. insert the new lines              fails → header restored
 *   4. delete the old lines by id        fails → new lines removed, header restored
 *
 * Inserting before deleting means a failed save never leaves a quotation with
 * no lines and a total that bills for them.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  EDITABLE_QUOTATION_STATUSES,
  needsRenumber,
  nextQuotationNumber,
  normaliseQuotationLines,
  quotationNumberBase,
  quotationTotal,
  type QuotationFormValues,
} from './editing'

type Client = SupabaseClient

export type SaveResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** A quotation row as reloaded after a save: header, client and lines. */
export type SavedQuotation = { id: string; quotation_number: string } & Record<string, unknown>

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505'

const QUOTATION_SELECT = '*, client:clients(id, name, code, phone, email, address), items:quotation_items(*)'

/** The first unused number for this client and month (see nextQuotationNumber). */
export async function allocateQuotationNumber(
  supabase: Client,
  issueDateISO: string,
  clientCode: string,
  excludeId?: string,
): Promise<string> {
  const base = quotationNumberBase(issueDateISO, clientCode)
  let q = supabase.from('quotations').select('id, quotation_number').like('quotation_number', `${base}%`)
  if (excludeId) q = q.neq('id', excludeId)
  const { data } = await q
  return nextQuotationNumber(base, ((data || []) as { quotation_number: string }[]).map(r => r.quotation_number))
}

function headerOf(form: QuotationFormValues) {
  const lines = normaliseQuotationLines(form.items)
  return {
    lines,
    header: {
      client_id: form.client_id,
      issue_date: form.issue_date,
      valid_until: form.valid_until || null,
      currency: form.currency,
      total_amount: quotationTotal(lines),
      notes: form.notes,
      terms: form.terms,
    },
  }
}

function lineRows(quotationId: string, form: QuotationFormValues, lines: ReturnType<typeof normaliseQuotationLines>) {
  return lines.map(l => ({ ...l, quotation_id: quotationId, currency: form.currency }))
}

/**
 * Create a draft quotation and its lines. Retries the number on a unique
 * violation, which is what two people creating one for the same client in the
 * same minute would hit.
 */
export async function createQuotation(
  supabase: Client,
  form: QuotationFormValues,
  clientCode: string,
): Promise<SaveResult<SavedQuotation>> {
  const { header, lines } = headerOf(form)
  let lastError = 'Could not save the quotation.'
  for (let attempt = 0; attempt < 3; attempt++) {
    const quotation_number = await allocateQuotationNumber(supabase, form.issue_date, clientCode)
    const { data: quo, error } = await supabase
      .from('quotations')
      .insert({ ...header, quotation_number, status: 'draft' })
      .select('id')
      .single()
    if (error) {
      lastError = error.message
      if (error.code === UNIQUE_VIOLATION) continue
      return { ok: false, error: error.message }
    }
    if (lines.length) {
      const { error: itemsError } = await supabase.from('quotation_items').insert(lineRows(quo.id, form, lines))
      if (itemsError) {
        // A quotation whose total bills for lines that don't exist is worse than none.
        await supabase.from('quotations').delete().eq('id', quo.id)
        return { ok: false, error: itemsError.message }
      }
    }
    return reload(supabase, quo.id)
  }
  return { ok: false, error: lastError }
}

export interface ExistingQuotation {
  id: string
  quotation_number: string
  status: string
  client_id: string | null
  issue_date: string
  valid_until?: string | null
  currency: string
  total_amount: number
  notes?: string | null
  terms?: string | null
}

/** Save an edit to a draft or sent quotation, replacing its lines. */
export async function updateQuotation(
  supabase: Client,
  existing: ExistingQuotation,
  form: QuotationFormValues,
  clientCode: string,
): Promise<SaveResult<SavedQuotation>> {
  if (!(EDITABLE_QUOTATION_STATUSES as readonly string[]).includes(existing.status)) {
    return { ok: false, error: 'This quotation is no longer editable.' }
  }
  const { header, lines } = headerOf(form)

  // 1. Current lines, so exactly those are removed later.
  const { data: oldRows, error: oldError } = await supabase
    .from('quotation_items').select('id').eq('quotation_id', existing.id)
  if (oldError) return { ok: false, error: oldError.message }
  const oldIds = ((oldRows || []) as { id: string }[]).map(r => r.id)

  // 2. Header, only while still editable.
  const base = quotationNumberBase(form.issue_date, clientCode)
  const quotation_number = needsRenumber(existing.status, existing.quotation_number, base)
    ? await allocateQuotationNumber(supabase, form.issue_date, clientCode, existing.id)
    : existing.quotation_number
  const { data: updated, error: updError } = await supabase
    .from('quotations')
    .update({ ...header, quotation_number, updated_at: new Date().toISOString() })
    .eq('id', existing.id)
    .in('status', [...EDITABLE_QUOTATION_STATUSES])
    .select('id')
  if (updError) return { ok: false, error: updError.message }
  if (!updated || updated.length === 0) {
    return { ok: false, error: 'This quotation changed status while you were editing it and can no longer be edited. Reload to see it.' }
  }

  const restoreHeader = () => supabase.from('quotations').update({
    client_id: existing.client_id,
    issue_date: existing.issue_date,
    valid_until: existing.valid_until ?? null,
    currency: existing.currency,
    total_amount: existing.total_amount,
    notes: existing.notes ?? null,
    terms: existing.terms ?? null,
    quotation_number: existing.quotation_number,
  }).eq('id', existing.id)

  // 3. New lines.
  let newIds: string[] = []
  if (lines.length) {
    const { data: inserted, error: insError } = await supabase
      .from('quotation_items').insert(lineRows(existing.id, form, lines)).select('id')
    if (insError) {
      await restoreHeader()
      return { ok: false, error: insError.message }
    }
    newIds = ((inserted || []) as { id: string }[]).map(r => r.id)
  }

  // 4. Old lines.
  if (oldIds.length) {
    const { error: delError } = await supabase.from('quotation_items').delete().in('id', oldIds)
    if (delError) {
      if (newIds.length) await supabase.from('quotation_items').delete().in('id', newIds)
      await restoreHeader()
      return { ok: false, error: delError.message }
    }
  }

  return reload(supabase, existing.id)
}

/** Delete a quotation, but only while it is still a draft. Lines cascade. */
export async function deleteDraftQuotation(supabase: Client, id: string): Promise<SaveResult<null>> {
  const { data, error } = await supabase
    .from('quotations').delete().eq('id', id).eq('status', 'draft').select('id')
  if (error) return { ok: false, error: error.message }
  if (!data || data.length === 0) {
    return { ok: false, error: 'Only drafts can be deleted, and this one is no longer a draft. Reload to see it.' }
  }
  return { ok: true, value: null }
}

async function reload(supabase: Client, id: string): Promise<SaveResult<SavedQuotation>> {
  const { data, error } = await supabase.from('quotations').select(QUOTATION_SELECT).eq('id', id).single()
  if (error || !data) return { ok: false, error: error?.message || 'Saved, but the quotation could not be reloaded. Refresh the page.' }
  return { ok: true, value: data }
}

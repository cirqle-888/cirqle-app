/* eslint-disable @typescript-eslint/no-explicit-any -- rows from the untyped Supabase admin client. */
/**
 * Shared pieces of the Cirqle MCP server: the result shape, client lookup and
 * the column lists. Kept apart so the tool files can share them.
 */
import { z } from 'zod'
import type { createAdminClient } from '@/lib/supabase/server'
import { findClient } from '@/lib/ai/request-capture'

export type Admin = ReturnType<typeof createAdminClient>

export const MAX_LIMIT = 100
export const limitSchema = z.number().int().min(1).max(MAX_LIMIT).default(25).describe(`Max rows (1–${MAX_LIMIT}).`)
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').describe('YYYY-MM-DD')

export const CLIENT_COLS = 'id, code, name, contact_name, email, phone, country, region, default_currency, billing_cycle, is_active, created_at'
export const TASK_COLS = 'id, task_number, title, status, task_date, quantity, currency, billing_amount, billing_amount_inr, billing_mode, is_billable, client:clients(name), service:services!tasks_service_id_fkey(name)'
export const INVOICE_COLS = 'id, invoice_number, status, issue_date, due_date, currency, subtotal, tax_amount, total_amount, total_amount_inr, paid_amount, paid_amount_inr, client:clients(name)'
export const REQUEST_COLS = 'id, ref_no, title, status, client_status, priority, source, due_date, created_at, submitter_name, client:clients(name), service:services!task_requests_service_id_fkey(name)'

export const inr = (n: unknown) => `₹${Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

/** Uniform tool result: summary text + structured rows. */
export function result(text: string, data: unknown) {
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: (data && typeof data === 'object' && !Array.isArray(data)) ? data as Record<string, unknown> : { rows: data },
  }
}

export function fail(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

/** Resolve a client by name fragment or UUID; null when nothing matches. */
export async function resolveClient(admin: Admin, ref: string | undefined) {
  const q = (ref || '').trim()
  if (!q) return null
  if (/^[0-9a-f-]{36}$/i.test(q)) {
    const { data } = await admin.from('clients').select('id, name, code').eq('id', q).maybeSingle()
    return data
  }
  return findClient(admin, q)
}

export function flatten<T extends Record<string, any>>(rows: T[] | null) {
  return (rows || []).map((r) => ({
    ...r,
    client: r.client?.name ?? null,
    service: r.service?.name ?? null,
  }))
}


import { normalizeTaskTitle } from '@/lib/utils/title-case'
import { createAdminClient } from '@/lib/supabase/server'
import { aiParse, findClient, findService, normalizeDate } from '@/lib/ai/request-capture'
import { todayISO } from '@/lib/utils/local-date'
import { autoLinkTaskPackage } from '@/lib/packages/auto-link'

/**
 * Quick-action handlers shared by the iOS Shortcuts API (`/api/shortcut`) and
 * the MCP server (`/api/mcp`). Both authenticate with a shared bearer token and
 * run on the service-role admin client, so there is no employee identity to
 * attribute writes to — rows land unattributed (see the `created_by` notes
 * below). Every handler returns `{ ok: true, ... }` or `{ ok: false, error }`
 * and never throws on a bad input.
 */

const today = () => todayISO()

export type Admin = ReturnType<typeof createAdminClient>

export async function nextTaskNumber(admin: Admin): Promise<number> {
  const { data } = await admin.from('tasks')
    .select('task_number').order('task_number', { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
  return ((data?.task_number as number) ?? 0) + 1
}

// ── Action handlers ────────────────────────────────────────────────────────

export async function createRequest(admin: Admin, p: {
  title?: string; client?: string; notes?: string; service?: string; dueDate?: string
  /**
   * File it as NEW (unread by staff) instead of as something staff typed in
   * themselves. Used for items that arrive from outside, such as a WhatsApp
   * capture, so they show up in the inbox as waiting for a response.
   */
  unviewed?: boolean
  /** Links shown on the request, e.g. the original voice note or photo. */
  extraLinks?: { label: string; url: string }[]
}) {
  const title = normalizeTaskTitle(p.title)
  if (!title) return { ok: false, error: 'A title is required.' }
  const client = await findClient(admin, p.client)
  const service = await findService(admin, p.service)
  const now = new Date().toISOString()
  const { data, error } = await admin.from('task_requests').insert({
    source: 'manual',
    client_id: client?.id || null,
    submitter_name: client ? null : (p.client || null),
    title,
    description: (p.notes || '').trim() || null,
    service_id: service?.id || null,
    due_date: normalizeDate(p.dueDate),
    status: 'submitted',
    client_status: 'submitted',
    ...(p.unviewed
      ? { last_external_activity_at: now }   // arrived from outside → flag as "new"
      : { last_staff_viewed_at: now }),      // staff-created → don't self-flag as "new"
    ...(p.extraLinks?.length ? { extra_links: p.extraLinks.slice(0, 10) } : {}),
  }).select('id, ref_no, title').single()
  if (error) return { ok: false, error: error.message }
  const row = data as { id: string; ref_no: number | null; title: string }
  return {
    ok: true, kind: 'request',
    id: row.id,
    ref: `REQ-${String(row.ref_no ?? 0).padStart(4, '0')}`,
    title: row.title,
    client: client?.name || p.client || null,
    matchedClient: !!client,
  }
}

export async function duplicateTask(admin: Admin, p: { taskNumber?: number | string }) {
  const num = parseInt(String(p.taskNumber ?? '').replace(/^#/, ''), 10)
  if (isNaN(num)) return { ok: false, error: 'A valid taskNumber is required.' }
  const { data: src } = await admin.from('tasks')
    .select('title, description, client_id, service_id, billing_amount, billing_amount_inr, currency, quantity')
    .eq('task_number', num).is('deleted_at', null).maybeSingle()
  if (!src) return { ok: false, error: `Task #${num} not found.` }
  const tn = await nextTaskNumber(admin)
  const { data, error } = await admin.from('tasks').insert({
    task_number: tn,
    title: (src as any).title,
    description: (src as any).description,
    client_id: (src as any).client_id,
    service_id: (src as any).service_id,
    status: 'pending',
    billing_amount: (src as any).billing_amount,
    billing_amount_inr: (src as any).billing_amount_inr,
    currency: (src as any).currency,
    quantity: (src as any).quantity || 1,
    task_date: today(),
  }).select('id, task_number, title').single()
  if (error) return { ok: false, error: error.message }
  await autoLinkTaskPackage(admin, (data as { id: string }).id)
  return { ok: true, kind: 'task', taskNumber: (data as any).task_number, title: (data as any).title, duplicatedFrom: num }
}

export async function createTask(admin: Admin, p: { title?: string; client?: string; service?: string; amount?: number; date?: string; qty?: number }) {
  const title = (p.title || '').trim()
  if (!title) return { ok: false, error: 'A title is required.' }
  const client = await findClient(admin, p.client)
  const service = await findService(admin, p.service)
  const qty = Number(p.qty) > 0 ? Number(p.qty) : 1
  // Amount: explicit wins; else Pricing-Matrix price for client+service.
  let amount = Number(p.amount) || 0
  if (!amount && client && service) {
    const { data: pr } = await admin.from('client_service_pricing')
      .select('price').eq('client_id', client.id).eq('service_id', service.id).not('price', 'is', null).maybeSingle()
    if (pr?.price) amount = Number(pr.price)
  }
  const tn = await nextTaskNumber(admin)
  const { data, error } = await admin.from('tasks').insert({
    task_number: tn,
    title: normalizeTaskTitle(title),
    client_id: client?.id || null,
    service_id: service?.id || null,
    status: 'pending',
    billing_amount: amount * qty,
    billing_amount_inr: amount * qty,
    currency: 'INR',
    quantity: qty,
    task_date: normalizeDate(p.date) || today(),
  }).select('id, task_number, title').single()
  if (error) return { ok: false, error: error.message }
  // A package task must not also bill on its own — see lib/packages/auto-link.
  await autoLinkTaskPackage(admin, (data as { id: string }).id)
  return { ok: true, kind: 'task', taskNumber: (data as any).task_number, title: (data as any).title, client: client?.name || null, amount: amount * qty }
}

export async function createExpense(admin: Admin, p: { amount?: number; description?: string; category?: string; date?: string }) {
  const amount = Number(p.amount)
  if (!amount || amount <= 0) return { ok: false, error: 'A positive amount is required.' }
  // Match category by name; if none, leave null → shows as uncategorized/pending to complete later.
  let categoryId: string | null = null, categoryName: string | null = null
  if (p.category) {
    const { data: cat } = await admin.from('cashbook_categories')
      .select('id, name').ilike('name', `%${p.category.trim()}%`).limit(1).maybeSingle()
    if (cat) { categoryId = cat.id; categoryName = cat.name }
  }
  const d = normalizeDate(p.date) || today()
  // No `created_by`: this route authenticates with a single shared
  // SHORTCUT_API_TOKEN, so there is no employee identity in the request to
  // attribute to. Rows land unattributed and earn nobody the per-entry
  // ownership rate. Per-user tokens would be the prerequisite for changing that.
  const { data, error } = await admin.from('cashbook_entries').insert({
    type: 'outflow',
    category_id: categoryId,
    bank_account_id: null,
    amount,
    currency: 'INR',
    amount_inr: amount,
    exchange_rate: 1,
    rate_source: 'manual',
    rate_date: d,
    entry_date: d,
    description: (p.description || '').trim() || null,
    reference: 'Shortcut',
    invoice_id: null,
    client_id: null,
  }).select('id').single()
  if (error) return { ok: false, error: error.message }
  const pending = !categoryId || !(p.description || '').trim()
  return { ok: true, kind: 'expense', id: (data as any).id, amount, category: categoryName, pending,
    note: pending ? 'Saved as incomplete — add category/description in Cash Book.' : undefined }
}

export async function recordPayment(admin: Admin, p: { client?: string; amount?: number; date?: string; bankAccount?: string }) {
  const amount = Number(p.amount)
  if (!amount || amount <= 0) return { ok: false, error: 'A positive amount is required.' }
  const client = await findClient(admin, p.client)
  if (!client) return { ok: false, error: `Client "${p.client || ''}" not found.` }
  const d = normalizeDate(p.date) || today()

  // Optional bank account by name.
  let bankAccountId: string | null = null
  if (p.bankAccount) {
    const { data: ba } = await admin.from('bank_accounts').select('id').ilike('name', `%${p.bankAccount.trim()}%`).limit(1).maybeSingle()
    bankAccountId = ba?.id || null
  }

  // Inflow entry WITHOUT invoice_id (so the auto-allocate trigger doesn't fire);
  // we FIFO-allocate across the client's outstanding invoices ourselves.
  // No `created_by` — shared-token route, no employee identity to attribute to.
  const { data: entry, error: entryErr } = await admin.from('cashbook_entries').insert({
    type: 'inflow',
    category_id: null,
    bank_account_id: bankAccountId,
    amount,
    currency: 'INR',
    amount_inr: amount,
    exchange_rate: 1,
    rate_source: 'manual',
    rate_date: d,
    entry_date: d,
    description: `Payment received — ${client.name}`,
    reference: 'Shortcut',
    invoice_id: null,
    client_id: client.id,
  }).select('id').single()
  if (entryErr) return { ok: false, error: entryErr.message }

  // Outstanding invoices for this client, oldest first.
  const { data: invoices } = await admin.from('invoices')
    .select('id, invoice_number, total_amount_inr, total_amount, paid_amount_inr, paid_amount, status, issue_date')
    .eq('client_id', client.id)
    .not('status', 'in', '("paid","cancelled")')
    .order('issue_date', { ascending: true })
  let remaining = amount
  const allocations: { cashbook_entry_id: string; invoice_id: string; allocated_amount: number }[] = []
  const applied: string[] = []
  for (const inv of invoices || []) {
    if (remaining <= 0.01) break
    const total = Number((inv as any).total_amount_inr ?? (inv as any).total_amount ?? 0)
    const paid = Number((inv as any).paid_amount_inr ?? (inv as any).paid_amount ?? 0)
    const due = total - paid
    if (due <= 0.01) continue
    const alloc = Math.min(due, remaining)
    allocations.push({ cashbook_entry_id: (entry as any).id, invoice_id: (inv as any).id, allocated_amount: alloc })
    applied.push(`${(inv as any).invoice_number} (₹${alloc.toLocaleString('en-IN')})`)
    remaining -= alloc
  }
  if (allocations.length) {
    // Each allocation insert fires the trigger that updates the invoice's paid_amount + status.
    const { error: allocErr } = await admin.from('cashbook_invoice_allocations').insert(allocations)
    if (allocErr) return { ok: false, error: `Payment saved but allocation failed: ${allocErr.message}` }
  }
  return {
    ok: true, kind: 'payment', client: client.name, amount,
    allocated: amount - remaining, unallocated: remaining,
    appliedTo: applied,
    note: remaining > 0.01 ? `₹${remaining.toLocaleString('en-IN')} left as unallocated credit.` : undefined,
  }
}


/** AI-parse free text into a request, then file it in the Requests inbox. */
export async function createRequestFromText(admin: Admin, text: string) {
  const t = (text || '').trim()
  if (!t) return { ok: false as const, error: 'text is required.' }
  const parsed = await aiParse(t)
  const result = await createRequest(admin, {
    title: parsed.title || t.slice(0, 80), client: parsed.client, service: parsed.service, dueDate: parsed.dueDate, notes: t,
  })
  return result.ok ? { ...result, parsed } : result
}

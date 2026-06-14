import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

/**
 * Quick-action API for iOS/iPadOS Shortcuts (and any HTTP client).
 *
 * Auth: a single shared secret in the `Authorization: Bearer <token>` header,
 * compared to the `SHORTCUT_API_TOKEN` env var. No Supabase session — runs on
 * the service-role admin client, so the token IS the gate. Keep it secret.
 *
 *   POST /api/shortcut
 *   { "action": "...", ...fields }
 *
 * Actions:
 *   request   { title, client?, notes?, service?, dueDate? }     → Requests inbox
 *   requestAI { text }                                           → AI-parse → inbox
 *   duplicate { taskNumber }                                     → clone task to today
 *   task      { title, client?, service?, amount?, date?, qty? } → create task now
 *   expense   { amount, description?, category?, date? }         → cashbook outflow
 *   payment   { client, amount, date?, bankAccount? }           → cashbook inflow + FIFO allocate
 *
 * Every response is { ok: true, ... } or { ok: false, error }.
 */

const json = (body: unknown, status = 200) => NextResponse.json(body, { status })
const today = () => new Date().toISOString().split('T')[0]

/** Constant-ish-time token check. */
function authorized(req: NextRequest): boolean {
  const token = process.env.SHORTCUT_API_TOKEN
  if (!token) return false
  const header = req.headers.get('authorization') || ''
  const got = header.replace(/^Bearer\s+/i, '').trim()
  return got.length > 0 && got === token
}

type Admin = ReturnType<typeof createAdminClient>

/** Find a client by (fuzzy) name — exact match wins, else first contains. */
async function findClient(admin: Admin, name?: string | null) {
  const q = (name || '').trim()
  if (!q) return null
  const { data } = await admin
    .from('clients')
    .select('id, name, code')
    .ilike('name', `%${q}%`)
    .limit(10)
  const rows = data || []
  if (rows.length === 0) return null
  const exact = rows.find(r => r.name.toLowerCase() === q.toLowerCase())
  return exact || rows.sort((a, b) => a.name.length - b.name.length)[0]
}

/** Find a service by (fuzzy) name. */
async function findService(admin: Admin, name?: string | null) {
  const q = (name || '').trim()
  if (!q) return null
  const { data } = await admin
    .from('services').select('id, name').eq('is_active', true).ilike('name', `%${q}%`).limit(10)
  const rows = data || []
  if (!rows.length) return null
  const exact = rows.find(r => r.name.toLowerCase() === q.toLowerCase())
  return exact || rows.sort((a, b) => a.name.length - b.name.length)[0]
}

async function nextTaskNumber(admin: Admin): Promise<number> {
  const { data } = await admin.from('tasks')
    .select('task_number').order('task_number', { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
  return ((data?.task_number as number) ?? 0) + 1
}

/** Resolve a relative date phrase the Shortcut couldn't ("tomorrow" handled in AI step). */
function normalizeDate(d?: string | null): string | null {
  if (!d) return null
  const s = d.trim().toLowerCase()
  if (s === 'today') return today()
  if (s === 'tomorrow') { const t = new Date(); t.setDate(t.getDate() + 1); return t.toISOString().split('T')[0] }
  // ISO yyyy-mm-dd passes through
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  return null
}

/**
 * AI-parse a free-text dictation into structured request fields.
 * Uses Google Gemini (free tier — set GEMINI_API_KEY from Google AI Studio).
 * Model is overridable via GEMINI_MODEL; defaults to a free-tier Flash model.
 */
async function aiParse(text: string): Promise<{ client?: string; title?: string; service?: string; dueDate?: string }> {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('AI parsing is not configured (set GEMINI_API_KEY).')
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash'
  const todayStr = today()
  const body = JSON.stringify({
    system_instruction: {
      parts: [{ text:
        `You convert a short spoken note into a design-agency work request. Today is ${todayStr}. ` +
        `Extract: client (the customer/business name), title (a short task title), service (the kind of work, ` +
        `e.g. "Menu Design", "Offer Flyer"), dueDate (resolve "tomorrow"/"next friday" etc. against today as ` +
        `yyyy-mm-dd, else null).` }],
    },
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 300,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          client:  { type: 'string' },
          title:   { type: 'string' },
          service: { type: 'string' },
          dueDate: { type: 'string', nullable: true },
        },
      },
    },
  })
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  // Free-tier per-minute limits can throw a transient 429; retry a couple times.
  let res!: Response
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body,
    })
    if (res.ok || res.status !== 429) break
    if (attempt < 2) await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
  }
  if (!res.ok) {
    // Surface Gemini's real reason (quota exceeded, model not found, key invalid…)
    const detail = await res.text().catch(() => '')
    let msg = ''
    try { msg = JSON.parse(detail)?.error?.message || '' } catch { /* not json */ }
    throw new Error(`AI request failed (${res.status})${msg ? `: ${msg}` : ''}.`)
  }
  const data = await res.json()
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}'
  const match = raw.match(/\{[\s\S]*\}/)
  try { return JSON.parse(match ? match[0] : raw) } catch { return {} }
}

// ── Action handlers ────────────────────────────────────────────────────────

async function createRequest(admin: Admin, p: { title?: string; client?: string; notes?: string; service?: string; dueDate?: string }) {
  const title = (p.title || '').trim()
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
    last_staff_viewed_at: now,   // staff-created → don't self-flag as "new"
  }).select('id, ref_no, title').single()
  if (error) return { ok: false, error: error.message }
  return {
    ok: true, kind: 'request',
    ref: `REQ-${String((data as any).ref_no ?? 0).padStart(4, '0')}`,
    title: (data as any).title,
    client: client?.name || p.client || null,
    matchedClient: !!client,
  }
}

async function duplicateTask(admin: Admin, p: { taskNumber?: number | string }) {
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
  }).select('task_number, title').single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, kind: 'task', taskNumber: (data as any).task_number, title: (data as any).title, duplicatedFrom: num }
}

async function createTask(admin: Admin, p: { title?: string; client?: string; service?: string; amount?: number; date?: string; qty?: number }) {
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
    title,
    client_id: client?.id || null,
    service_id: service?.id || null,
    status: 'pending',
    billing_amount: amount * qty,
    billing_amount_inr: amount * qty,
    currency: 'INR',
    quantity: qty,
    task_date: normalizeDate(p.date) || today(),
  }).select('task_number, title').single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, kind: 'task', taskNumber: (data as any).task_number, title: (data as any).title, client: client?.name || null, amount: amount * qty }
}

async function createExpense(admin: Admin, p: { amount?: number; description?: string; category?: string; date?: string }) {
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

async function recordPayment(admin: Admin, p: { client?: string; amount?: number; date?: string; bankAccount?: string }) {
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

export async function POST(req: NextRequest) {
  if (process.env.SHORTCUT_API_TOKEN == null) {
    return json({ ok: false, error: 'Shortcut API is disabled (SHORTCUT_API_TOKEN not set).' }, 503)
  }
  if (!authorized(req)) return json({ ok: false, error: 'Unauthorized.' }, 401)

  let body: any
  try { body = await req.json() } catch { return json({ ok: false, error: 'Invalid JSON body.' }, 400) }
  const action = String(body?.action || '').trim()
  const admin = createAdminClient()

  try {
    let result
    switch (action) {
      case 'request':   result = await createRequest(admin, body); break
      case 'requestAI': {
        const text = (body?.text || '').trim()
        if (!text) { result = { ok: false, error: 'text is required for requestAI.' }; break }
        const parsed = await aiParse(text)
        result = await createRequest(admin, { title: parsed.title || text.slice(0, 80), client: parsed.client, service: parsed.service, dueDate: parsed.dueDate, notes: text })
        if (result.ok) (result as any).parsed = parsed
        break
      }
      case 'duplicate': result = await duplicateTask(admin, body); break
      case 'task':      result = await createTask(admin, body); break
      case 'expense':   result = await createExpense(admin, body); break
      case 'payment':   result = await recordPayment(admin, body); break
      default:          result = { ok: false, error: `Unknown action "${action}". Use: request | requestAI | duplicate | task | expense | payment.` }
    }
    return json(result, result.ok ? 200 : 400)
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'Server error.' }, 500)
  }
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import {
  limitSchema, isoDate, CLIENT_COLS, TASK_COLS, INVOICE_COLS, REQUEST_COLS,
  inr, result, fail, resolveClient, flatten,
} from './shared'
import { registerAutomationTools } from './tools-automation'
import {
  createRequest, createRequestFromText, duplicateTask, createTask, createExpense, recordPayment,
} from '@/lib/shortcut/actions'
import { planMonth, listSocialPlan, addSocialPlanItems, MAX_ITEMS_PER_CALL } from '@/lib/social/plan-mcp'
import { CONTENT_TYPES, PLATFORMS } from '@/lib/social/plan'
import { OPEN_STATUSES as OPEN_INVOICE_STATUSES, outstandingAmount } from '@/lib/finance/invoice-revenue'
import { OPEN_REQUEST_STATUSES } from './ops-actions'

/**
 * Cirqle MCP server — lets an AI client (Claude Desktop, Claude Code, claude.ai
 * connectors, Cursor…) read the agency's operational data and file the same
 * quick actions the iOS Shortcuts API exposes.
 *
 * TRUST MODEL: the whole server sits behind one shared bearer token
 * (`MCP_API_TOKEN`, checked in `src/app/api/mcp/route.ts`) and runs on the
 * service-role admin client. There is NO per-employee identity, so none of the
 * app's permission / department scoping applies — whoever holds the token sees
 * everything an admin sees. That is why the read tools deliberately stay away
 * from payroll, employee salary/bank data, OAuth tokens and client hub tokens,
 * and why the token must only be given to the owner's own AI clients.
 *
 * Shape: every tool returns a short human-readable summary as `text` plus the
 * raw rows as `structuredContent`, so an agent can either quote or compute.
 */

export function createCirqleMcpServer() {
  const server = new McpServer({ name: 'cirqle', version: '0.2.0' })
  const admin = createAdminClient()

  // ── Discovery ────────────────────────────────────────────────────────────

  server.registerTool('search', {
    title: 'Search Cirqle',
    description: 'Search clients, tasks, invoices and requests by name, title or number. Use this first when you only have a vague reference.',
    inputSchema: { query: z.string().min(1).describe('Free text, e.g. a client name, task title, "#1883" or "INV-0042".') },
    annotations: { readOnlyHint: true },
  }, async ({ query }) => {
    const q = query.trim()
    const num = parseInt(q.replace(/^#/, ''), 10)
    const like = `%${q}%`
    const [clients, tasks, invoices, requests] = await Promise.all([
      admin.from('clients').select('id, code, name, is_active').or(`name.ilike.${like},code.ilike.${like}`).limit(10),
      isNaN(num)
        ? admin.from('tasks').select(TASK_COLS).is('deleted_at', null).ilike('title', like).order('task_date', { ascending: false }).limit(10)
        : admin.from('tasks').select(TASK_COLS).is('deleted_at', null).eq('task_number', num).limit(5),
      admin.from('invoices').select(INVOICE_COLS).ilike('invoice_number', like).order('issue_date', { ascending: false }).limit(10),
      admin.from('task_requests').select(REQUEST_COLS).is('archived_at', null).ilike('title', like).order('created_at', { ascending: false }).limit(10),
    ])
    const out = {
      clients: clients.data || [],
      tasks: flatten(tasks.data),
      invoices: flatten(invoices.data),
      requests: flatten(requests.data),
    }
    const counts = `${out.clients.length} clients, ${out.tasks.length} tasks, ${out.invoices.length} invoices, ${out.requests.length} requests`
    return result(`Search "${q}": ${counts}.`, out)
  })

  server.registerTool('list_services', {
    title: 'List services',
    description: 'The agency\'s service catalogue (what can be billed): name, pricing type, default price.',
    inputSchema: { include_inactive: z.boolean().default(false) },
    annotations: { readOnlyHint: true },
  }, async ({ include_inactive }) => {
    let q = admin.from('services').select('id, name, description, pricing_type, default_price, default_currency, retainer_cycle, is_active').order('display_order')
    if (!include_inactive) q = q.eq('is_active', true)
    const { data, error } = await q
    if (error) return fail(error.message)
    return result(`${data.length} services: ${data.map((s) => s.name).join(', ')}`, { services: data })
  })

  // ── Clients ──────────────────────────────────────────────────────────────

  server.registerTool('list_clients', {
    title: 'List clients',
    description: 'List clients, optionally filtered by a name fragment. Returns contact and billing basics, never hub/intake tokens.',
    inputSchema: {
      query: z.string().optional().describe('Name or code fragment.'),
      include_inactive: z.boolean().default(false),
      limit: limitSchema,
    },
    annotations: { readOnlyHint: true },
  }, async ({ query, include_inactive, limit }) => {
    let q = admin.from('clients').select(CLIENT_COLS).order('name').limit(limit)
    if (query) q = q.or(`name.ilike.%${query}%,code.ilike.%${query}%`)
    if (!include_inactive) q = q.eq('is_active', true)
    const { data, error } = await q
    if (error) return fail(error.message)
    return result(`${data.length} clients.`, { clients: data })
  })

  server.registerTool('get_client', {
    title: 'Client overview',
    description: 'One client with its outstanding invoices, recent tasks and open requests. Accepts a name fragment or id.',
    inputSchema: { client: z.string().describe('Client name (fuzzy) or id.') },
    annotations: { readOnlyHint: true },
  }, async ({ client }) => {
    const c = await resolveClient(admin, client)
    if (!c) return fail(`No client matches "${client}".`)
    const [detail, invoices, tasks, requests] = await Promise.all([
      admin.from('clients').select(CLIENT_COLS).eq('id', c.id).single(),
      admin.from('invoices').select(INVOICE_COLS).eq('client_id', c.id).in('status', OPEN_INVOICE_STATUSES).order('issue_date'),
      admin.from('tasks').select(TASK_COLS).eq('client_id', c.id).is('deleted_at', null).order('task_date', { ascending: false }).limit(20),
      admin.from('task_requests').select(REQUEST_COLS).eq('client_id', c.id).is('archived_at', null).in('status', OPEN_REQUEST_STATUSES).order('created_at', { ascending: false }).limit(20),
    ])
    const outstanding = (invoices.data || []).reduce((s, i) => s + outstandingAmount(i), 0)
    const out = {
      client: detail.data,
      outstanding_inr: outstanding,
      open_invoices: flatten(invoices.data),
      recent_tasks: flatten(tasks.data),
      open_requests: flatten(requests.data),
    }
    return result(`${c.name}: ${out.open_invoices.length} open invoices (${inr(outstanding)} outstanding), ${out.recent_tasks.length} recent tasks, ${out.open_requests.length} open requests.`, out)
  })

  // ── Tasks ────────────────────────────────────────────────────────────────

  server.registerTool('list_tasks', {
    title: 'List tasks',
    description: 'Tasks (billable work items) filtered by client, status and date range. Newest first.',
    inputSchema: {
      client: z.string().optional().describe('Client name (fuzzy) or id.'),
      status: z.string().optional().describe('pending, in_progress, delivered, done, invoiced or cancelled'),
      from: isoDate.optional().describe('task_date >= this'),
      to: isoDate.optional().describe('task_date <= this'),
      limit: limitSchema,
    },
    annotations: { readOnlyHint: true },
  }, async ({ client, status, from, to, limit }) => {
    let q = admin.from('tasks').select(TASK_COLS).is('deleted_at', null).order('task_date', { ascending: false }).order('task_number', { ascending: false }).limit(limit)
    if (client) {
      const c = await resolveClient(admin, client)
      if (!c) return fail(`No client matches "${client}".`)
      q = q.eq('client_id', c.id)
    }
    if (status) q = q.eq('status', status)
    if (from) q = q.gte('task_date', from)
    if (to) q = q.lte('task_date', to)
    const { data, error } = await q
    if (error) return fail(error.message)
    const rows = flatten(data)
    const total = rows.reduce((s, t) => s + Number(t.billing_amount_inr ?? 0), 0)
    return result(`${rows.length} tasks, ${inr(total)} billing value.`, { tasks: rows })
  })

  server.registerTool('get_task', {
    title: 'Get task',
    description: 'Full detail of one task by its number (e.g. 1883 or "#1883").',
    inputSchema: { task_number: z.union([z.number().int(), z.string()]).describe('Task number.') },
    annotations: { readOnlyHint: true },
  }, async ({ task_number }) => {
    const num = parseInt(String(task_number).replace(/^#/, ''), 10)
    if (isNaN(num)) return fail('A numeric task number is required.')
    const { data, error } = await admin.from('tasks')
      .select(`${TASK_COLS}, description, completion_pct, is_recurring, parent_task_id, created_at, updated_at`)
      .eq('task_number', num).is('deleted_at', null).maybeSingle()
    if (error) return fail(error.message)
    if (!data) return fail(`Task #${num} not found.`)
    const [t] = flatten([data])
    return result(`#${t.task_number} ${t.title} — ${t.client ?? 'internal'} / ${t.service ?? '—'} — ${t.status}, ${inr(t.billing_amount_inr)}.`, { task: t })
  })

  // ── Invoices ─────────────────────────────────────────────────────────────

  server.registerTool('list_invoices', {
    title: 'List invoices',
    description: 'Invoices filtered by client and status. `outstanding_only` keeps invoices sent to the client and not yet settled (sent, partial, overdue) and reports the amount due; drafts are not owed yet.',
    inputSchema: {
      client: z.string().optional().describe('Client name (fuzzy) or id.'),
      status: z.string().optional().describe('e.g. draft, sent, partial, paid, overdue, cancelled'),
      outstanding_only: z.boolean().default(false),
      from: isoDate.optional().describe('issue_date >= this'),
      to: isoDate.optional().describe('issue_date <= this'),
      limit: limitSchema,
    },
    annotations: { readOnlyHint: true },
  }, async ({ client, status, outstanding_only, from, to, limit }) => {
    let q = admin.from('invoices').select(INVOICE_COLS).order('issue_date', { ascending: false }).limit(limit)
    if (client) {
      const c = await resolveClient(admin, client)
      if (!c) return fail(`No client matches "${client}".`)
      q = q.eq('client_id', c.id)
    }
    if (status) q = q.eq('status', status)
    if (outstanding_only) q = q.in('status', OPEN_INVOICE_STATUSES)
    if (from) q = q.gte('issue_date', from)
    if (to) q = q.lte('issue_date', to)
    const { data, error } = await q
    if (error) return fail(error.message)
    const rows = flatten(data).map((i) => ({
      ...i,
      due_inr: outstandingAmount(i),
    }))
    const due = rows.reduce((s, i) => s + i.due_inr, 0)
    return result(`${rows.length} invoices, ${inr(due)} due.`, { invoices: rows, total_due_inr: due })
  })

  server.registerTool('get_invoice', {
    title: 'Get invoice',
    description: 'One invoice with its line items, by invoice number.',
    inputSchema: { invoice_number: z.string().describe('e.g. INV-0042') },
    annotations: { readOnlyHint: true },
  }, async ({ invoice_number }) => {
    const { data, error } = await admin.from('invoices')
      .select(`${INVOICE_COLS}, notes, billing_period_start, billing_period_end, items:invoice_items(description, quantity, unit_price, total, service:services!invoice_items_service_id_fkey(name))`)
      .ilike('invoice_number', invoice_number.trim()).maybeSingle()
    if (error) return fail(error.message)
    if (!data) return fail(`Invoice ${invoice_number} not found.`)
    const [inv] = flatten([data])
    inv.items = (data.items || []).map((it: any) => ({ ...it, service: it.service?.name ?? null }))
    return result(`${inv.invoice_number} — ${inv.client ?? '—'} — ${inv.status}, total ${inr(inv.total_amount_inr)}, paid ${inr(inv.paid_amount_inr)}.`, { invoice: inv })
  })

  // ── Requests inbox ───────────────────────────────────────────────────────

  server.registerTool('list_requests', {
    title: 'List requests',
    description: 'The Requests inbox (work asked for by clients/staff that is not yet a task). Open requests by default. A request filed from WhatsApp carries `whatsapp`: who sent the last message and when, and when Cirqle replied in the chat (null = no reply seen yet).',
    inputSchema: {
      status: z.string().optional().describe('Filter to one status (submitted, in_progress, waiting_for_content, revision_requested, delivered, completed, cancelled…); omit for all open requests.'),
      client: z.string().optional().describe('Client name (fuzzy) or id.'),
      limit: limitSchema,
    },
    annotations: { readOnlyHint: true },
  }, async ({ status, client, limit }) => {
    let q = admin.from('task_requests').select(`${REQUEST_COLS}, description`).is('archived_at', null).order('created_at', { ascending: false }).limit(limit)
    if (status) q = q.eq('status', status)
    else q = q.in('status', OPEN_REQUEST_STATUSES)
    if (client) {
      const c = await resolveClient(admin, client)
      if (!c) return fail(`No client matches "${client}".`)
      q = q.eq('client_id', c.id)
    }
    const { data, error } = await q
    if (error) return fail(error.message)
    // For requests the WhatsApp listener filed: when the client's last message was sent and whether
    // Cirqle has replied in the chat since, so a brief does not report an answered message as new work.
    const ids = ((data || []) as { id: string }[]).map((r) => r.id)
    const wa = new Map<string, { last_message_at: string; sent_by: string | null; cirqle_replied_at: string | null }>()
    if (ids.length) {
      const { data: acts } = await admin.from('request_activity').select('request_id, action, actor_label, created_at, detail')
        .in('request_id', ids).in('action', ['whatsapp_message', 'whatsapp_reply']).order('created_at', { ascending: true }).limit(2000)
      for (const a of (acts || []) as { request_id: string; action: string; actor_label: string | null; created_at: string; detail: { sentAt?: string; repliedAt?: string } | null }[]) {
        const w = wa.get(a.request_id) ?? { last_message_at: '', sent_by: null, cirqle_replied_at: null }
        if (a.action === 'whatsapp_reply') w.cirqle_replied_at = a.detail?.repliedAt ?? a.created_at
        else {
          const at = a.detail?.sentAt ?? a.created_at
          if (at > w.last_message_at) { w.last_message_at = at; w.sent_by = a.actor_label }
        }
        wa.set(a.request_id, w)
      }
    }
    const rows = flatten(data).map((r) => ({
      ...r, ref: `REQ-${String(r.ref_no ?? 0).padStart(4, '0')}`,
      ...(wa.has(r.id as string) ? { whatsapp: wa.get(r.id as string) } : {}),
    }))
    return result(`${rows.length} requests.`, { requests: rows })
  })

  // ── Social Calendar ──────────────────────────────────────────────────────

  const monthSchema = z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, 'YYYY-MM').describe('The plan month, YYYY-MM.')

  server.registerTool('list_social_plan', {
    title: 'Read a client\'s social plan',
    description: 'One client\'s Social Calendar plan for a month: every planned item and undated idea with its date, type, platforms, caption and notes. Read this before adding items, so nothing is planned twice.',
    inputSchema: {
      client: z.string().min(1).describe('Client name (fuzzy) or id.'),
      month: monthSchema,
    },
    annotations: { readOnlyHint: true },
  }, async ({ client, month }) => {
    const c = await resolveClient(admin, client)
    if (!c) return fail(`No client matches "${client}".`)
    const m = planMonth(month)
    if (!m) return fail('Give the month as YYYY-MM.')
    const r = await listSocialPlan(admin, c.id, m)
    if (!r.ok) return fail(r.error)
    if (!r.plan) return result(`${c.name} has no plan for ${m.slice(0, 7)} yet.`, { client: c.name, month: m.slice(0, 7), plan: null, items: [] })
    const dated = r.items.filter((i) => i.scheduled_date).length
    return result(`${c.name}, ${m.slice(0, 7)}: ${dated} dated items and ${r.items.length - dated} ideas.`,
      { client: c.name, month: m.slice(0, 7), plan: r.plan, items: r.items })
  })

  // ── Cash book ────────────────────────────────────────────────────────────

  server.registerTool('cashbook_summary', {
    title: 'Cash book summary',
    description: 'Inflows and outflows for a date range, grouped by category. Amounts in INR.',
    inputSchema: { from: isoDate, to: isoDate },
    annotations: { readOnlyHint: true },
  }, async ({ from, to }) => {
    const { data, error } = await admin.from('cashbook_entries')
      .select('type, amount_inr, entry_date, description, category:cashbook_categories(name), client:clients(name)')
      .is('deleted_at', null).gte('entry_date', from).lte('entry_date', to).order('entry_date')
    if (error) return fail(error.message)
    const byCat: Record<string, { type: string; category: string; total_inr: number; count: number }> = {}
    let inflow = 0, outflow = 0
    for (const e of data || []) {
      const cat = (e as any).category?.name ?? 'Uncategorised'
      const key = `${e.type}:${cat}`
      byCat[key] ??= { type: e.type, category: cat, total_inr: 0, count: 0 }
      byCat[key].total_inr += Number(e.amount_inr || 0)
      byCat[key].count++
      if (e.type === 'inflow') inflow += Number(e.amount_inr || 0); else outflow += Number(e.amount_inr || 0)
    }
    const groups = Object.values(byCat).sort((a, b) => b.total_inr - a.total_inr)
    return result(`${from} → ${to}: in ${inr(inflow)}, out ${inr(outflow)}, net ${inr(inflow - outflow)} across ${data?.length ?? 0} entries.`,
      { from, to, inflow_inr: inflow, outflow_inr: outflow, net_inr: inflow - outflow, by_category: groups })
  })

  // ── Writes (same handlers as the iOS Shortcuts API) ──────────────────────

  const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  const fromAction = (r: { ok: boolean; error?: string; [k: string]: unknown }, summary: (r: any) => string) =>
    r.ok ? result(summary(r), r) : fail(r.error || 'Failed.')

  server.registerTool('create_request', {
    title: 'File a request',
    description: 'Add an item to the Requests inbox for staff to triage. Client and service are matched fuzzily by name; unmatched client names are kept as the submitter name.',
    inputSchema: {
      title: z.string().min(1),
      client: z.string().optional(),
      service: z.string().optional(),
      notes: z.string().optional(),
      due_date: isoDate.optional(),
    },
    annotations: writeAnnotations,
  }, async ({ title, client, service, notes, due_date }) =>
    fromAction(await createRequest(admin, { title, client, service, notes, dueDate: due_date }),
      (r) => `Filed ${r.ref}: ${r.title}${r.client ? ` for ${r.client}` : ''}${r.matchedClient ? '' : ' (client not matched)'}.`))

  server.registerTool('add_social_plan_items', {
    title: 'Add items to a client\'s social plan',
    description: `Put approved post ideas into a client's Social Calendar for a month, as PLANNED items (an item without a date lands on the Idea Board). Creates the month's plan if there is none. Items already in the plan (same day and title) are skipped, so it is safe to send again. This only plans: it never sends work to Requests, schedules or publishes anything. Show the list to the person and get a yes before calling. Up to ${MAX_ITEMS_PER_CALL} items a call; if one item is invalid, nothing is saved.`,
    inputSchema: {
      client: z.string().min(1).describe('Client name (fuzzy) or id.'),
      month: monthSchema,
      plan_title: z.string().optional().describe('Label for a newly created plan, e.g. "December content plan".'),
      items: z.array(z.object({
        title: z.string().min(1).describe('The post idea in one line.'),
        date: isoDate.optional().describe('Day to post, inside the month. Leave out for an undated idea.'),
        content_type: z.enum(CONTENT_TYPES).default('post'),
        platforms: z.array(z.enum(PLATFORMS)).default([]),
        caption: z.string().optional().describe('Draft caption, plain text.'),
        notes: z.string().optional().describe('Brief for the designer: hook, visual direction, and the source link for a trend.'),
        asap: z.boolean().default(false).describe('A trend post: publish as soon as it is approved.'),
        links: z.array(z.object({ label: z.string().default(''), url: z.string() })).max(10).optional()
          .describe('Reference links for the designer: real pages you opened, never invented.'),
        images: z.array(z.string()).max(8).optional()
          .describe('Reference pictures: direct image links (ending .jpg, .png, .webp) you opened. Shown as previews.'),
      })).min(1).max(MAX_ITEMS_PER_CALL),
    },
    annotations: writeAnnotations,
  }, async ({ client, month, plan_title, items }) => {
    const c = await resolveClient(admin, client)
    if (!c) return fail(`No client matches "${client}". Nothing was saved.`)
    const m = planMonth(month)
    if (!m) return fail('Give the month as YYYY-MM.')
    const r = await addSocialPlanItems(admin, { clientId: c.id, month: m, items, planTitle: plan_title })
    if (!r.ok) return fail(r.error)
    const skipped = r.skipped.length ? ` ${r.skipped.length} already there, skipped.` : ''
    return result(`${c.name}, ${m.slice(0, 7)}: added ${r.added} planned item${r.added === 1 ? '' : 's'}${r.createdPlan ? ' in a new plan' : ''}.${skipped} Open: /dashboard/social-calendar?calendar=${r.calendarId}`,
      { client: c.name, month: m.slice(0, 7), calendar_id: r.calendarId, created_plan: r.createdPlan, added: r.added, skipped: r.skipped, items: r.items })
  })

  server.registerTool('create_request_from_text', {
    title: 'File a request from free text',
    description: 'AI-parse a free-form sentence ("Zara needs 3 reels by Friday") into a request and file it in the inbox.',
    inputSchema: { text: z.string().min(1) },
    annotations: writeAnnotations,
  }, async ({ text }) =>
    fromAction(await createRequestFromText(admin, text), (r) => `Filed ${r.ref}: ${r.title}${r.client ? ` for ${r.client}` : ''}.`))

  server.registerTool('create_task', {
    title: 'Create a task',
    description: 'Create a billable task now. If amount is omitted and client+service match, the Pricing Matrix price is used.',
    inputSchema: {
      title: z.string().min(1),
      client: z.string().optional(),
      service: z.string().optional(),
      amount: z.number().nonnegative().optional().describe('Unit price in INR.'),
      quantity: z.number().int().positive().default(1),
      date: isoDate.optional().describe('task_date; defaults to today.'),
    },
    annotations: writeAnnotations,
  }, async ({ title, client, service, amount, quantity, date }) =>
    fromAction(await createTask(admin, { title, client, service, amount, qty: quantity, date }),
      (r) => `Created task #${r.taskNumber}: ${r.title}${r.client ? ` for ${r.client}` : ''} — ${inr(r.amount)}.`))

  server.registerTool('duplicate_task', {
    title: 'Duplicate a task',
    description: 'Clone an existing task (title, client, service, price) as a new pending task dated today.',
    inputSchema: { task_number: z.union([z.number().int(), z.string()]) },
    annotations: writeAnnotations,
  }, async ({ task_number }) =>
    fromAction(await duplicateTask(admin, { taskNumber: task_number }),
      (r) => `Created task #${r.taskNumber} (copy of #${r.duplicatedFrom}): ${r.title}.`))

  server.registerTool('record_expense', {
    title: 'Record an expense',
    description: 'Add a cash-book outflow. Category is matched by name; if missing, the entry is saved as incomplete for later review.',
    inputSchema: {
      amount: z.number().positive().describe('INR'),
      description: z.string().optional(),
      category: z.string().optional(),
      date: isoDate.optional(),
    },
    annotations: writeAnnotations,
  }, async (p) =>
    fromAction(await createExpense(admin, p), (r) => `Recorded expense ${inr(r.amount)}${r.category ? ` (${r.category})` : ''}.${r.note ? ` ${r.note}` : ''}`))

  server.registerTool('record_payment', {
    title: 'Record a client payment',
    description: 'Add a cash-book inflow for a client and allocate it FIFO across their outstanding invoices.',
    inputSchema: {
      client: z.string().min(1),
      amount: z.number().positive().describe('INR'),
      date: isoDate.optional(),
      bank_account: z.string().optional().describe('Bank account name fragment.'),
    },
    annotations: writeAnnotations,
  }, async ({ client, amount, date, bank_account }) =>
    fromAction(await recordPayment(admin, { client, amount, date, bankAccount: bank_account }),
      (r) => `Recorded ${inr(r.amount)} from ${r.client}; applied to ${(r.appliedTo as string[]).join(', ') || 'nothing'}.${r.note ? ` ${r.note}` : ''}`))

  registerAutomationTools(server, admin)

  return server
}

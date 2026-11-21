/* eslint-disable @typescript-eslint/no-explicit-any -- rows from the untyped Supabase admin client; each is narrowed before it leaves this file. */
/**
 * Cirqle MCP, part 2: the tools that let an AI run work end to end — Client
 * Cards and prompts, editing and sending the Social Calendar, moving tasks,
 * unbilled work, a daily snapshot, leads and quotations — plus ready-made
 * workflow prompts (morning brief, monthly plan, card fill, trend check).
 *
 * Same trust model as server.ts: one owner token, admin data access, no
 * payroll or employee pay data, nothing sent outside the app, nothing deleted
 * once work has started on it.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { todayISO } from '@/lib/utils/local-date'
import { CONTENT_TYPES, PLATFORMS } from '@/lib/social/plan'
import { cardFillPrompt, styleStudyPrompt } from '@/lib/prompt-studio/card-fill'
import { type Admin, fail, inr, isoDate, limitSchema, resolveClient, result } from './shared'
import {
  MAX_SEND_PER_CALL, removePlanItems, sendPlanItemsToRequests, updatePlanItem, upcomingPosts,
} from './social-actions'
import {
  allTemplates, buildPrompt, cardSchema, describeCard, mergeCard, readCard, saveCard, templateSummary,
} from './content-actions'
import {
  LEAD_STATUSES, SETTABLE_TASK_STATUSES, businessSnapshot, setTaskStatus, unbilledTasks, updateLead,
} from './ops-actions'

const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
const uuid = z.string().regex(/^[0-9a-f-]{36}$/i, 'an id from a list tool')
const clientArg = z.string().min(1).describe('Client name (fuzzy) or id.')
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA') }
const refOf = (n: number | null | undefined) => `REQ-${String(n ?? 0).padStart(4, '0')}`

export function registerAutomationTools(server: McpServer, admin: Admin) {
  // ── Daily snapshot ───────────────────────────────────────────────────────

  server.registerTool('business_snapshot', {
    title: 'Business snapshot',
    description: 'One call for "how are we today": open and overdue requests, tasks by status, outstanding invoices, cash in and out this month, and posts due in the next 7 days that are not yet sent to Requests. Start a morning brief or any status question here.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const s = await businessSnapshot(admin, todayISO())
    const text = `Today ${s.today}: ${s.requests.open} open requests (${s.requests.overdue} overdue), ${s.invoices.open} open invoices with ${inr(s.invoices.outstanding_inr)} outstanding (${s.invoices.overdue} overdue), cash this month in ${inr(s.cash_this_month.inflow_inr)} / out ${inr(s.cash_this_month.outflow_inr)}, ${s.posts_next_7_days.total} posts in the next 7 days (${s.posts_next_7_days.not_sent_to_requests} not sent to Requests).`
    return result(text, s)
  })

  // ── Client Card and prompts ──────────────────────────────────────────────

  server.registerTool('get_client_card', {
    title: 'Read a Client Card',
    description: 'The client\'s Prompt Studio card: brand, business, location, audience, language, colours and colour rule, logo, feed style, existing designs, platforms, goal and more. Read it before writing anything for a client, so the work is in their voice and look. Also lists the empty fields and what each field accepts.',
    inputSchema: { client: clientArg },
    annotations: { readOnlyHint: true },
  }, async ({ client }) => {
    const c = await resolveClient(admin, client)
    if (!c) return fail(`No client matches "${client}".`)
    const r = await readCard(admin, c.id)
    if (!r.ok) return fail(r.error)
    const d = describeCard(r.card)
    const text = d.text ? `${c.name}\n${d.text}\n\nEmpty: ${d.empty.join(', ') || 'none'}.` : `${c.name} has no Client Card yet. Empty: every field.`
    return result(text, { client: c.name, client_id: c.id, card: r.card, card_text: d.text, empty_fields: d.empty, updated_at: r.updated_at, fields: cardSchema() })
  })

  server.registerTool('update_client_card', {
    title: 'Fill or correct a Client Card',
    description: 'Write fields on a client\'s card. Give values by field key or label (see get_client_card). Choices are matched to the field\'s allowed options; anything that does not fit is refused and listed, never stored. Empty values never wipe a field; list a field in `clear` to empty it. Only write what you found on the client\'s own pages or what the person told you: never guess phone numbers, prices or addresses.',
    inputSchema: {
      client: clientArg,
      values: z.record(z.string(), z.string()).describe('{"Brand colors": "Red #FE0000, white", "feedStyle": "Mixed", ...}'),
      clear: z.array(z.string()).max(30).optional().describe('Fields to empty.'),
    },
    annotations: write,
  }, async ({ client, values, clear }) => {
    const c = await resolveClient(admin, client)
    if (!c) return fail(`No client matches "${client}". Nothing was saved.`)
    const r = await readCard(admin, c.id)
    if (!r.ok) return fail(r.error)
    const m = mergeCard(r.card, values, clear)
    if (!m.changed.length) return fail(`Nothing changed on ${c.name}'s card.${m.refused.length ? ` Refused: ${m.refused.map(x => `${x.field} (${x.reason})`).join('; ')}.` : ''}`)
    if (!(m.card.brand || '').trim()) m.card.brand = c.name
    const saved = await saveCard(admin, c.id, m.card)
    if (!saved.ok) return fail(saved.error)
    return result(`${c.name}: updated ${m.changed.join(', ')}.${m.refused.length ? ` Refused: ${m.refused.map(x => `${x.field} (${x.reason})`).join('; ')}.` : ''}`,
      { client: c.name, changed: m.changed, refused: m.refused, card_text: describeCard(m.card).text })
  })

  server.registerTool('client_card_research_prompt', {
    title: 'Client Card research brief',
    description: 'The master prompt the app uses to research a client from their Instagram, Facebook and website and fill every card field (or, with style_only, to study how their existing posts look and perform). Use it as your own checklist when you can browse, then save with update_client_card.',
    inputSchema: {
      client: clientArg,
      links: z.string().optional().describe('Page links; defaults to the card\'s Page links.'),
      style_only: z.boolean().default(false),
    },
    annotations: { readOnlyHint: true },
  }, async ({ client, links, style_only }) => {
    const c = await resolveClient(admin, client)
    if (!c) return fail(`No client matches "${client}".`)
    const r = await readCard(admin, c.id)
    if (!r.ok) return fail(r.error)
    const o = { name: c.name, links: links || r.card.links || '', card: r.card }
    const prompt = style_only ? styleStudyPrompt(o) : cardFillPrompt(o)
    return result(prompt, { client: c.name, prompt })
  })

  server.registerTool('list_prompt_templates', {
    title: 'List Prompt Studio templates',
    description: 'The agency\'s prompt templates (built-in and the team\'s own): offer flyers, social media (trends, monthly calendar, ideas, poster/reel brief), ad videos, films, product shoots, agency work and fixes. Each lists its fields so you can call build_prompt.',
    inputSchema: {
      category: z.string().optional().describe('flyer, social, ad, film, product, agency, fix'),
      query: z.string().optional().describe('Words in the name or purpose.'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ category, query }) => {
    let all = await allTemplates(admin)
    if (category) all = all.filter(t => t.category === category)
    if (query) { const q = query.toLowerCase(); all = all.filter(t => `${t.name} ${t.purpose}`.toLowerCase().includes(q)) }
    return result(`${all.length} templates: ${all.map(t => `${t.key} (${t.name})`).join(', ')}`, { templates: all.map(templateSummary) })
  })

  server.registerTool('build_prompt', {
    title: 'Build a prompt from a template',
    description: 'Fill a Prompt Studio template with the client\'s card and your field values, exactly as the app\'s Create tab does. Returns the finished prompt: follow it yourself, or hand it to an image or video tool. Templates marked needs_web_search expect today\'s facts.',
    inputSchema: {
      template: z.string().min(1).describe('Template key from list_prompt_templates, e.g. social-calendar-month.'),
      client: z.string().optional().describe('Client name (fuzzy) or id; adds their card.'),
      values: z.record(z.string(), z.string()).default({}).describe('Field key → value.'),
      language: z.string().optional().describe('Override the card\'s language for this prompt.'),
      color_use: z.string().optional().describe('Override the card\'s colour rule for this prompt.'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ template, client, values, language, color_use }) => {
    const t = (await allTemplates(admin)).find(x => x.key === template)
    if (!t) return fail(`No template "${template}". Call list_prompt_templates.`)
    let card = null
    let clientName: string | null = null
    if (client) {
      const c = await resolveClient(admin, client)
      if (!c) return fail(`No client matches "${client}".`)
      const r = await readCard(admin, c.id)
      if (!r.ok) return fail(r.error)
      card = r.card; clientName = c.name
    }
    const b = buildPrompt(t, values, card, { language, colorUse: color_use })
    if (!b.ok) return fail(b.error)
    return result(b.prompt, { template: t.key, client: clientName, needs_web_search: !!t.web, prompt: b.prompt })
  })

  server.registerTool('save_to_prompt_library', {
    title: 'Save to the prompt library',
    description: 'Keep a prompt and the result it produced in the client\'s Prompt Studio library, so the team can reuse it.',
    inputSchema: {
      template: z.string().min(1).describe('Template key the prompt came from.'),
      prompt: z.string().min(1),
      ai_result: z.string().optional(),
      client: z.string().optional(),
      title: z.string().optional(),
    },
    annotations: write,
  }, async ({ template, prompt, ai_result, client, title }) => {
    const t = (await allTemplates(admin)).find(x => x.key === template)
    let clientId: string | null = null
    if (client) {
      const c = await resolveClient(admin, client)
      if (!c) return fail(`No client matches "${client}". Nothing was saved.`)
      clientId = c.id
    }
    const { data, error } = await admin.from('prompt_library').insert({
      client_id: clientId, template_key: template, template_name: t?.name || template,
      title: (title || '').trim() || null, inputs: {}, prompt: prompt.slice(0, 40000), ai_result: (ai_result || '').slice(0, 40000) || null,
    }).select('id').single()
    if (error) return fail(error.message)
    return result(`Saved to the prompt library${t ? ` (${t.name})` : ''}.`, { id: (data as any).id })
  })

  server.registerTool('list_prompt_library', {
    title: 'Read the prompt library',
    description: 'Prompts and AI results the team saved, newest first, optionally for one client.',
    inputSchema: { client: z.string().optional(), limit: limitSchema },
    annotations: { readOnlyHint: true },
  }, async ({ client, limit }) => {
    let q = admin.from('prompt_library').select('id, template_key, template_name, title, prompt, ai_result, is_favorite, created_at, client:clients(name)')
      .is('deleted_at', null).order('created_at', { ascending: false }).limit(limit)
    if (client) {
      const c = await resolveClient(admin, client)
      if (!c) return fail(`No client matches "${client}".`)
      q = q.eq('client_id', c.id)
    }
    const { data, error } = await q
    if (error) return fail(error.message)
    const rows = ((data || []) as any[]).map(r => ({ ...r, client: r.client?.name ?? null }))
    return result(`${rows.length} saved prompts.`, { items: rows })
  })

  // ── Social Calendar: edit, remove, send ──────────────────────────────────

  server.registerTool('upcoming_posts', {
    title: 'Posts coming up',
    description: 'Planned posts across clients (or one client) for the next N days, with whether each is already in Requests. Use it to find posts that still need sending to the design team.',
    inputSchema: {
      days: z.number().int().min(1).max(62).default(7),
      client: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ days, client }) => {
    let clientId: string | null = null
    if (client) {
      const c = await resolveClient(admin, client)
      if (!c) return fail(`No client matches "${client}".`)
      clientId = c.id
    }
    const from = todayISO()
    const r = await upcomingPosts(admin, { from, to: addDays(from, days), clientId })
    if (!r.ok) return fail(r.error)
    const waiting = r.items.filter(i => i.needs_sending).length
    return result(`${r.items.length} posts from ${from} over ${days} days; ${waiting} not sent to Requests yet.`, { from, days, items: r.items })
  })

  server.registerTool('update_social_plan_item', {
    title: 'Edit a planned post',
    description: 'Change a planned post in the Social Calendar: title, date (null moves it to the Idea Board), format, platforms, caption, notes for the designer (the AI prompt lives there), links or reference images. Only the fields you give change. Posts already in Requests or Tasks are refused: those change in the app. Get item ids from list_social_plan.',
    inputSchema: {
      item_id: uuid,
      title: z.string().min(1).optional(),
      date: isoDate.nullable().optional(),
      content_type: z.enum(CONTENT_TYPES).optional(),
      platforms: z.array(z.enum(PLATFORMS)).optional(),
      caption: z.string().nullable().optional().describe('Plain text; replaces the caption.'),
      notes: z.string().nullable().optional().describe('Replaces all notes for the designer: send the whole text.'),
      asap: z.boolean().optional(),
      links: z.array(z.object({ label: z.string().default(''), url: z.string() })).max(10).optional(),
      images: z.array(z.string()).max(8).optional().describe('Direct image links; replaces the reference images.'),
    },
    annotations: write,
  }, async ({ item_id, ...patch }) => {
    const r = await updatePlanItem(admin, item_id, patch)
    if (!r.ok) return fail(r.error)
    return result(`Updated "${r.title}": ${r.changed.join(', ')}.${r.not_saved.length ? ` Not saved (the database is missing ${r.not_saved.join(', ')}).` : ''}`, r)
  })

  server.registerTool('remove_social_plan_items', {
    title: 'Remove planned posts',
    description: 'Delete planned posts no work has started on. Posts already in Requests or Tasks are never removed; they are listed back. Cannot be undone, so remove only what the person asked to remove.',
    inputSchema: { item_ids: z.array(uuid).min(1).max(80) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, async ({ item_ids }) => {
    const r = await removePlanItems(admin, item_ids)
    if (!r.ok) return fail(r.error)
    const kept = r.kept.length ? ` Kept ${r.kept.length}: ${r.kept.map(k => `"${k.title}" (${k.reason})`).join('; ')}.` : ''
    return result(`Removed ${r.removed.length} planned post${r.removed.length === 1 ? '' : 's'}.${kept}${r.unknown.length ? ` ${r.unknown.length} ids not found.` : ''}`, r)
  })

  server.registerTool('send_social_items_to_requests', {
    title: 'Send planned posts to Requests',
    description: `Send planned posts to the Requests inbox for the design team, exactly like the calendar's "Send to Requests": one request per post with its full brief, the designer's deadline (post date minus the team's lead time) and its service. Posts already sent are skipped. Up to ${MAX_SEND_PER_CALL} a call.`,
    inputSchema: { item_ids: z.array(uuid).min(1).max(MAX_SEND_PER_CALL) },
    annotations: write,
  }, async ({ item_ids }) => {
    const r = await sendPlanItemsToRequests(admin, item_ids)
    if (!r.ok) return fail(r.error)
    const skipped = r.skipped.length ? ` Skipped ${r.skipped.length}: ${r.skipped.map(s => `"${s.title}" (${s.reason})`).join('; ')}.` : ''
    return result(`Sent ${r.sent.length} post${r.sent.length === 1 ? '' : 's'} to Requests: ${r.sent.map(s => `${s.ref} ${s.title}`).join('; ') || 'none'}.${skipped}`, r)
  })

  // ── Requests, tasks, billing ─────────────────────────────────────────────

  server.registerTool('get_request', {
    title: 'Get a request',
    description: 'One request in full by its reference (REQ-0058 or 58): status, client, service, due date, who it is assigned to, the content brief (caption, notes, reference images, links) and the task it became.',
    inputSchema: { ref: z.union([z.string(), z.number()]) },
    annotations: { readOnlyHint: true },
  }, async ({ ref }) => {
    const n = parseInt(String(ref).replace(/^REQ-?/i, '').replace(/^#/, ''), 10)
    if (isNaN(n)) return fail('Give the reference like REQ-0058.')
    const { data, error } = await admin.from('task_requests')
      .select('id, ref_no, title, status, client_status, priority, due_date, description, content_brief, extra_links, is_planned, created_at, client:clients(name), service:services!task_requests_service_id_fkey(name), assigned_employee:employees!task_requests_assigned_employee_id_fkey(name), promoted_task:tasks!task_requests_promoted_task_id_fkey(task_number, title, status)')
      .eq('ref_no', n).maybeSingle()
    if (error) return fail(error.message)
    if (!data) return fail(`${refOf(n)} not found.`)
    const d = data as any
    const out = { ...d, ref: refOf(d.ref_no), client: d.client?.name ?? null, service: d.service?.name ?? null, assigned_to: d.assigned_employee?.name ?? null, assigned_employee: undefined }
    return result(`${out.ref} ${d.title} — ${out.client ?? '—'} — ${d.status}${d.due_date ? `, due ${d.due_date}` : ''}${d.promoted_task ? `, task #${d.promoted_task.task_number} (${d.promoted_task.status})` : ''}.`, { request: out })
  })

  server.registerTool('set_task_status', {
    title: 'Move a task',
    description: `Change a task's status (${SETTABLE_TASK_STATUSES.join(', ')}). Runs the same follow-ups as the Tasks page: draft invoices, derived billing, reports and any linked request. Invoiced and paid come only from invoicing.`,
    inputSchema: {
      task_number: z.union([z.number().int(), z.string()]),
      status: z.enum(SETTABLE_TASK_STATUSES),
    },
    annotations: write,
  }, async ({ task_number, status }) => {
    const r = await setTaskStatus(admin, task_number, status)
    if (!r.ok) return fail(r.error)
    return result(`#${r.task_number} ${r.title}: ${r.from} → ${r.to}.`, r)
  })

  server.registerTool('list_unbilled_work', {
    title: 'Finished work not yet billed',
    description: 'Delivered or done billable tasks that are on no invoice yet, with the total. Work covered by a package is listed separately (it is billed through the package fee).',
    inputSchema: { client: z.string().optional(), from: isoDate.optional(), to: isoDate.optional() },
    annotations: { readOnlyHint: true },
  }, async ({ client, from, to }) => {
    let clientId: string | null = null
    if (client) {
      const c = await resolveClient(admin, client)
      if (!c) return fail(`No client matches "${client}".`)
      clientId = c.id
    }
    const r = await unbilledTasks(admin, { clientId, from, to })
    if (!r.ok) return fail(r.error)
    return result(`${r.unbilled.length} finished tasks not on an invoice, ${inr(r.total_inr)}; ${r.package_work.length} more covered by packages.`, r)
  })

  // ── Leads and quotations ─────────────────────────────────────────────────

  server.registerTool('list_leads', {
    title: 'List leads',
    description: 'Leads collected for clients (Meta lead ads, website, WhatsApp, manual), newest first, with status and contact details.',
    inputSchema: {
      client: z.string().optional(),
      status: z.enum(LEAD_STATUSES).optional(),
      limit: limitSchema,
    },
    annotations: { readOnlyHint: true },
  }, async ({ client, status, limit }) => {
    let q = admin.from('leads').select('id, status, full_name, phone, email, source, campaign_name, form_name, notes, submitted_at, created_at, client:clients(name)')
      .order('created_at', { ascending: false }).limit(limit)
    if (client) {
      const c = await resolveClient(admin, client)
      if (!c) return fail(`No client matches "${client}".`)
      q = q.eq('client_id', c.id)
    }
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) return fail(error.message)
    const rows = ((data || []) as any[]).map(r => ({ ...r, client: r.client?.name ?? null }))
    return result(`${rows.length} leads.`, { leads: rows })
  })

  server.registerTool('update_lead', {
    title: 'Update a lead',
    description: `Set a lead's status (${LEAD_STATUSES.join(', ')}) and/or add a dated note. Notes are appended, never replaced.`,
    inputSchema: { lead_id: uuid, status: z.enum(LEAD_STATUSES).optional(), note: z.string().optional() },
    annotations: write,
  }, async ({ lead_id, status, note }) => {
    const r = await updateLead(admin, lead_id, { status, note })
    if (!r.ok) return fail(r.error)
    return result(`Lead ${r.name ?? r.id}: ${r.status}${note ? ', note added' : ''}.`, r)
  })

  server.registerTool('list_quotations', {
    title: 'List quotations',
    description: 'Quotations sent or drafted for clients, newest first, with totals and status.',
    inputSchema: { client: z.string().optional(), status: z.string().optional(), limit: limitSchema },
    annotations: { readOnlyHint: true },
  }, async ({ client, status, limit }) => {
    let q = admin.from('quotations').select('id, quotation_number, status, issue_date, valid_until, currency, total_amount, notes, client:clients(name)')
      .order('issue_date', { ascending: false }).limit(limit)
    if (client) {
      const c = await resolveClient(admin, client)
      if (!c) return fail(`No client matches "${client}".`)
      q = q.eq('client_id', c.id)
    }
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) return fail(error.message)
    const rows = ((data || []) as any[]).map(r => ({ ...r, client: r.client?.name ?? null }))
    return result(`${rows.length} quotations.`, { quotations: rows })
  })

  // ── Workflow prompts (shown as ready-made commands in AI apps) ───────────

  const say = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] })

  server.registerPrompt('morning_brief', {
    title: 'Morning brief',
    description: 'Today at Cirqle: what is late, what is due, what to send to the designers, what to chase.',
  }, () => say(`Give me today's Cirqle morning brief.
1. Call business_snapshot.
2. Call list_requests and pick out anything overdue or waiting for content.
3. Call upcoming_posts for 7 days and list the posts not yet sent to Requests, by client.
4. Call list_invoices with outstanding_only and name the three biggest amounts due.
5. Call list_unbilled_work for this month.
Then write a short brief in plain words: first what needs action today, then what can wait. Do not change anything; ask me before sending posts to Requests.`))

  server.registerPrompt('plan_social_month', {
    title: 'Plan a client\'s month',
    description: 'A full social media month for one client, with a brief per post, added to the Social Calendar after you approve it.',
    argsSchema: { client: z.string().describe('Client name'), month: z.string().describe('YYYY-MM') },
  }, ({ client, month }) => say(`Plan ${client}'s social media for ${month}.
1. Call get_client_card for ${client}; if Feed style or Existing designs is empty, say so first.
2. Call list_social_plan for ${month} so nothing is planned twice.
3. Call build_prompt with template social-calendar-month, client ${client} and month ${month}, and follow that prompt yourself, searching the web for this year's dates.
4. Show me the plan as a short table first. After I approve, call add_social_plan_items with every post (caption = hook + text on design + caption + hashtags; notes = goal, visual direction, designer needs, AI prompt, reel script; links = real references you opened).`))

  server.registerPrompt('fill_client_card', {
    title: 'Fill a Client Card from their pages',
    description: 'Research a client from their Instagram, Facebook and website and fill their Client Card.',
    argsSchema: { client: z.string().describe('Client name'), links: z.string().optional().describe('Page links') },
  }, ({ client, links }) => say(`Fill ${client}'s Client Card.
1. Call client_card_research_prompt for ${client}${links ? ` with links ${links}` : ''} and follow it as your checklist: open their pages and read the last 15 posts.
2. Show me what you found, field by field, marking anything unsure with (check).
3. After I approve, save it with update_client_card. Never invent phone numbers, prices or addresses.`))

  server.registerPrompt('trend_check', {
    title: 'Today\'s trends for a client',
    description: 'What is trending today near a client, turned into post ideas, saved to the Idea Board after approval.',
    argsSchema: { client: z.string().describe('Client name') },
  }, ({ client }) => say(`Find today's trends for ${client}.
1. Call get_client_card for ${client}.
2. Call build_prompt with template social-trends-today for ${client} and follow it, searching the web; every trend needs a real source link.
3. Show me the table. Add only the ones I pick with add_social_plan_items for this month, undated, asap true, the source link in links.`))
}

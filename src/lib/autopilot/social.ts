/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Social autopilot jobs, run each morning by /api/cron/autopilot:
 *
 * 1. sendDuePosts: posts in Active plans whose designer deadline has come go
 *    to Requests, exactly like the calendar's "Send to Requests".
 * 2. draftNextMonth: the app's AI (Groq) writes next month's plan for one
 *    working social client a day, as a Draft plan for a person to review.
 *
 * Both are idempotent: a post can only be sent once (atomic claim), and a
 * client's month is drafted only while it is still blank.
 */
import type { Admin } from '@/lib/mcp/shared'
import { leadDays, sendPlanItemsToRequests, MAX_SEND_PER_CALL } from '@/lib/mcp/social-actions'
import { buildPrompt, readCard } from '@/lib/mcp/content-actions'
import { templateByKey } from '@/lib/prompt-studio/templates'
import { callGroqText } from '@/lib/ai/groq'
import { parsePlan } from '@/lib/social/plan-import'
import { addSocialPlanItems, cleanPlanItem } from '@/lib/social/plan-mcp'
import type { PlanItemInput } from '@/lib/social/plan-mcp'
import { notifyAdmins } from '@/lib/notifications/create'
import {
  addDays, answerBudget, automatedRunNote, draftsDue, estimateTokens, monthHalves, monthLabel,
  monthStart, nextMonthStart, pickDraftCandidates, pickDuePosts, type DraftCandidateRow, type PlanItemRow,
} from './social-rules'

const ACTOR = 'Autopilot'

// ── 1. Send due posts ────────────────────────────────────────────────────────

export async function sendDuePosts(admin: Admin, today: string) {
  const lead = await leadDays(admin)
  const horizon = addDays(today, Math.max(0, Math.round(lead)) + 1)
  const { data: cals, error: calErr } = await admin.from('social_calendars')
    .select('id, client_id, client:clients(name)')
    .eq('status', 'active').gte('month', monthStart(today)).lte('month', monthStart(horizon))
  if (calErr) return { ok: false as const, error: `plans: ${calErr.message}` }
  const calById = new Map(((cals || []) as any[]).map(c => [c.id as string, c]))
  if (!calById.size) return { ok: true as const, sent: [], skipped: [], emptyTrendSlots: [] }

  const { data: rows, error: itemErr } = await admin.from('social_calendar_items')
    .select('id, calendar_id, scheduled_date, title, status, request_id')
    .in('calendar_id', [...calById.keys()]).gte('scheduled_date', today).lte('scheduled_date', horizon)
    .eq('status', 'planned').is('request_id', null)
  if (itemErr) return { ok: false as const, error: `posts: ${itemErr.message}` }

  const { due, emptyTrendSlots } = pickDuePosts((rows || []) as PlanItemRow[], new Set(calById.keys()), lead, today)
  const clientOf = (calId: string) => (calById.get(calId) as any)?.client?.name || 'client'
  const sent: { id: string; title: string; ref: string; client: string }[] = []
  const skipped: { id: string; title: string; reason: string }[] = []
  for (let i = 0; i < due.length; i += MAX_SEND_PER_CALL) {
    const batch = due.slice(i, i + MAX_SEND_PER_CALL)
    const r = await sendPlanItemsToRequests(admin, batch.map(b => b.id), { actorLabel: ACTOR })
    if (!r.ok) { skipped.push(...batch.map(b => ({ id: b.id, title: b.title || '', reason: r.error }))); continue }
    const calOf = new Map(batch.map(b => [b.id, b.calendar_id]))
    sent.push(...r.sent.map(s => ({ ...s, client: clientOf(calOf.get(s.id) || '') })))
    skipped.push(...r.skipped)
  }

  if (sent.length) {
    const list = sent.slice(0, 6).map(s => `${s.client}: ${s.title} (${s.ref})`).join(' · ')
    await notifyAdmins({
      type: 'autopilot_posts_sent',
      title: `Autopilot sent ${sent.length} planned post${sent.length === 1 ? '' : 's'} to designers`,
      message: sent.length > 6 ? `${list} · and ${sent.length - 6} more` : list,
      link: '/dashboard/requests',
      sourceKey: `autopilot_sent:${today}`,
    })
  }
  if (emptyTrendSlots.length) {
    const first = emptyTrendSlots[0]
    await notifyAdmins({
      type: 'autopilot_trend_slots',
      title: `${emptyTrendSlots.length} trend slot${emptyTrendSlots.length === 1 ? ' is' : 's are'} due for designers but still empty`,
      message: emptyTrendSlots.slice(0, 6).map(t => `${clientOf(t.calendar_id)} ${t.scheduled_date}`).join(' · ') +
        '. Fill each with today’s trend idea (Prompt Studio or the AI connector); the autopilot sends it the next morning.',
      link: `/dashboard/social-calendar?calendar=${first.calendar_id}`,
      sourceKey: `autopilot_trend_slots:${today}`,
    })
  }
  return { ok: true as const, sent, skipped, emptyTrendSlots: emptyTrendSlots.map(t => t.id) }
}

// ── 2. AI drafts for next month ─────────────────────────────────────────────

async function draftCandidates(admin: Admin, today: string, onlyClientId?: string) {
  const thisMonth = monthStart(today)
  const next = nextMonthStart(today)
  let calQ = admin.from('social_calendars').select('id, client_id, client:clients(name)').eq('month', thisMonth).eq('status', 'active')
  if (onlyClientId) calQ = calQ.eq('client_id', onlyClientId)
  const { data: cals, error } = await calQ
  if (error) return { ok: false as const, error: `plans: ${error.message}` }
  const current = (cals || []) as any[]
  if (!current.length) return { ok: true as const, rows: [] as DraftCandidateRow[] }
  const clientIds = [...new Set(current.map(c => c.client_id as string))]

  const [itemsRes, cardsRes, nextRes, notesRes] = await Promise.all([
    admin.from('social_calendar_items').select('calendar_id').in('calendar_id', current.map(c => c.id)).neq('status', 'cancelled'),
    admin.from('prompt_client_cards').select('client_id').in('client_id', clientIds),
    admin.from('social_calendars').select('id, client_id, status').eq('month', next).in('client_id', clientIds),
    admin.from('notifications').select('source_key, created_at').like('source_key', `autopilot_draft%:${next}%`),
  ])
  for (const r of [itemsRes, cardsRes, nextRes, notesRes]) if (r.error) return { ok: false as const, error: r.error.message }

  const nextPlans = (nextRes.data || []) as any[]
  const nextCounts = new Map<string, number>()
  if (nextPlans.length) {
    const { data, error: e2 } = await admin.from('social_calendar_items').select('calendar_id')
      .in('calendar_id', nextPlans.map(p => p.id)).neq('status', 'cancelled')
    if (e2) return { ok: false as const, error: e2.message }
    for (const r of (data || []) as any[]) nextCounts.set(r.calendar_id, (nextCounts.get(r.calendar_id) || 0) + 1)
  }
  const thisCounts = new Map<string, number>()
  const calClient = new Map(current.map(c => [c.id as string, c.client_id as string]))
  for (const r of (itemsRes.data || []) as any[]) {
    const cid = calClient.get(r.calendar_id)
    if (cid) thisCounts.set(cid, (thisCounts.get(cid) || 0) + 1)
  }
  const withCard = new Set(((cardsRes.data || []) as any[]).map(r => r.client_id as string))
  const keys = ((notesRes.data || []) as any[]).map(n => String(n.source_key || ''))

  const rows: DraftCandidateRow[] = clientIds.map(clientId => {
    const plan = nextPlans.find(p => p.client_id === clientId)
    const failures = new Set(keys.filter(k => k.startsWith(`autopilot_draft_failed:${clientId}:${next}:`)).map(k => k.split(':').pop()))
    return {
      clientId,
      name: (current.find(c => c.client_id === clientId) as any)?.client?.name || 'Client',
      hasCard: withCard.has(clientId),
      thisMonthItems: thisCounts.get(clientId) || 0,
      nextPlan: plan ? { status: plan.status, items: nextCounts.get(plan.id) || 0 } : null,
      drafted: keys.some(k => k === `autopilot_draft:${clientId}:${next}`),
      failedAttempts: failures.size,
      triedToday: failures.has(today),
    }
  })
  return { ok: true as const, rows }
}

/** The app's AI writes one client's next month as a Draft plan. */
export async function generateMonthDraft(admin: Admin, p: { clientId: string; clientName: string; month: string; pauseMs?: number }) {
  const template = templateByKey('social-calendar-month')
  if (!template) return { ok: false as const, error: 'The monthly calendar template is missing.' }
  const card = await readCard(admin, p.clientId)
  if (!card.ok) return { ok: false as const, error: card.error }
  const built = buildPrompt(template, {
    month: monthLabel(p.month), mode: 'Regular', feed: 'As the card says', detail: 'Full brief for every post',
  }, card.card)
  if (!built.ok) return { ok: false as const, error: built.error }

  // What this client already posts this month, so the draft does not repeat it.
  const prevMonth = monthStart(addDays(p.month, -1))
  const { data: prevCal } = await admin.from('social_calendars').select('id').eq('client_id', p.clientId).eq('month', prevMonth).maybeSingle()
  let already: string[] = []
  if ((prevCal as any)?.id) {
    const { data } = await admin.from('social_calendar_items').select('title').eq('calendar_id', (prevCal as any).id).neq('status', 'cancelled').limit(40)
    already = ((data || []) as any[]).map(r => String(r.title || '').trim()).filter(t => t && !/trend\s*slot/i.test(t))
  }

  const system = 'You are the content planner at a digital agency. Follow the instructions exactly and output only what they ask for.'
  const items: PlanItemInput[] = []
  const skipped: string[] = []
  const halves = monthHalves(p.month)
  for (let i = 0; i < halves.length; i++) {
    const userText = `${built.prompt}\n\n${automatedRunNote(halves[i], p.month, already)}`
    const budget = answerBudget(estimateTokens(system + userText))
    // The free plan counts tokens per minute: let the window clear between halves.
    if (i > 0) await new Promise(r => setTimeout(r, p.pauseMs ?? 62_000))
    let text = ''
    try {
      text = await callGroqText(system, userText, { maxTokens: budget, temperature: 0.7, reasoningEffort: 'low' })
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
    const parsed = parsePlan(text, p.month)
    for (const it of parsed.items) {
      const ok = cleanPlanItem(it, p.month)
      if (ok.ok) items.push(it); else skipped.push(ok.error)
    }
    skipped.push(...parsed.skipped.map(s => s.reason))
  }
  if (items.length < 4) {
    return { ok: false as const, error: `The AI answer had only ${items.length} usable post${items.length === 1 ? '' : 's'}${skipped.length ? ` (${skipped.slice(0, 2).join('; ')})` : ''}.` }
  }

  // A Draft plan: nothing in it goes to designers until a person marks it Active.
  const title = `${monthLabel(p.month)} plan (AI draft)`
  const existing = await admin.from('social_calendars').select('id, status').eq('client_id', p.clientId).eq('month', p.month).maybeSingle()
  if (existing.error) return { ok: false as const, error: existing.error.message }
  if (existing.data && (existing.data as any).status !== 'draft') {
    return { ok: false as const, error: 'Someone opened next month’s plan meanwhile; the draft was not saved.' }
  }
  if (!existing.data) {
    const ins = await admin.from('social_calendars').insert({ client_id: p.clientId, month: p.month, title, status: 'draft' }).select('id').single()
    if (ins.error && ins.error.code !== '23505') return { ok: false as const, error: ins.error.message }
  }
  const saved = await addSocialPlanItems(admin, { clientId: p.clientId, month: p.month, items })
  if (!saved.ok) return { ok: false as const, error: saved.error }
  return { ok: true as const, calendarId: saved.calendarId, added: saved.added, skipped: skipped.length }
}

/**
 * Draft next month for the next client in line (one a run: the free AI plan
 * allows about one month of detailed briefs per minute and 200k tokens a day).
 */
export async function draftNextMonth(admin: Admin, today: string, opts: { force?: boolean; clientId?: string } = {}) {
  if (!opts.force && !draftsDue(today)) return { ok: true as const, skipped: `drafts start on the 10th` }
  const cands = await draftCandidates(admin, today, opts.clientId)
  if (!cands.ok) return cands
  const next = pickDraftCandidates(cands.rows)[0]
  if (!next) return { ok: true as const, skipped: 'no client waiting for a draft' }
  const month = nextMonthStart(today)
  const r = await generateMonthDraft(admin, { clientId: next.clientId, clientName: next.name, month })
  if (!r.ok) {
    await notifyAdmins({
      type: 'autopilot_draft_failed',
      title: `AI draft failed: ${next.name}, ${monthLabel(month)}`,
      message: `${r.error} ${next.failedAttempts + 1 < 3 ? 'The autopilot tries again tomorrow.' : 'It will not try again this month; plan it with Prompt Studio or the AI connector.'}`,
      link: '/dashboard/social-calendar',
      sourceKey: `autopilot_draft_failed:${next.clientId}:${month}:${today}`,
    })
    return { ok: false as const, error: `${next.name}: ${r.error}` }
  }
  await notifyAdmins({
    type: 'autopilot_draft_ready',
    title: `AI draft ready: ${next.name}, ${monthLabel(month)} (${r.added} posts)`,
    message: 'Review it, fix what needs fixing, then mark the plan Active. Active plans go to designers by themselves at lead time.',
    link: `/dashboard/social-calendar?calendar=${r.calendarId}`,
    sourceKey: `autopilot_draft:${next.clientId}:${month}`,
  })
  return { ok: true as const, drafted: { client: next.name, month, posts: r.added, calendarId: r.calendarId } }
}

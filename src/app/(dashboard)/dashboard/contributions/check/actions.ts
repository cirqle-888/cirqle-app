'use server'

/**
 * Contribution checks — send a filtered list of jobs to one person, collect
 * their "Correct" / "I worked on this" answers, send them back. Rules in
 * lib/contributions/check.ts; table in 20261111100000_contribution_checks.sql.
 *
 * Nothing here writes contributions, scores or payroll. A "worked" answer is a
 * flag for the sender, who fixes the split on the Contributions page.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAnyPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { createNotification } from '@/lib/notifications/create'
import {
  normalizeCheckTaskIds, summarizeCheck, checkAccess, answersMessage, cleanText,
  MAX_CHECK_NOTE, MAX_CHECK_COMMENT, type CheckAnswer, type CheckStatus,
} from '@/lib/contributions/check'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

/** Anyone who can reach the Contributions page at all. */
const ANY_CONTRIB = [PERMS.CONTRIBUTIONS_VIEW_OWN, PERMS.CONTRIBUTIONS_VIEW_UNIT, PERMS.CONTRIBUTIONS_VIEW_ALL] as const

const NOT_READY = 'Contribution checks need the 20261111100000_contribution_checks.sql migration. Run it in the Supabase SQL editor.'
const missingTable = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === '42P01' || e.code === 'PGRST205' || /contribution_check/.test(e.message ?? '') && /does not exist|schema cache/.test(e.message ?? ''))

const checkLink = (id: string) => `/dashboard/contributions/check/${id}`

async function cqidOf(db: ReturnType<typeof createAdminClient>, id: string): Promise<string> {
  const { data } = await db.from('employees').select('cqid').eq('id', id).maybeSingle()
  return (data as { cqid?: string } | null)?.cqid || 'Someone'
}

// ─── Send ─────────────────────────────────────────────────────────────────────

export async function createContributionCheck(input: {
  employeeId: string
  taskIds: string[]
  note?: string | null
  viewHref?: string | null
}): Promise<ActionResult<{ id: string; link: string; jobs: number; dropped: number }>> {
  // Only someone who can see everyone's credit can ask about it.
  const g = await requireAnyPermission([PERMS.CONTRIBUTIONS_VIEW_ALL])
  if (!g.ok) return { ok: false, error: g.error }

  const { ids, dropped } = normalizeCheckTaskIds(input.taskIds ?? [])
  if (ids.length === 0) return { ok: false, error: 'No jobs in the list to check.' }
  if (input.employeeId === g.employeeId) return { ok: false, error: 'Pick someone other than yourself.' }

  const db = createAdminClient()
  const { data: emp } = await db.from('employees').select('id, is_active').eq('id', input.employeeId).maybeSingle()
  if (!emp || !(emp as { is_active?: boolean }).is_active) return { ok: false, error: 'That person is not an active employee.' }

  const href = cleanText(input.viewHref, 2000)
  const { data: check, error } = await db.from('contribution_checks').insert({
    employee_id: input.employeeId,
    requested_by: g.employeeId,
    note: cleanText(input.note, MAX_CHECK_NOTE),
    // Only an in-app path; never an outside URL.
    view_href: href && href.startsWith('/dashboard/') ? href : null,
  }).select('id').single()
  if (error || !check) return { ok: false, error: missingTable(error) ? NOT_READY : (error?.message ?? 'Could not create the check.') }

  const checkId = (check as { id: string }).id
  const { error: itemsErr } = await db.from('contribution_check_items')
    .insert(ids.map(task_id => ({ check_id: checkId, task_id })))
  if (itemsErr) {
    await db.from('contribution_checks').delete().eq('id', checkId)
    return { ok: false, error: itemsErr.message }
  }

  const from = await cqidOf(db, g.employeeId)
  const note = cleanText(input.note, 160)
  await createNotification({
    employeeId: input.employeeId,
    type: 'contribution_check',
    title: 'Please check your contributions',
    message: `${from} sent ${ids.length} job${ids.length === 1 ? '' : 's'} to confirm.${note ? ` "${note}"` : ''}`,
    link: checkLink(checkId),
  })

  return { ok: true, data: { id: checkId, link: checkLink(checkId), jobs: ids.length, dropped } }
}

// ─── Answer ───────────────────────────────────────────────────────────────────

/** Loads a check and decides what the caller may do with it. */
async function loadForCaller(checkId: string) {
  const g = await requireAnyPermission(ANY_CONTRIB)
  if (!g.ok) return { ok: false as const, error: g.error }
  const db = createAdminClient()
  const { data, error } = await db.from('contribution_checks')
    .select('id, employee_id, requested_by, status').eq('id', checkId).maybeSingle()
  if (error) return { ok: false as const, error: missingTable(error) ? NOT_READY : error.message }
  if (!data) return { ok: false as const, error: 'This check no longer exists.' }
  const check = data as { id: string; employee_id: string; requested_by: string; status: CheckStatus }
  const access = checkAccess({ employeeId: g.employeeId, isAdmin: g.isAdmin }, check)
  if (!access) return { ok: false as const, error: 'This check was sent to someone else.' }
  return { ok: true as const, db, check, access, me: g.employeeId }
}

export async function answerCheckItem(
  checkId: string, itemId: string, answer: CheckAnswer | null, comment?: string | null,
): Promise<ActionResult> {
  if (answer !== null && answer !== 'correct' && answer !== 'worked') return { ok: false, error: 'Unknown answer.' }
  const r = await loadForCaller(checkId)
  if (!r.ok) return r
  if (r.access !== 'answer') return { ok: false, error: r.check.status === 'open' ? 'Only the person it was sent to can answer.' : 'This check is already sent back.' }

  const { error } = await r.db.from('contribution_check_items').update({
    answer,
    comment: answer === 'worked' ? cleanText(comment, MAX_CHECK_COMMENT) : null,
    answered_at: answer ? new Date().toISOString() : null,
  }).eq('id', itemId).eq('check_id', checkId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

/** "Mark the rest correct" — every unanswered job in one go. */
export async function answerRestCorrect(checkId: string): Promise<ActionResult<{ updated: number }>> {
  const r = await loadForCaller(checkId)
  if (!r.ok) return r
  if (r.access !== 'answer') return { ok: false, error: 'Only the person it was sent to can answer.' }
  const { data, error } = await r.db.from('contribution_check_items')
    .update({ answer: 'correct', comment: null, answered_at: new Date().toISOString() })
    .eq('check_id', checkId).is('answer', null).select('id')
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: { updated: (data ?? []).length } }
}

export async function sendCheckAnswers(checkId: string): Promise<ActionResult> {
  const r = await loadForCaller(checkId)
  if (!r.ok) return r
  if (r.access !== 'answer') return { ok: false, error: 'Only the person it was sent to can send it back.' }

  const { data: items, error } = await r.db.from('contribution_check_items').select('answer').eq('check_id', checkId)
  if (error) return { ok: false, error: error.message }
  const s = summarizeCheck((items ?? []) as { answer: CheckAnswer | null }[])
  if (s.pending > 0) return { ok: false, error: `${s.pending} job${s.pending === 1 ? ' is' : 's are'} still unanswered.` }

  const { error: upErr } = await r.db.from('contribution_checks')
    .update({ status: 'answered', answered_at: new Date().toISOString() })
    .eq('id', checkId).eq('status', 'open')
  if (upErr) return { ok: false, error: upErr.message }

  await createNotification({
    employeeId: r.check.requested_by,
    type: 'contribution_check_answered',
    title: `${await cqidOf(r.db, r.check.employee_id)} answered your contribution check`,
    message: answersMessage(s),
    link: checkLink(checkId),
  })
  revalidatePath(checkLink(checkId))
  return { ok: true }
}

// ─── Close ────────────────────────────────────────────────────────────────────

/** The sender is done with it — any fixes made. Re-opening sends it back. */
export async function setCheckClosed(checkId: string, closed: boolean): Promise<ActionResult> {
  const r = await loadForCaller(checkId)
  if (!r.ok) return r
  if (r.access !== 'review') return { ok: false, error: 'Only the sender can close this check.' }
  const { error } = await r.db.from('contribution_checks').update(
    closed
      ? { status: 'closed', closed_at: new Date().toISOString() }
      : { status: r.check.status === 'closed' ? 'answered' : r.check.status, closed_at: null },
  ).eq('id', checkId)
  if (error) return { ok: false, error: error.message }
  revalidatePath(checkLink(checkId))
  return { ok: true }
}

/** Withdraw a check that has not been answered — nothing is kept. */
export async function deleteCheck(checkId: string): Promise<ActionResult> {
  const r = await loadForCaller(checkId)
  if (!r.ok) return r
  if (r.access !== 'review') return { ok: false, error: 'Only the sender can withdraw this check.' }
  const { error } = await r.db.from('contribution_checks').delete().eq('id', checkId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

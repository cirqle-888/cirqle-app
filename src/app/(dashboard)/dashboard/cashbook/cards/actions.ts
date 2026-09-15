'use server'

/**
 * Credit card reconciliation — every write goes through here.
 *
 * WHAT THIS MODULE IS CAREFUL ABOUT. A reconciliation's whole value is that a
 * closed cycle is TRUE: every charge on the statement is recorded in the books
 * and nothing is recorded twice. Two rules protect that, and both live in the
 * database rather than in this file's good intentions:
 *
 *   · one entry belongs to ONE line — a unique index on
 *     card_statement_matches.cashbook_entry_id, so an expense cannot be
 *     counted against two charges and make two cycles both appear to balance;
 *   · one statement per card per cycle — UNIQUE (bank_account_id, cycle_end),
 *     so a second import of the same month is refused rather than duplicated.
 *
 * Matching itself is in src/lib/cards/match.ts and proposes only; nothing here
 * applies a proposal without a person asking for it.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission, requireReadPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import { round2 } from '@/lib/calculations/currency'
import { cycleFor, cycleLabel, type Cycle } from '@/lib/cards/cycle'
import { reconcile, type EntryCandidate, type Proposal, type StatementLine } from '@/lib/cards/match'
import type { ParsedLine } from '@/lib/cards/parse'

const REVALIDATE = '/dashboard/cashbook/cards'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

/* ── Reading a cycle ──────────────────────────────────────────────────────── */

export interface CycleEntry {
  id: string
  entryDate: string
  description: string
  /** Signed like the statement: an outflow on the card is a positive charge. */
  amount: number
  /** The line it is already matched to, or null. */
  matchedLineId: string | null
}

export interface CycleLine {
  id: string
  txnDate: string
  description: string
  amount: number
  raw: string | null
  status: 'unmatched' | 'matched' | 'ignored'
  ignoreReason: string | null
  entryIds: string[]
}

export interface CycleView {
  statementId: string | null
  cycle: Cycle
  label: string
  statementTotal: number | null
  status: 'open' | 'closed'
  lines: CycleLine[]
  entries: CycleEntry[]
}

/**
 * Everything one cycle needs, in one call.
 *
 * `entries` are the card's own cashbook rows inside the cycle. An INFLOW on a
 * card account is money coming off the balance — the bill payment, or a
 * refund — so it is negated to match the statement's sign convention, where a
 * credit is negative. Getting this backwards is how a cycle balances by
 * exactly twice a refund.
 */
export async function loadCycle(
  bankAccountId: string,
  cycleEnd: string,
): Promise<ActionResult<CycleView>> {
  // Reads only, so the READ guard: the write guard refuses during a
  // "view as" preview and would show a broken page instead of a narrower one.
  const guard = await requireReadPermission(PERMS.CARD_RECONCILIATION_VIEW)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()

  const { data: account } = await admin
    .from('bank_accounts')
    .select('id, name, type, statement_day, reconcile_from')
    .eq('id', bankAccountId)
    .maybeSingle()
  if (!account) return { ok: false, error: 'No such account.' }
  if (account.type !== 'credit_card') return { ok: false, error: 'That account is not a credit card.' }
  if (!account.statement_day) {
    return { ok: false, error: `${account.name} has no statement day set. Add one in Settings → Accounts.` }
  }

  const cycle = cycleFor(cycleEnd, account.statement_day)
  if (!cycle) return { ok: false, error: 'That is not a usable cycle date.' }

  const [statementRes, entriesRes] = await Promise.all([
    admin.from('card_statements')
      .select('id, statement_total, status')
      .eq('bank_account_id', bankAccountId)
      .eq('cycle_end', cycle.end)
      .maybeSingle(),
    admin.from('cashbook_entries')
      .select('id, entry_date, description, amount_inr, type')
      .eq('bank_account_id', bankAccountId)
      .is('deleted_at', null)
      .gte('entry_date', cycle.start)
      .lte('entry_date', cycle.end)
      .order('entry_date', { ascending: true }),
  ])

  let lines: CycleLine[] = []
  const matchedByEntry = new Map<string, string>()
  if (statementRes.data) {
    const { data: lineRows } = await admin
      .from('card_statement_lines')
      .select('id, txn_date, description, amount, raw, status, ignore_reason, display_order, card_statement_matches(cashbook_entry_id)')
      .eq('statement_id', statementRes.data.id)
      .order('display_order', { ascending: true })

    type Row = {
      id: string; txn_date: string; description: string; amount: number
      raw: string | null; status: CycleLine['status']; ignore_reason: string | null
      card_statement_matches: { cashbook_entry_id: string }[] | null
    }
    lines = ((lineRows ?? []) as Row[]).map(r => {
      const entryIds = (r.card_statement_matches ?? []).map(m => m.cashbook_entry_id)
      for (const id of entryIds) matchedByEntry.set(id, r.id)
      return {
        id: r.id,
        txnDate: r.txn_date,
        description: r.description,
        amount: Number(r.amount),
        raw: r.raw,
        status: r.status,
        ignoreReason: r.ignore_reason,
        entryIds,
      }
    })
  }

  type EntryRow = { id: string; entry_date: string; description: string | null; amount_inr: number | null; type: string }
  const entries: CycleEntry[] = ((entriesRes.data ?? []) as EntryRow[]).map(e => ({
    id: e.id,
    entryDate: e.entry_date,
    description: e.description ?? '',
    // Outflow on a card = a charge = positive, matching the statement.
    amount: round2((e.type === 'inflow' ? -1 : 1) * Number(e.amount_inr ?? 0)),
    matchedLineId: matchedByEntry.get(e.id) ?? null,
  }))

  return {
    ok: true,
    data: {
      statementId: statementRes.data?.id ?? null,
      cycle,
      label: cycleLabel(cycle),
      statementTotal: statementRes.data?.statement_total != null
        ? Number(statementRes.data.statement_total) : null,
      status: (statementRes.data?.status as 'open' | 'closed') ?? 'open',
      lines,
      entries,
    },
  }
}

/* ── Importing ───────────────────────────────────────────────────────────── */

/**
 * Create or replace a cycle's statement from parsed lines.
 *
 * Replacing is deliberate and is why `replace` must be asked for: re-importing
 * a cycle throws away the matches already made on it, and somebody who has
 * spent ten minutes matching should not lose that to a stray second paste.
 * A CLOSED cycle is never replaced at all.
 */
export async function importStatement(input: {
  bankAccountId: string
  cycleEnd: string
  lines: ParsedLine[]
  statementTotal: number | null
  replace?: boolean
}): Promise<ActionResult<{ statementId: string; lineCount: number; replaced: boolean }>> {
  const guard = await requirePermission(PERMS.CARD_RECONCILIATION_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!input.lines.length) return { ok: false, error: 'There are no lines to import.' }

  const admin = createAdminClient()
  const { data: account } = await admin
    .from('bank_accounts')
    .select('id, name, type, currency, statement_day')
    .eq('id', input.bankAccountId)
    .maybeSingle()
  if (!account || account.type !== 'credit_card') return { ok: false, error: 'That account is not a credit card.' }
  if (!account.statement_day) return { ok: false, error: 'This card has no statement day set.' }

  const cycle = cycleFor(input.cycleEnd, account.statement_day)
  if (!cycle) return { ok: false, error: 'That is not a usable cycle date.' }

  const { data: existing } = await admin
    .from('card_statements')
    .select('id, status')
    .eq('bank_account_id', input.bankAccountId)
    .eq('cycle_end', cycle.end)
    .maybeSingle()

  if (existing?.status === 'closed') {
    return { ok: false, error: 'This cycle is closed. Reopen it before importing again.' }
  }
  if (existing && !input.replace) {
    return {
      ok: false,
      error: 'This cycle already has a statement. Re-importing replaces its lines and every match made on them.',
    }
  }

  let statementId = existing?.id ?? null
  if (existing) {
    // Lines cascade to matches, so this clears both.
    await admin.from('card_statement_lines').delete().eq('statement_id', existing.id)
    await admin.from('card_statements')
      .update({ statement_total: input.statementTotal, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
  } else {
    const { data: created, error } = await admin
      .from('card_statements')
      .insert({
        bank_account_id: input.bankAccountId,
        cycle_start: cycle.start,
        cycle_end: cycle.end,
        statement_total: input.statementTotal,
        currency: account.currency ?? 'INR',
        imported_by: guard.employeeId,
      })
      .select('id')
      .single()
    if (error || !created) return { ok: false, error: error?.message ?? 'Could not create the statement.' }
    statementId = created.id
  }

  const { error: linesError } = await admin.from('card_statement_lines').insert(
    input.lines.map((l, i) => ({
      statement_id: statementId,
      txn_date: l.txnDate,
      description: l.description.slice(0, 500),
      amount: round2(l.amount),
      raw: l.raw?.slice(0, 1000) ?? null,
      display_order: i,
    })),
  )
  if (linesError) return { ok: false, error: linesError.message }

  void logActivity({
    actorId: guard.employeeId,
    entityType: 'cashbook',
    entityId: statementId,
    action: existing ? 'updated' : 'created',
    detail: { card: account.name, cycle: cycleLabel(cycle), lines: input.lines.length, replaced: Boolean(existing) },
  })

  revalidatePath(REVALIDATE)
  return { ok: true, data: { statementId: statementId!, lineCount: input.lines.length, replaced: Boolean(existing) } }
}

/* ── Matching ────────────────────────────────────────────────────────────── */

/** What the matcher proposes for a cycle. Proposes only — nothing is written. */
export async function proposeMatches(
  bankAccountId: string,
  cycleEnd: string,
): Promise<ActionResult<{ proposals: Proposal[]; unmatchedLineIds: string[]; unclaimedEntryIds: string[] }>> {
  const guard = await requireReadPermission(PERMS.CARD_RECONCILIATION_VIEW)
  if (!guard.ok) return { ok: false, error: guard.error }

  const loaded = await loadCycle(bankAccountId, cycleEnd)
  if (!loaded.ok || !loaded.data) return { ok: false, error: loaded.error ?? 'Could not load the cycle.' }

  const view = loaded.data
  const lines: StatementLine[] = view.lines
    .filter(l => l.status === 'unmatched')
    .map(l => ({ id: l.id, txnDate: l.txnDate, description: l.description, amount: l.amount }))
  const entries: EntryCandidate[] = view.entries.map(e => ({
    id: e.id,
    entryDate: e.entryDate,
    description: e.description,
    amount: e.amount,
    taken: e.matchedLineId !== null,
  }))

  return { ok: true, data: reconcile(lines, entries) }
}

/**
 * Record matches.
 *
 * Each line's existing matches are cleared first, so applying a proposal twice
 * is idempotent rather than additive. The unique index on `cashbook_entry_id`
 * is what actually refuses an entry already claimed by a DIFFERENT line — the
 * error is turned into a sentence rather than swallowed, because "some matches
 * did not save" is not something a person can act on.
 */
export async function applyMatches(input: {
  bankAccountId: string
  matches: { lineId: string; entryIds: string[] }[]
  auto?: boolean
}): Promise<ActionResult<{ linesMatched: number }>> {
  const guard = await requirePermission(PERMS.CARD_RECONCILIATION_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!input.matches.length) return { ok: false, error: 'There is nothing to match.' }

  const admin = createAdminClient()
  const lineIds = input.matches.map(m => m.lineId)

  // Every line must belong to a statement on THIS card and an open cycle.
  const { data: lines } = await admin
    .from('card_statement_lines')
    .select('id, statement_id, card_statements!inner(bank_account_id, status)')
    .in('id', lineIds)
  type LineRow = { id: string; statement_id: string; card_statements: { bank_account_id: string; status: string } }
  const rows = (lines ?? []) as unknown as LineRow[]
  if (rows.length !== lineIds.length) return { ok: false, error: 'Some of those lines no longer exist.' }
  if (rows.some(r => r.card_statements.bank_account_id !== input.bankAccountId)) {
    return { ok: false, error: 'Those lines belong to a different card.' }
  }
  if (rows.some(r => r.card_statements.status === 'closed')) {
    return { ok: false, error: 'This cycle is closed. Reopen it to change its matches.' }
  }

  await admin.from('card_statement_matches').delete().in('line_id', lineIds)

  const toInsert = input.matches.flatMap(m =>
    m.entryIds.map(entryId => ({
      line_id: m.lineId,
      cashbook_entry_id: entryId,
      matched_by: input.auto ? 'auto' : 'manual',
      matched_by_user: guard.employeeId,
    })))

  if (toInsert.length) {
    const { error } = await admin.from('card_statement_matches').insert(toInsert)
    if (error) {
      // 23505 on cashbook_entry_id: the entry is already on another line.
      const already = (error as { code?: string }).code === '23505'
      return {
        ok: false,
        error: already
          ? 'One of those entries is already matched to a different charge. Unmatch it there first.'
          : error.message,
      }
    }
  }

  await admin.from('card_statement_lines')
    .update({ status: 'matched', updated_at: new Date().toISOString() })
    .in('id', input.matches.filter(m => m.entryIds.length).map(m => m.lineId))
  const cleared = input.matches.filter(m => !m.entryIds.length).map(m => m.lineId)
  if (cleared.length) {
    await admin.from('card_statement_lines')
      .update({ status: 'unmatched', updated_at: new Date().toISOString() })
      .in('id', cleared)
  }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { linesMatched: input.matches.filter(m => m.entryIds.length).length } }
}

/** Mark a line as legitimately having no entry — the bill payment, a fee. */
export async function ignoreLine(lineId: string, reason: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.CARD_RECONCILIATION_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const trimmed = reason.trim()
  // A reason is required: ignoring without one is indistinguishable from
  // forgetting, and a closed cycle should explain every line it skipped.
  if (!trimmed) return { ok: false, error: 'Say why this line has no entry, so the closed cycle explains itself.' }

  const admin = createAdminClient()
  await admin.from('card_statement_matches').delete().eq('line_id', lineId)
  const { error } = await admin.from('card_statement_lines')
    .update({ status: 'ignored', ignore_reason: trimmed.slice(0, 300), updated_at: new Date().toISOString() })
    .eq('id', lineId)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/* ── Closing ─────────────────────────────────────────────────────────────── */

/**
 * Close a cycle.
 *
 * REFUSED unless every line is accounted for and the lines add up to the
 * statement's own total. A cycle that can be closed while something is
 * outstanding is a cycle nobody can trust afterwards, which is the entire
 * point of closing one.
 */
export async function closeCycle(
  bankAccountId: string,
  cycleEnd: string,
): Promise<ActionResult<{ closed: true }>> {
  const guard = await requirePermission(PERMS.CARD_RECONCILIATION_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const loaded = await loadCycle(bankAccountId, cycleEnd)
  if (!loaded.ok || !loaded.data) return { ok: false, error: loaded.error ?? 'Could not load the cycle.' }
  const view = loaded.data
  if (!view.statementId) return { ok: false, error: 'There is no statement for this cycle yet.' }

  const outstanding = view.lines.filter(l => l.status === 'unmatched')
  if (outstanding.length) {
    return {
      ok: false,
      error: `${outstanding.length} line${outstanding.length === 1 ? ' is' : 's are'} still unmatched. Match or ignore ${outstanding.length === 1 ? 'it' : 'them'} first.`,
    }
  }
  if (view.statementTotal === null) {
    return { ok: false, error: 'Enter the statement total first, so closing can check the cycle adds up.' }
  }
  const linesTotal = round2(view.lines.reduce((sum, l) => sum + l.amount, 0))
  const difference = round2(linesTotal - view.statementTotal)
  if (Math.abs(difference) >= 0.005) {
    return {
      ok: false,
      error: `The lines add up to ${linesTotal}, but the statement says ${view.statementTotal} — a difference of ${difference}.`,
    }
  }

  const admin = createAdminClient()
  const { error } = await admin.from('card_statements')
    .update({ status: 'closed', closed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', view.statementId)
  if (error) return { ok: false, error: error.message }

  void logActivity({
    actorId: guard.employeeId,
    entityType: 'cashbook',
    entityId: view.statementId,
    action: 'updated',
    detail: { closed: true, cycle: view.label, lines: view.lines.length, total: view.statementTotal },
  })

  revalidatePath(REVALIDATE)
  return { ok: true, data: { closed: true } }
}

/** Reopen a closed cycle, so its matches can be corrected. */
export async function reopenCycle(statementId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.CARD_RECONCILIATION_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('card_statements')
    .update({ status: 'open', closed_at: null, updated_at: new Date().toISOString() })
    .eq('id', statementId)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/** The statement's own total, typed off the PDF. */
export async function setStatementTotal(
  statementId: string,
  total: number | null,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.CARD_RECONCILIATION_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('card_statements')
    .update({ statement_total: total === null ? null : round2(total), updated_at: new Date().toISOString() })
    .eq('id', statementId)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

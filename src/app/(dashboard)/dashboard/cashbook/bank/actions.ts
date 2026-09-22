'use server'

/**
 * Bank reconciliation — every write goes through here.
 *
 * WHAT THIS MODULE IS CAREFUL ABOUT. A reconciled period's whole value is that
 * it is TRUE: every movement the bank recorded is in the books, nothing is in
 * the books twice, and the two agree to the paise. Three rules protect that,
 * and the first two live in the database rather than in this file's good
 * intentions:
 *
 *   · one entry belongs to ONE line — a unique index on
 *     bank_statement_matches.cashbook_entry_id, so a receipt cannot be counted
 *     against two lines and make two periods both appear to balance;
 *   · one statement per account per period — UNIQUE (bank_account_id,
 *     period_start, period_end), so a second import of the same month is
 *     refused rather than duplicated;
 *   · a period cannot close while anything is outstanding OR while the lines
 *     do not carry the opening balance to the closing one.
 *
 * THE SIGN CONVENTION, everywhere in this file: POSITIVE is money IN,
 * NEGATIVE is money OUT. A cashbook 'inflow' is therefore positive and an
 * 'outflow' negative — the opposite of the card module, deliberately, because
 * a bank account is an asset and a card is a liability.
 *
 * Matching itself is in src/lib/reconcile/match.ts and proposes only; nothing
 * here applies a proposal without a person asking for it.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission, requireReadPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import { round2 } from '@/lib/calculations/currency'
import { isPeriod, periodLabel, type Period } from '@/lib/bank/period'
import { isLineKind, summariseKinds, type KindSummary } from '@/lib/bank/line-kinds'
import {
  explainUnmatched, flagDuplicateEntries, periodBalance, reconcile,
  type DuplicateGroup, type EntryCandidate, type Hint, type Proposal, type StatementLine,
} from '@/lib/reconcile/match'
import type { ParsedLine } from '@/lib/reconcile/parse'

const REVALIDATE = '/dashboard/cashbook/bank'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

/* ── Reading a period ─────────────────────────────────────────────────────── */

export interface PeriodEntry {
  id: string
  entryDate: string
  description: string
  /** Signed like the statement: an inflow is positive. */
  amount: number
  reference: string | null
  categoryName: string | null
  /** True for the two halves of an internal transfer, which the bank sees once. */
  isTransfer: boolean
  /** The line it is already matched to, or null. */
  matchedLineId: string | null
}

export interface PeriodLine {
  id: string
  txnDate: string
  description: string
  amount: number
  balanceAfter: number | null
  reference: string | null
  raw: string | null
  status: 'unmatched' | 'matched' | 'ignored'
  ignoreReason: string | null
  /** Why it is set aside, as a groupable code. See lib/bank/line-kinds.ts. */
  lineKind: string | null
  entryIds: string[]
}

export interface PeriodView {
  statementId: string | null
  accountId: string
  accountName: string
  currency: string
  period: Period
  label: string
  openingBalance: number | null
  closingBalance: number | null
  status: 'open' | 'closed'
  lines: PeriodLine[]
  entries: PeriodEntry[]
  /** Set-aside lines grouped by kind, with the non-company total. */
  kinds: KindSummary
}

/**
 * Everything one period needs, in one call.
 *
 * `entries` are the account's own cashbook rows inside the period, signed the
 * way the bank signs them. Getting that flip backwards is how a period
 * balances by exactly twice a receipt, so it happens once, here.
 */
export async function loadPeriod(
  bankAccountId: string,
  period: Period,
): Promise<ActionResult<PeriodView>> {
  // Reads only, so the READ guard: the write guard refuses during a
  // "view as" preview and would show a broken page instead of a narrower one.
  const guard = await requireReadPermission(PERMS.BANK_RECONCILIATION_VIEW)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!isPeriod(period)) return { ok: false, error: 'That is not a usable period.' }

  const admin = createAdminClient()

  const { data: account } = await admin
    .from('bank_accounts')
    .select('id, name, type, currency')
    .eq('id', bankAccountId)
    .maybeSingle()
  if (!account) return { ok: false, error: 'No such account.' }
  if (account.type === 'credit_card') {
    return { ok: false, error: `${account.name} is a credit card. Reconcile it under Card Statements.` }
  }

  const [statementRes, entriesRes] = await Promise.all([
    admin.from('bank_statements')
      .select('id, opening_balance, closing_balance, status')
      .eq('bank_account_id', bankAccountId)
      .eq('period_start', period.start)
      .eq('period_end', period.end)
      .maybeSingle(),
    admin.from('cashbook_entries')
      .select('id, entry_date, description, reference, amount_inr, type, transfer_ref, category:cashbook_categories(name)')
      .eq('bank_account_id', bankAccountId)
      .is('deleted_at', null)
      .gte('entry_date', period.start)
      .lte('entry_date', period.end)
      .order('entry_date', { ascending: true }),
  ])

  let lines: PeriodLine[] = []
  const matchedByEntry = new Map<string, string>()
  if (statementRes.data) {
    // `line_kind` arrives with migration 20260922140000. Until it is applied
    // the select is retried without it, because Postgres fails the whole
    // query over one unknown column — and a period that HAS 184 lines would
    // otherwise render as "nothing imported yet", which reads as data loss
    // rather than as a pending migration.
    // Both typed `string`, not inferred as literals: Supabase derives a row
    // shape from the select text, so the two branches would otherwise be two
    // structurally different types that cannot be assigned to one variable.
    // The same reason cashbook/page.tsx casts its own selects.
    const COLUMNS: string = 'id, txn_date, description, amount, balance_after, reference, raw, status, ignore_reason, display_order, bank_statement_matches(cashbook_entry_id)'
    const WITH_KIND: string = `${COLUMNS}, line_kind`
    // eslint-disable-next-line prefer-const -- lineRows is reassigned by the retry below
    let { data: lineRows, error: linesError } = await admin
      .from('bank_statement_lines')
      .select(WITH_KIND)
      .eq('statement_id', statementRes.data.id)
      .order('display_order', { ascending: true })

    if (linesError && /line_kind|column .* does not exist|schema cache/i.test(linesError.message ?? '')) {
      ;({ data: lineRows } = await admin
        .from('bank_statement_lines')
        .select(COLUMNS)
        .eq('statement_id', statementRes.data.id)
        .order('display_order', { ascending: true }))
    }

    type Row = {
      id: string; txn_date: string; description: string; amount: number
      balance_after: number | null; reference: string | null; raw: string | null
      status: PeriodLine['status']; ignore_reason: string | null; line_kind?: string | null
      bank_statement_matches: { cashbook_entry_id: string }[] | null
    }
    // via unknown: the select string is typed `string` for the retry above, so
    // Supabase can no longer infer a row shape and hands back its error union.
    lines = ((lineRows ?? []) as unknown as Row[]).map(r => {
      const entryIds = (r.bank_statement_matches ?? []).map(m => m.cashbook_entry_id)
      for (const id of entryIds) matchedByEntry.set(id, r.id)
      return {
        id: r.id,
        txnDate: r.txn_date,
        description: r.description,
        amount: Number(r.amount),
        balanceAfter: r.balance_after === null ? null : Number(r.balance_after),
        reference: r.reference,
        raw: r.raw,
        status: r.status,
        ignoreReason: r.ignore_reason,
        lineKind: r.line_kind ?? null,
        entryIds,
      }
    })
  }

  type EntryRow = {
    id: string; entry_date: string; description: string | null; reference: string | null
    amount_inr: number | null; type: string; transfer_ref: string | null
    category: { name: string } | { name: string }[] | null
  }
  const entries: PeriodEntry[] = ((entriesRes.data ?? []) as unknown as EntryRow[]).map(e => {
    const cat = Array.isArray(e.category) ? e.category[0] : e.category
    return {
      id: e.id,
      entryDate: e.entry_date,
      description: e.description ?? '',
      // Money in is positive, exactly as the bank prints it.
      amount: round2((e.type === 'inflow' ? 1 : -1) * Number(e.amount_inr ?? 0)),
      reference: e.reference,
      categoryName: cat?.name ?? null,
      isTransfer: Boolean(e.transfer_ref),
      matchedLineId: matchedByEntry.get(e.id) ?? null,
    }
  })

  return {
    ok: true,
    data: {
      statementId: statementRes.data?.id ?? null,
      accountId: account.id,
      accountName: account.name,
      currency: account.currency ?? 'INR',
      period,
      label: periodLabel(period),
      openingBalance: statementRes.data?.opening_balance != null ? Number(statementRes.data.opening_balance) : null,
      closingBalance: statementRes.data?.closing_balance != null ? Number(statementRes.data.closing_balance) : null,
      status: (statementRes.data?.status as 'open' | 'closed') ?? 'open',
      lines,
      entries,
      kinds: summariseKinds(lines),
    },
  }
}

/* ── Importing ───────────────────────────────────────────────────────────── */

/**
 * Create or replace a period's statement from parsed lines.
 *
 * Replacing is deliberate and is why `replace` must be asked for: re-importing
 * throws away the matches already made, and somebody who has spent ten minutes
 * matching should not lose that to a stray second paste. A CLOSED period is
 * never replaced at all.
 *
 * Lines dated outside the period are REFUSED rather than trimmed. A statement
 * carrying August rows into July's import is the wrong file or the wrong
 * period, and silently dropping them would produce a period that balances
 * against a statement nobody actually imported.
 */
export async function importStatement(input: {
  bankAccountId: string
  period: Period
  lines: ParsedLine[]
  openingBalance: number | null
  closingBalance: number | null
  replace?: boolean
}): Promise<ActionResult<{ statementId: string; lineCount: number; replaced: boolean }>> {
  const guard = await requirePermission(PERMS.BANK_RECONCILIATION_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!isPeriod(input.period)) return { ok: false, error: 'That is not a usable period.' }
  if (!input.lines.length) return { ok: false, error: 'There are no lines to import.' }

  const { period } = input
  const strays = input.lines.filter(l => l.txnDate < period.start || l.txnDate > period.end)
  if (strays.length) {
    const sample = strays.slice(0, 3).map(l => l.txnDate).join(', ')
    return {
      ok: false,
      error: `${strays.length} line${strays.length === 1 ? ' is' : 's are'} dated outside ${periodLabel(period)} (${sample}${strays.length > 3 ? '…' : ''}). Pick the period the statement actually covers, or import the right file.`,
    }
  }

  const admin = createAdminClient()
  const { data: account } = await admin
    .from('bank_accounts')
    .select('id, name, type, currency')
    .eq('id', input.bankAccountId)
    .maybeSingle()
  if (!account) return { ok: false, error: 'No such account.' }
  if (account.type === 'credit_card') {
    return { ok: false, error: `${account.name} is a credit card. Import it under Card Statements.` }
  }

  const { data: existing } = await admin
    .from('bank_statements')
    .select('id, status')
    .eq('bank_account_id', input.bankAccountId)
    .eq('period_start', period.start)
    .eq('period_end', period.end)
    .maybeSingle()

  if (existing?.status === 'closed') {
    return { ok: false, error: 'This period is closed. Reopen it before importing again.' }
  }
  if (existing && !input.replace) {
    return {
      ok: false,
      error: 'This period already has a statement. Re-importing replaces its lines and every match made on them.',
    }
  }

  let statementId = existing?.id ?? null
  if (existing) {
    // Lines cascade to matches, so this clears both.
    await admin.from('bank_statement_lines').delete().eq('statement_id', existing.id)
    await admin.from('bank_statements')
      .update({
        opening_balance: input.openingBalance,
        closing_balance: input.closingBalance,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
  } else {
    const { data: created, error } = await admin
      .from('bank_statements')
      .insert({
        bank_account_id: input.bankAccountId,
        period_start: period.start,
        period_end: period.end,
        opening_balance: input.openingBalance,
        closing_balance: input.closingBalance,
        currency: account.currency ?? 'INR',
        imported_by: guard.employeeId,
      })
      .select('id')
      .single()
    if (error || !created) return { ok: false, error: error?.message ?? 'Could not create the statement.' }
    statementId = created.id
  }

  const { error: linesError } = await admin.from('bank_statement_lines').insert(
    input.lines.map((l, i) => ({
      statement_id: statementId,
      txn_date: l.txnDate,
      description: l.description.slice(0, 500),
      amount: round2(l.amount),
      balance_after: l.balanceAfter ?? null,
      reference: l.reference?.slice(0, 120) ?? null,
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
    detail: { account: account.name, period: periodLabel(period), lines: input.lines.length, replaced: Boolean(existing) },
  })

  revalidatePath(REVALIDATE)
  return { ok: true, data: { statementId: statementId!, lineCount: input.lines.length, replaced: Boolean(existing) } }
}

/* ── Matching, and explaining what did not ───────────────────────────────── */

export interface MismatchReport {
  proposals: Proposal[]
  /** Why each still-unmatched line found nothing — the actionable half. */
  hints: Hint[]
  /** Entries that look like the same transaction recorded twice. */
  duplicates: DuplicateGroup[]
  unmatchedLineIds: string[]
  unclaimedEntryIds: string[]
}

/**
 * What the matcher proposes, and what it could not place.
 *
 * Proposes only — nothing here is written. The hints are the point: a list of
 * unmatched lines is a list of work, whereas "this exact amount is recorded
 * eleven days later" is an answer.
 */
export async function analysePeriod(
  bankAccountId: string,
  period: Period,
): Promise<ActionResult<MismatchReport>> {
  const guard = await requireReadPermission(PERMS.BANK_RECONCILIATION_VIEW)
  if (!guard.ok) return { ok: false, error: guard.error }

  const loaded = await loadPeriod(bankAccountId, period)
  if (!loaded.ok || !loaded.data) return { ok: false, error: loaded.error ?? 'Could not load the period.' }

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

  const result = reconcile(lines, entries)

  // Hints and duplicates are computed against what the matcher COULD NOT
  // place, so an entry a proposal already claims never shows up as a reason a
  // different line failed.
  const claimed = new Set(result.proposals.flatMap(p => p.entryIds))
  const leftOver = entries.map(e => ({ ...e, taken: e.taken || claimed.has(e.id) }))
  const stillUnmatched = lines.filter(l => result.unmatchedLineIds.includes(l.id))

  return {
    ok: true,
    data: {
      proposals: result.proposals,
      hints: explainUnmatched(stillUnmatched, leftOver),
      duplicates: flagDuplicateEntries(leftOver),
      unmatchedLineIds: result.unmatchedLineIds,
      unclaimedEntryIds: result.unclaimedEntryIds,
    },
  }
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
  const guard = await requirePermission(PERMS.BANK_RECONCILIATION_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!input.matches.length) return { ok: false, error: 'There is nothing to match.' }

  const admin = createAdminClient()
  const lineIds = input.matches.map(m => m.lineId)

  // Every line must belong to a statement on THIS account and an open period.
  const { data: lines } = await admin
    .from('bank_statement_lines')
    .select('id, statement_id, bank_statements!inner(bank_account_id, status)')
    .in('id', lineIds)
  type LineRow = { id: string; statement_id: string; bank_statements: { bank_account_id: string; status: string } }
  const rows = (lines ?? []) as unknown as LineRow[]
  if (rows.length !== lineIds.length) return { ok: false, error: 'Some of those lines no longer exist.' }
  if (rows.some(r => r.bank_statements.bank_account_id !== input.bankAccountId)) {
    return { ok: false, error: 'Those lines belong to a different account.' }
  }
  if (rows.some(r => r.bank_statements.status === 'closed')) {
    return { ok: false, error: 'This period is closed. Reopen it to change its matches.' }
  }

  await admin.from('bank_statement_matches').delete().in('line_id', lineIds)

  const toInsert = input.matches.flatMap(m =>
    m.entryIds.map(entryId => ({
      line_id: m.lineId,
      cashbook_entry_id: entryId,
      matched_by: input.auto ? 'auto' : 'manual',
      matched_by_user: guard.employeeId,
    })))

  if (toInsert.length) {
    const { error } = await admin.from('bank_statement_matches').insert(toInsert)
    if (error) {
      // 23505 on cashbook_entry_id: the entry is already on another line.
      const already = (error as { code?: string }).code === '23505'
      return {
        ok: false,
        error: already
          ? 'One of those entries is already matched to a different line. Unmatch it there first.'
          : error.message,
      }
    }
  }

  const matchedIds = input.matches.filter(m => m.entryIds.length).map(m => m.lineId)
  if (matchedIds.length) {
    await admin.from('bank_statement_lines')
      .update({ status: 'matched', updated_at: new Date().toISOString() })
      .in('id', matchedIds)
  }
  const cleared = input.matches.filter(m => !m.entryIds.length).map(m => m.lineId)
  if (cleared.length) {
    await admin.from('bank_statement_lines')
      .update({ status: 'unmatched', ignore_reason: null, updated_at: new Date().toISOString() })
      .in('id', cleared)
  }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { linesMatched: matchedIds.length } }
}

/**
 * Set lines aside as a KIND, in one go.
 *
 * Batched on purpose. A statement carries forty-odd sweep lines and a dozen
 * cashback credits, and classifying them one at a time is the kind of tedium
 * that gets abandoned half-finished — which leaves a period that cannot close
 * and totals that are wrong rather than merely absent.
 *
 * Setting a kind also sets the line to 'ignored': a classified line is
 * accounted for, which is what closing the period asks of it. Passing a null
 * kind puts the lines back to 'unmatched' and clears both the kind and the
 * note, so a wrong bulk classification is one action to undo.
 */
export async function setLineKinds(input: {
  bankAccountId: string
  lineIds: string[]
  kind: string | null
  note?: string
}): Promise<ActionResult<{ changed: number }>> {
  const guard = await requirePermission(PERMS.BANK_RECONCILIATION_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!input.lineIds.length) return { ok: false, error: 'There are no lines to set aside.' }
  if (input.kind !== null && !isLineKind(input.kind)) {
    return { ok: false, error: `“${input.kind}” is not a kind this knows.` }
  }

  const admin = createAdminClient()

  // Every line must belong to a statement on THIS account and an open period —
  // the same guard applyMatches uses, for the same reason.
  const { data: rows } = await admin
    .from('bank_statement_lines')
    .select('id, bank_statements!inner(bank_account_id, status)')
    .in('id', input.lineIds)
  type LineRow = { id: string; bank_statements: { bank_account_id: string; status: string } }
  const found = (rows ?? []) as unknown as LineRow[]
  if (found.length !== input.lineIds.length) return { ok: false, error: 'Some of those lines no longer exist.' }
  if (found.some(r => r.bank_statements.bank_account_id !== input.bankAccountId)) {
    return { ok: false, error: 'Those lines belong to a different account.' }
  }
  if (found.some(r => r.bank_statements.status === 'closed')) {
    return { ok: false, error: 'This period is closed. Reopen it to change how its lines are classified.' }
  }

  // A line cannot be both matched to an entry and set aside as something else.
  if (input.kind !== null) {
    await admin.from('bank_statement_matches').delete().in('line_id', input.lineIds)
  }

  const { error } = await admin.from('bank_statement_lines')
    .update({
      line_kind: input.kind,
      status: input.kind === null ? 'unmatched' : 'ignored',
      ignore_reason: input.kind === null ? null : (input.note?.trim().slice(0, 300) || null),
      updated_at: new Date().toISOString(),
    })
    .in('id', input.lineIds)
  if (error) return { ok: false, error: error.message }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { changed: input.lineIds.length } }
}

/** Mark a line as legitimately having no entry — bank charges booked elsewhere. */
export async function ignoreLine(lineId: string, reason: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.BANK_RECONCILIATION_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const trimmed = reason.trim()
  // A reason is required: ignoring without one is indistinguishable from
  // forgetting, and a closed period should explain every line it skipped.
  if (!trimmed) return { ok: false, error: 'Say why this line has no entry, so the closed period explains itself.' }

  const admin = createAdminClient()
  await admin.from('bank_statement_matches').delete().eq('line_id', lineId)
  const { error } = await admin.from('bank_statement_lines')
    .update({ status: 'ignored', ignore_reason: trimmed.slice(0, 300), updated_at: new Date().toISOString() })
    .eq('id', lineId)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/* ── The statement's own balances ────────────────────────────────────────── */

export async function setBalances(
  statementId: string,
  opening: number | null,
  closing: number | null,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.BANK_RECONCILIATION_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('bank_statements')
    .update({
      opening_balance: opening === null ? null : round2(opening),
      closing_balance: closing === null ? null : round2(closing),
      updated_at: new Date().toISOString(),
    })
    .eq('id', statementId)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/* ── Closing ─────────────────────────────────────────────────────────────── */

/**
 * Close a period.
 *
 * REFUSED unless every line is accounted for AND the lines carry the opening
 * balance to the closing one. A period that can be closed while something is
 * outstanding is a period nobody can trust afterwards, which is the entire
 * point of closing one.
 */
export async function closePeriod(
  bankAccountId: string,
  period: Period,
): Promise<ActionResult<{ closed: true }>> {
  const guard = await requirePermission(PERMS.BANK_RECONCILIATION_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const loaded = await loadPeriod(bankAccountId, period)
  if (!loaded.ok || !loaded.data) return { ok: false, error: loaded.error ?? 'Could not load the period.' }
  const view = loaded.data
  if (!view.statementId) return { ok: false, error: 'There is no statement for this period yet.' }

  const outstanding = view.lines.filter(l => l.status === 'unmatched')
  if (outstanding.length) {
    return {
      ok: false,
      error: `${outstanding.length} line${outstanding.length === 1 ? ' is' : 's are'} still unmatched. Match or ignore ${outstanding.length === 1 ? 'it' : 'them'} first.`,
    }
  }
  if (view.openingBalance === null || view.closingBalance === null) {
    return { ok: false, error: 'Enter the opening and closing balance first, so closing can check the period adds up.' }
  }
  const balance = periodBalance(
    view.lines.map(l => ({ id: l.id, txnDate: l.txnDate, description: l.description, amount: l.amount })),
    view.openingBalance,
    view.closingBalance,
  )
  if (!balance.agrees) {
    return {
      ok: false,
      error: `${view.openingBalance} plus the lines comes to ${balance.expectedClosing}, but the statement closes at ${view.closingBalance} — a difference of ${balance.difference}. A line is missing from the import, or one was read the wrong way round.`,
    }
  }

  const admin = createAdminClient()
  const { error } = await admin.from('bank_statements')
    .update({ status: 'closed', closed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', view.statementId)
  if (error) return { ok: false, error: error.message }

  void logActivity({
    actorId: guard.employeeId,
    entityType: 'cashbook',
    entityId: view.statementId,
    action: 'updated',
    detail: { closed: true, account: view.accountName, period: view.label, lines: view.lines.length },
  })

  revalidatePath(REVALIDATE)
  return { ok: true, data: { closed: true } }
}

/** Reopen a closed period, so its matches can be corrected. */
export async function reopenPeriod(statementId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.BANK_RECONCILIATION_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('bank_statements')
    .update({ status: 'open', closed_at: null, updated_at: new Date().toISOString() })
    .eq('id', statementId)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

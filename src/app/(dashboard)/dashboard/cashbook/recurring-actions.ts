'use server'

/**
 * Recurring-expense rules — CRUD for the Cash Book → Recurring panel.
 *
 * A rule is a standing instruction ("₹25,000 rent, 1st of every month"). The
 * daily cron (/api/cron/recurring-expenses) posts each occurrence into
 * cashbook_entries on its own due date, where the normal cashbook machinery
 * takes over.
 *
 * Distinct from the entry form's "repeat for N months" checkbox, which
 * materialises N independent entries immediately. That remains for finite
 * series; this is the open-ended, editable, pausable version.
 *
 * These expenses affect COMPANY PROFIT only — never the contribution pool or
 * any employee's contribution earnings.
 *
 * Permission: cashbook.edit (admins bypass).
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import { nextDueDate, type RecurringRule } from '@/lib/finance/recurring-schedule'
import { todayISO } from '@/lib/utils/local-date'

const REVALIDATE = '/dashboard/cashbook'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

export interface RecurringExpenseInput {
  id?: string
  name: string
  categoryId: string
  amount: number
  amountInr: number
  currency?: string
  dayOfMonth: number
  frequency: 'monthly' | 'yearly'
  startDate: string
  endDate?: string | null
  bankAccountId?: string | null
  clientId?: string | null
  notes?: string | null
}

export interface RecurringExpenseRow {
  id: string
  name: string
  category_id: string
  category_name: string | null
  amount: number
  amount_inr: number
  currency: string
  day_of_month: number
  frequency: 'monthly' | 'yearly'
  start_date: string
  end_date: string | null
  bank_account_id: string | null
  client_id: string | null
  notes: string | null
  is_active: boolean
  /** Derived, not stored — next date the cron will post this rule. */
  next_due: string | null
  /** Derived — most recent occurrence already posted. */
  last_posted: string | null
}

/** Rules with derived next-due / last-posted, for the panel. */
export async function listRecurringExpenses(): Promise<ActionResult<RecurringExpenseRow[]>> {
  const admin = createAdminClient()
  const today = todayISO()
  try {
    const { data, error } = await admin
      .from('recurring_expenses')
      .select('*, category:cashbook_categories(name)')
      .order('is_active', { ascending: false })
      .order('name')
    if (error) {
      // Feature not migrated yet — an empty list, not an error page.
      if (/does not exist|PGRST205/i.test(error.message || '')) return { ok: true, data: [] }
      return { ok: false, error: error.message }
    }

    const ids = (data || []).map((r: Record<string, unknown>) => r.id as string)
    const lastByRule = new Map<string, string>()
    if (ids.length) {
      const { data: entries } = await admin
        .from('cashbook_entries')
        .select('reference, entry_date')
        .like('reference', 'recurring:%')
        .is('deleted_at', null)
        .order('entry_date', { ascending: false })
      for (const e of (entries || []) as { reference: string; entry_date: string }[]) {
        const ruleId = String(e.reference).split(':')[1]
        if (ruleId && !lastByRule.has(ruleId)) lastByRule.set(ruleId, e.entry_date)
      }
    }

    const rows: RecurringExpenseRow[] = (data || []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      name: r.name as string,
      category_id: r.category_id as string,
      category_name: (r.category as { name?: string } | null)?.name ?? null,
      amount: Number(r.amount || 0),
      amount_inr: Number(r.amount_inr || 0),
      currency: (r.currency as string) || 'INR',
      day_of_month: Number(r.day_of_month || 1),
      frequency: (r.frequency as 'monthly' | 'yearly') || 'monthly',
      start_date: r.start_date as string,
      end_date: (r.end_date as string) ?? null,
      bank_account_id: (r.bank_account_id as string) ?? null,
      client_id: (r.client_id as string) ?? null,
      notes: (r.notes as string) ?? null,
      is_active: r.is_active !== false,
      next_due: r.is_active === false ? null : nextDueDate(r as unknown as RecurringRule, today),
      last_posted: lastByRule.get(r.id as string) ?? null,
    }))
    return { ok: true, data: rows }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not load recurring expenses.' }
  }
}

export async function saveRecurringExpense(input: RecurringExpenseInput): Promise<ActionResult<{ id: string }>> {
  const guard = await requirePermission(PERMS.CASHBOOK_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const name = (input.name || '').trim()
  if (!name) return { ok: false, error: 'Give the expense a name.' }
  if (!input.categoryId) return { ok: false, error: 'Pick a category.' }
  if (!(input.amount > 0) || !(input.amountInr > 0)) return { ok: false, error: 'Amount must be greater than zero.' }
  if (input.endDate && input.endDate < input.startDate) {
    return { ok: false, error: 'End date cannot be before the start date.' }
  }

  const admin = createAdminClient()
  // 1–28 keeps every month valid without clamping rules.
  const day = Math.min(Math.max(Math.round(input.dayOfMonth || 1), 1), 28)
  const row = {
    name,
    category_id: input.categoryId,
    amount: input.amount,
    amount_inr: input.amountInr,
    currency: input.currency || 'INR',
    day_of_month: day,
    frequency: input.frequency,
    start_date: input.startDate,
    end_date: input.endDate || null,
    bank_account_id: input.bankAccountId || null,
    client_id: input.clientId || null,
    notes: input.notes || null,
    updated_at: new Date().toISOString(),
  }

  if (input.id) {
    const { error } = await admin.from('recurring_expenses').update(row).eq('id', input.id)
    if (error) return { ok: false, error: error.message }
    void logActivity({
      actorId: guard.employeeId, entityType: 'cashbook', entityId: input.id,
      action: 'updated', detail: { recurring_expense: name, amount_inr: input.amountInr },
    }).catch(() => {})
    revalidatePath(REVALIDATE)
    return { ok: true, data: { id: input.id } }
  }

  const { data, error } = await admin
    .from('recurring_expenses')
    .insert({ ...row, created_by: guard.employeeId })
    .select('id').single()
  if (error) return { ok: false, error: error.message }
  void logActivity({
    actorId: guard.employeeId, entityType: 'cashbook', entityId: data.id,
    action: 'created', detail: { recurring_expense: name, amount_inr: input.amountInr },
  }).catch(() => {})
  revalidatePath(REVALIDATE)
  return { ok: true, data: { id: data.id } }
}

/** Pause or resume. Already-posted entries are never touched. */
export async function setRecurringExpenseActive(id: string, isActive: boolean): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.CASHBOOK_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin
    .from('recurring_expenses')
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/**
 * Delete a RULE. Entries it already posted stay in the cashbook — they are
 * real money that was really spent; removing them would rewrite history.
 */
export async function deleteRecurringExpense(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.CASHBOOK_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('recurring_expenses').delete().eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

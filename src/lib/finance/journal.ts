/**
 * Finance Engine — the ONLY query surface.
 *
 * Queries base tables (cashbook_entries + category join) instead of the
 * v_finance_journal view so the app works identically whether or not the
 * Phase-3 view migration has been applied. The view exists for SQL/BI
 * consumers and integrity checks.
 *
 * Pre-Phase-1 databases (no scope/statement_section columns) degrade
 * gracefully: lines come back with scope/section null (= untriaged /
 * unclassified) rather than erroring.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { JournalLine } from './types'
import type { FinanceScope } from './classify'

const PAGE = 1000

const FULL_SELECT = `
  id, entry_date, type, amount_inr, scope, client_id, employee_id,
  bank_account_id, description, transfer_ref,
  category:cashbook_categories(id, name, statement_section, account_code)
`.trim()

// Pre-scope-migration fallback: same shape minus the new columns.
const LEGACY_SELECT = `
  id, entry_date, type, amount_inr, client_id, employee_id,
  bank_account_id, description, transfer_ref,
  category:cashbook_categories(id, name)
`.trim()

export interface JournalFilter {
  /** Inclusive YYYY-MM-DD bounds on entry_date. */
  from?: string
  to?: string
  /** 'untriaged' = scope IS NULL. Omit for all scopes. */
  scope?: FinanceScope | 'untriaged'
  /** Transfers net to zero across the books; excluded unless asked for. */
  includeTransfers?: boolean
}

function toLine(r: any): JournalLine {
  const cat = r.category ?? null
  const amountInr = Number(r.amount_inr || 0)
  return {
    id: r.id,
    date: r.entry_date,
    scope: r.scope ?? null,
    section: cat?.statement_section ?? null,
    accountCode: cat?.account_code ?? null,
    categoryId: cat?.id ?? null,
    categoryName: cat?.name ?? null,
    clientId: r.client_id ?? null,
    employeeId: r.employee_id ?? null,
    bankAccountId: r.bank_account_id ?? null,
    amountInr: r.type === 'inflow' ? amountInr : -amountInr,
    description: r.description ?? null,
    isTransfer: r.transfer_ref != null,
  }
}

function isMissingColumn(error: { code?: string | null; message?: string | null } | null): boolean {
  if (!error) return false
  return error.code === '42703' || /column .* does not exist|could not find/i.test(error.message ?? '')
}

/**
 * Fetch normalized journal lines. Paginates internally (stable id order) so
 * callers never see a truncated ledger.
 */
export async function fetchJournalLines(
  admin: SupabaseClient,
  filter: JournalFilter = {},
): Promise<JournalLine[]> {
  const lines: JournalLine[] = []
  let legacy = false

  for (let offset = 0; ; offset += PAGE) {
    const build = (select: string) => {
      let q = admin
        .from('cashbook_entries')
        .select(select)
        .is('deleted_at', null)
        .order('entry_date', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + PAGE - 1)
      if (filter.from) q = q.gte('entry_date', filter.from)
      if (filter.to) q = q.lte('entry_date', filter.to)
      if (!legacy && filter.scope === 'untriaged') q = q.is('scope', null)
      else if (!legacy && filter.scope) q = q.eq('scope', filter.scope)
      return q
    }

    let { data, error } = await build(legacy ? LEGACY_SELECT : FULL_SELECT)
    if (error && !legacy && isMissingColumn(error)) {
      // Scope migration not applied — degrade to the legacy shape. A scope
      // filter can't match anything real yet: 'untriaged' means everything,
      // a concrete scope means nothing.
      legacy = true
      if (filter.scope && filter.scope !== 'untriaged') return []
      ;({ data, error } = await build(LEGACY_SELECT))
    }
    if (error) throw new Error(`[finance/journal] ${error.message}`)

    const page = (data ?? []) as any[]
    for (const r of page) {
      const line = toLine(r)
      if (!filter.includeTransfers && line.isTransfer) continue
      lines.push(line)
    }
    if (page.length < PAGE) break
  }

  return lines
}

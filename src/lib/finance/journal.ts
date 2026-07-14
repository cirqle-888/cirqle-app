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

const BASE_COLUMNS = `
  id, entry_date, type, amount_inr, client_id, employee_id,
  bank_account_id, description, transfer_ref
`.trim()

const SCOPE_CATEGORY = `scope, category:cashbook_categories(id, name, statement_section, account_code)`
const LEGACY_CATEGORY = `category:cashbook_categories(id, name)`
const TAGS_FRAGMENT = `tags:cashbook_entry_tags(tag:cashbook_tags(name))`

function buildSelect(useScopeColumns: boolean, includeTags: boolean): string {
  const parts = [BASE_COLUMNS, useScopeColumns ? SCOPE_CATEGORY : LEGACY_CATEGORY]
  if (includeTags) parts.push(TAGS_FRAGMENT)
  return parts.join(', ')
}

export interface JournalFilter {
  /** Inclusive YYYY-MM-DD bounds on entry_date. */
  from?: string
  to?: string
  /** 'untriaged' = scope IS NULL. Omit for all scopes. */
  scope?: FinanceScope | 'untriaged'
  /** Transfers net to zero across the books; excluded unless asked for. */
  includeTransfers?: boolean
  /** Populate JournalLine.tags (extra join — only request when needed). */
  includeTags?: boolean
}

function toLine(r: any): JournalLine {
  const cat = r.category ?? null
  const amountInr = Number(r.amount_inr || 0)
  const line: JournalLine = {
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
  if (Array.isArray(r.tags)) {
    line.tags = r.tags.map((t: any) => t?.tag?.name).filter(Boolean)
  }
  return line
}

function isMissingColumn(error: { code?: string | null; message?: string | null } | null): boolean {
  if (!error) return false
  return error.code === '42703' || /column .* does not exist|could not find/i.test(error.message ?? '')
}

/** Missing relation — either the scope migration's tables or the tags migration's tables. */
function isMissingRelation(error: { code?: string | null; message?: string | null } | null): boolean {
  if (!error) return false
  return error.code === '42P01' || error.code === 'PGRST205' || error.code === 'PGRST200'
    || /does not exist|could not find a relationship|schema cache/i.test(error.message ?? '')
}

/**
 * Fetch normalized journal lines. Paginates internally (stable id order) so
 * callers never see a truncated ledger. Independently tolerant of two
 * unrelated unapplied migrations: the scope columns (20260714090000) and the
 * tags tables (20260714160000) — either, both, or neither may be applied.
 */
export async function fetchJournalLines(
  admin: SupabaseClient,
  filter: JournalFilter = {},
): Promise<JournalLine[]> {
  const lines: JournalLine[] = []
  let hasScopeColumns = true
  let hasTagsTables = Boolean(filter.includeTags)

  for (let offset = 0; ; offset += PAGE) {
    const build = () => {
      let q = admin
        .from('cashbook_entries')
        .select(buildSelect(hasScopeColumns, hasTagsTables))
        .is('deleted_at', null)
        .order('entry_date', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + PAGE - 1)
      if (filter.from) q = q.gte('entry_date', filter.from)
      if (filter.to) q = q.lte('entry_date', filter.to)
      if (hasScopeColumns && filter.scope === 'untriaged') q = q.is('scope', null)
      else if (hasScopeColumns && filter.scope) q = q.eq('scope', filter.scope)
      return q
    }

    let { data, error } = await build()

    // Degrade at most once per axis, then retry the same page.
    if (error && hasScopeColumns && isMissingColumn(error)) {
      hasScopeColumns = false
      if (filter.scope && filter.scope !== 'untriaged') return []   // no real scope data exists
      ;({ data, error } = await build())
    }
    if (error && hasTagsTables && isMissingRelation(error)) {
      hasTagsTables = false
      ;({ data, error } = await build())
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

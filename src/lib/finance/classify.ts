/**
 * Finance Engine — scope classification.
 *
 * `scope` is the first-class financial dimension that replaces the implicit
 * "internal = client_id IS NULL" convention:
 *
 *   'client'  — the record flows through to a client's economics
 *               (invoicing, rebilling, client profitability)
 *   'company' — Cirqle's own operations (feeds the Company P&L)
 *
 * The database owns final derivation via BEFORE INSERT/UPDATE triggers
 * (migration 20260714090000_finance_scope_foundation), so legacy writers stay
 * correct even when they don't send scope. App code still sets scope
 * explicitly at write time — these helpers keep every writer consistent with
 * the trigger's rules, and provide the tolerance shim for databases where the
 * migration hasn't been applied yet.
 */

export type FinanceScope = 'client' | 'company'

export const FINANCE_SCOPES: readonly FinanceScope[] = ['client', 'company'] as const

export const SCOPE_LABELS: Record<FinanceScope, string> = {
  client: 'Client',
  company: 'Company (Cirqle)',
}

/** Work items (tasks, ad campaigns): having a client makes it client work. */
export function deriveWorkScope(clientId: string | null | undefined): FinanceScope {
  return clientId ? 'client' : 'company'
}

/**
 * Cashbook entries: mirrors trg_derive_cashbook_scope exactly.
 * Returns null when the money is ambiguous — the entry stays untriaged and
 * surfaces in the Company Ops triage queue instead of being guessed at.
 */
export function deriveEntryScope(input: {
  clientId?: string | null
  employeeId?: string | null
  transferRef?: string | null
  reference?: string | null
  categoryDefaultScope?: string | null
}): FinanceScope | null {
  if (input.clientId) return 'client'
  if (input.employeeId) return 'company'
  if (input.transferRef) return 'company'
  if (input.reference && input.reference.startsWith('payroll:')) return 'company'
  if (input.categoryDefaultScope === 'company') return 'company'
  return null
}

/**
 * True when a write failed only because the `scope` column doesn't exist yet
 * (the Phase-1 migration hasn't been applied). PostgREST reports unknown
 * insert/update columns as PGRST204 ("Could not find the 'scope' column …");
 * raw Postgres uses 42703 ('column "scope" … does not exist').
 */
export function isScopeColumnMissing(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false
  if (error.code !== 'PGRST204' && error.code !== '42703') return false
  return /(['"])scope\1/.test(error.message ?? '')
}

/** Copy of a row without its scope key, for the pre-migration retry. */
export function withoutScope<T extends object>(row: T): Omit<T, 'scope'> {
  const { scope: _scope, ...rest } = row as T & { scope?: unknown }
  return rest
}

type PgWriteResult = { error: { code?: string | null; message?: string | null } | null }

/**
 * Run a Supabase write that includes `scope`; if the database predates the
 * scope migration, retry once with scope stripped so the write still lands
 * (matching the repo's safeQuery/columnExists philosophy: unapplied
 * migrations degrade features, never break writes).
 *
 *   const { data, error } = await retryWithoutScope(strip =>
 *     admin.from('cashbook_entries')
 *       .insert(strip ? withoutScope(row) : row)
 *       .select(SELECT))
 */
export async function retryWithoutScope<R extends PgWriteResult>(
  attempt: (stripScope: boolean) => PromiseLike<R>,
): Promise<R> {
  const first = await attempt(false)
  if (isScopeColumnMissing(first.error)) return attempt(true)
  return first
}

// rls: browser-client
/**
 * Where the browser reads task prices and contribution earnings from.
 *
 * THE PROBLEM
 * `tasks` and `contribution_scores` are readable by every signed-in employee
 * (their RLS read rule is "is signed in"), and the app strips the money only on
 * the way to the screen. So anyone could open the browser console and read
 * every task's price and every colleague's earnings straight from the API.
 *
 * THE FIX, in three steps
 *   1. 20261116110000_work_money_views adds two read-only views,
 *      `tasks_priced` and `contribution_scores_priced`. They return rows only
 *      to someone holding a money permission (see can_see_work_money()).
 *   2. Every browser read that needs a price or earnings goes through
 *      `viaPriced()` below, so it uses those views.
 *   3. 20261116120000_work_money_column_grants then withholds the money
 *      columns of the two base tables from `authenticated`. After that the
 *      plain tables never hand a price to the browser, whoever asks.
 *
 * Declared for scripts/rls-keep-list.mjs, which derives the browser's grants
 * from the relations it reads: .from('tasks_priced') .from('contribution_scores_priced')
 *
 * The fallback: until step 1 is applied the views do not exist, so a read
 * that fails with "relation not found" is retried on the base tables. That
 * keeps this code safe to deploy before the migrations, and stops being used
 * once they are applied. Never apply step 3 before step 1.
 */

export interface PricedSource {
  /** Task rows including price columns. */
  readonly tasks: 'tasks_priced' | 'tasks'
  /** Contribution scores including earnings_inr. */
  readonly scores: 'contribution_scores_priced' | 'contribution_scores'
}

export const PRICED: PricedSource = { tasks: 'tasks_priced', scores: 'contribution_scores_priced' }
const BASE: PricedSource = { tasks: 'tasks', scores: 'contribution_scores' }

interface QueryError { code?: string; message?: string }

/**
 * True only for "this relation or relationship does not exist yet" — the one
 * failure the fallback is for. Anything else (a real permission error, a bad
 * filter) is returned to the caller unchanged.
 */
export function isMissingPricedSource(error: QueryError | null | undefined): boolean {
  if (!error) return false
  // 42P01 undefined_table; PGRST205 table not in the schema cache;
  // PGRST200 relationship not found (an embed through a missing view).
  if (error.code === '42P01' || error.code === 'PGRST205' || error.code === 'PGRST200') return true
  const msg = error.message ?? ''
  return /(tasks_priced|contribution_scores_priced)/.test(msg)
    && /(does not exist|could not find|schema cache)/i.test(msg)
}

/**
 * Run a browser query against the priced views, falling back to the base
 * tables while the views are not there yet.
 *
 *   const { data } = await viaPriced(src =>
 *     supabase.from(src.tasks).select('id, billing_amount_inr').eq('id', id))
 */
export async function viaPriced<R extends { error: QueryError | null }>(
  run: (src: PricedSource) => PromiseLike<R>,
): Promise<R> {
  const first = await run(PRICED)
  if (isMissingPricedSource(first.error)) return run(BASE)
  return first
}

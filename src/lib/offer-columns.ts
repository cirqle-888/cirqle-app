/**
 * Column lists that only exist once the offer-groups migration
 * (20260719090000) has been applied.
 *
 * Adding a not-yet-existing column to a PostgREST select doesn't degrade — it
 * fails the whole query with 42703, so a page that lists clients would render
 * an empty list rather than an error. That is a bad way to find out the
 * migration hasn't run, so read paths ask for the new columns and quietly retry
 * without them.
 *
 * Write paths deliberately do NOT use this: a save that silently dropped the
 * category would be worse than a save that fails with a clear message.
 */

/** PostgREST code for "column does not exist". */
const UNDEFINED_COLUMN = '42703'

export function isMissingColumnError(error: { code?: string } | null | undefined): boolean {
  return error?.code === UNDEFINED_COLUMN
}

/**
 * Run a select with the post-migration columns, falling back to the pre-migration
 * ones if they aren't there yet.
 *
 * @param run called with the column list to select
 */
export async function selectWithOptionalColumns<T>(
  baseColumns: string,
  extraColumns: string[],
  // Supabase query builders are thenables rather than real Promises, so this is
  // typed as PromiseLike to accept them directly.
  run: (columns: string) => PromiseLike<{ data: T | null; error: { code?: string } | null }>,
): Promise<T | null> {
  const full = [baseColumns, ...extraColumns].join(', ')
  const first = await run(full)
  if (!first.error) return first.data
  if (!isMissingColumnError(first.error)) return first.data
  const fallback = await run(baseColumns)
  return fallback.data
}

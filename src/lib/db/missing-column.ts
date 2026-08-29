/**
 * Writes that name a column the database may not have yet.
 *
 * This repo's migrations are applied by hand, so there is always a window where
 * the code knows about a column and the database does not. A write that fails in
 * that window is the worst outcome: the task simply does not save, and the
 * person loses their work over a feature they were not using.
 *
 * So the rule everywhere is: attempt the write with the new column, and if the
 * database says it has never heard of it, retry once without. The feature
 * degrades; nothing breaks. (Reads take the other route — `columnExists`, which
 * caches, because a select cannot be retried as cheaply.)
 */

export type PgError = { code?: string | null; message?: string | null } | null | undefined

/**
 * Is this error specifically "that column does not exist"?
 *
 * Narrow on purpose. PGRST204 / 42703 are the only two codes that mean a
 * missing column, and the column's name must appear in the message — otherwise
 * a constraint violation that happens to mention the column would be retried
 * as though the schema were old, and the real error swallowed.
 */
export function isMissingColumn(error: PgError, column: string): boolean {
  if (!error) return false
  if (error.code !== 'PGRST204' && error.code !== '42703') return false
  return new RegExp(`\\b${column}\\b`).test(error.message ?? '')
}

/** Copy of a row without one key, for the retry. */
export function withoutColumn<T extends object>(row: T, column: string): Partial<T> {
  const rest = { ...row } as Record<string, unknown>
  delete rest[column]
  return rest as Partial<T>
}

type PgWriteResult = { error: PgError }

/**
 * Run a write that names `column`; retry once without it if the database has
 * not got it yet.
 *
 *   const { data, error } = await retryWithoutColumn('no_charge_reason', strip =>
 *     admin.from('tasks').update(strip ? withoutColumn(row, 'no_charge_reason') : row))
 */
export async function retryWithoutColumn<R extends PgWriteResult>(
  column: string,
  attempt: (strip: boolean) => PromiseLike<R>,
): Promise<R> {
  const first = await attempt(false)
  if (isMissingColumn(first.error, column)) return attempt(true)
  return first
}

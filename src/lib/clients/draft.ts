/**
 * Draft (trial) clients — see supabase/migrations/20261003100000_draft_clients.sql.
 *
 * A draft client can be planned for, requested for and assigned work, but is
 * kept out of invoice generation until someone with clients.create /
 * settings.access approves it on the Clients page.
 */

/**
 * Run a `clients` select with `, is_draft` appended, falling back to the
 * plain select when the column doesn't exist yet (migration not applied).
 * Pages keep working either way; before the migration nothing is a draft.
 */
export async function withDraftFlag<R extends { error: { message?: string } | null }>(
  run: (extraCols: string) => PromiseLike<R>,
): Promise<R> {
  const res = await run(', is_draft')
  if (res.error && /is_draft/i.test(res.error.message || '')) return run('')
  return res
}

/** Picker sub-label: the client code, plus a visible "Draft" marker. */
export function clientPickerSub(c: { code?: string | null; is_draft?: boolean | null }): string | undefined {
  if (c.is_draft) return c.code ? `${c.code} · Draft (trial)` : 'Draft (trial)'
  return c.code ?? undefined
}

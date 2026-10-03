/**
 * What an edit form may write to `clients`.
 *
 * Forms are seeded by spreading a client row that was loaded for DISPLAY, so
 * the payload carries things that are not columns of `clients` and things that
 * are columns but must not be written back from a stale copy:
 *
 *  - embedded relations (`service_pricings`, `draft_creator`) — PostgREST
 *    rejects the write outright ("Could not find the 'draft_creator' column of
 *    'clients'"). That is exactly how saving an edit on the Clients list broke
 *    the day the draft-clients embed was added to its query.
 *  - identity and timestamps (`id`, `created_at`, `updated_at`) — writing an
 *    old copy back makes the row look older than it is.
 *  - draft state (`is_draft`, `draft_note`, `draft_created_at`,
 *    `draft_created_by`) — changed only by the draft actions. A form opened
 *    before someone approved the client would otherwise silently turn it back
 *    into a draft on save.
 *
 * Strip by NAME, not by value shape: `integrations` is a real JSON column, so
 * "drop every object" would delete data. A new embed needs adding here — the
 * test pins the ones that have bitten.
 */
const NOT_WRITABLE = new Set([
  'service_pricings',
  'draft_creator',
  'id',
  'created_at',
  'updated_at',
  'is_draft',
  'draft_note',
  'draft_created_at',
  'draft_created_by',
])

export function sanitizeClientForm(form: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(form).filter(([key]) => !NOT_WRITABLE.has(key)))
}

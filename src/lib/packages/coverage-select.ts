/**
 * The task columns package coverage reads — in one place, because five surfaces
 * ask the same question and any of them left behind would disagree with the
 * invoice about what a package has delivered.
 *
 * `package_counts_as_service_id` arrives with migration 20260829170000. Naming a
 * column that does not exist yet fails the whole query, and a Packages page that
 * silently reports nothing delivered is worse than one without substitutions —
 * so the column is probed once per server lifetime (columnExists caches) and
 * simply left out until the migration lands.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { columnExists } from '@/lib/supabase/server'

/** Columns every coverage caller needs. */
const BASE = 'id, package_id, service_id, task_date, task_number, status'

/**
 * `BASE` (plus any `extra` columns the caller renders) with the substitution
 * column appended when the database has it.
 */
export async function coverageTaskColumns(
  admin: SupabaseClient,
  extra?: string,
): Promise<string> {
  const hasSubstitution = await columnExists(admin, 'tasks', 'package_counts_as_service_id')
  return [BASE, extra, hasSubstitution ? 'package_counts_as_service_id' : '']
    .filter(Boolean)
    .join(', ')
}

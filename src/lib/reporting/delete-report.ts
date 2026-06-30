/**
 * Shared report deletion — removes a report's storage objects and its DB row.
 * Used by the manual delete (Reports tab) and the retention cleanup cron, so
 * both behave identically. ad_report_analytics rows cascade on row delete.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const BUCKET = 'ad-reports'
// Folder slugs uploadExport() writes under reports/{id}/ — one per format.
const FORMAT_SLUGS = ['pdf', 'xlsx', 'csv', 'image-portrait', 'image-square']

export interface DeleteReportResult {
  filesRemoved: number
  error?: string
}

/**
 * Deletes every storage object under reports/{id}/ then the ad_reports row.
 * Never throws — returns an error string instead so callers can keep going.
 */
export async function deleteReportStorageAndRow(
  admin: SupabaseClient,
  reportId: string,
): Promise<DeleteReportResult> {
  // 1. Collect + remove storage objects.
  const paths: string[] = []
  for (const slug of FORMAT_SLUGS) {
    const { data: files } = await admin.storage.from(BUCKET).list(`reports/${reportId}/${slug}`)
    for (const f of files ?? []) {
      if (f.name) paths.push(`reports/${reportId}/${slug}/${f.name}`)
    }
  }
  let filesRemoved = 0
  if (paths.length > 0) {
    const { error } = await admin.storage.from(BUCKET).remove(paths)
    if (!error) filesRemoved = paths.length
  }

  // 2. Delete the row (analytics cascade).
  const { error: delErr } = await admin.from('ad_reports').delete().eq('id', reportId)
  if (delErr) return { filesRemoved, error: delErr.message }
  return { filesRemoved }
}

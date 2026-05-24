import { createAdminClient } from '@/lib/supabase/server'

// 100 UUIDs × 37 chars ≈ 3,700 chars in the IN clause, keeping total URL well under 8KB.
export const TASK_FETCH_CHUNK = 100

/**
 * Fetches tasks by their IDs in chunks to avoid PostgREST URL length limits.
 * Uses Promise.all to fetch chunks concurrently.
 * Deduplicates results and sorts by task_number descending.
 * 
 * @param supabase The Supabase admin client
 * @param taskIds Array of UUIDs to fetch
 * @param baseSelect The select string to use
 * @param applyFilters Optional callback to apply additional filters (e.g. status, deleted_at)
 */
export async function fetchTasksByIdsChunked(
  supabase: ReturnType<typeof createAdminClient>,
  taskIds: string[],
  baseSelect: string,
  applyFilters?: (q: any) => any
) {
  if (!taskIds || taskIds.length === 0) {
    return { data: [], error: null }
  }

  // Safety logging
  if (taskIds.length > 5000) {
    console.warn(`[PERF WARNING] employee task resolution exceeded safe threshold: ${taskIds.length} tasks`)
  }

  // Deduplicate incoming IDs
  const uniqueIds = Array.from(new Set(taskIds))
  const chunks: string[][] = []

  for (let i = 0; i < uniqueIds.length; i += TASK_FETCH_CHUNK) {
    chunks.push(uniqueIds.slice(i, i + TASK_FETCH_CHUNK))
  }

  try {
    const chunkPromises = chunks.map(chunk => {
      let q = supabase
        .from('tasks')
        .select(baseSelect)
        .in('id', chunk)

      if (applyFilters) {
        q = applyFilters(q)
      }

      return q
    })

    const results = await Promise.all(chunkPromises)

    const taskMap = new Map<string, any>()
    let firstError: any = null
    let failedChunks = 0

    for (const res of results) {
      if (res.error) {
        failedChunks++
        if (!firstError) firstError = res.error
        // Continue collecting from successful chunks — a partial result is better
        // than silently returning empty when only one shard fails.
        continue
      }
      if (res.data) {
        for (const task of res.data as any[]) {
          if (!taskMap.has(task.id)) {
            taskMap.set(task.id, task)
          }
        }
      }
    }

    if (failedChunks > 0) {
      console.error(`[fetchTasksByIdsChunked] ${failedChunks}/${chunks.length} chunk(s) failed`)
      // If ALL chunks failed, surface the error so the caller can handle it.
      if (taskMap.size === 0) {
        return { data: null, error: firstError }
      }
      // Partial failure — return what we have; caller logs the discrepancy.
    }

    const mergedTasks = Array.from(taskMap.values())

    // Stable sort by task_number descending (nulls sort to the end).
    mergedTasks.sort((a, b) => {
      const numA = typeof a.task_number === 'number' ? a.task_number : -1
      const numB = typeof b.task_number === 'number' ? b.task_number : -1
      return numB - numA
    })

    return { data: mergedTasks, error: null }
  } catch (err: any) {
    console.error('[fetchTasksByIdsChunked] unhandled exception')
    return { data: null, error: err }
  }
}

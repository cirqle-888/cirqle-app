'use client'

/**
 * Retainer coverage lookup for task editing surfaces — one hook, one fetch rule.
 *
 * Every surface that can set a task's price needs the same answer to "is this
 * client + service + date already paid for by a retainer?". Keeping the fetch
 * here means a surface cannot accidentally ship without it, which is exactly how
 * the Edit Task modal ended up unable to save a covered task at all.
 */

import { useEffect, useState } from 'react'
import { fetchRetainerCoverage } from '@/app/(dashboard)/dashboard/tasks/actions'
import type { RetainerCoverageInfo } from '@/lib/agreements/coverage'

export function useRetainerCoverage(
  clientId: string | null | undefined,
  serviceId: string | null | undefined,
  taskDate: string | null | undefined,
): RetainerCoverageInfo | null {
  const [coverage, setCoverage] = useState<RetainerCoverageInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    const lookup = !clientId || !serviceId
      ? Promise.resolve(null)
      : fetchRetainerCoverage(clientId, serviceId, taskDate || '').catch(() => null)
    lookup.then(c => { if (!cancelled) setCoverage(c) })
    return () => { cancelled = true }
  }, [clientId, serviceId, taskDate])

  return coverage
}

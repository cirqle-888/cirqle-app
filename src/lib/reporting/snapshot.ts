import { createHash } from 'node:crypto'
import type { ReportConfig, RenderData } from './types'

/** Transport/recipient choices do not change reviewed report content. */
export function snapshotFingerprint(config: ReportConfig): string {
  const { recipients: _recipients, generatedBy: _by, reportId: _id, snapshotId: _snapshot, allowIncomplete: _draft, ...content } = config
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) :
    v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, stable(value)])) : v
  return createHash('sha256').update(JSON.stringify(stable(content))).digest('hex')
}

export function snapshotProblem(data: RenderData): string | null {
  const q = data.dataQuality
  if (q?.lastSyncError) return 'The last sync failed. Sync again or prepare an explicitly incomplete draft.'
  if (q && q.missingCount > 0) return `${q.missingCount} reporting days have no data. Sync again or prepare an explicitly incomplete draft.`
  const coverage = data.kpi.derived.resultCoverage
  if (coverage && coverage.recordedDays < coverage.days) return 'Some selected result metrics have not been recorded. Sync again or prepare an incomplete draft.'
  return null
}

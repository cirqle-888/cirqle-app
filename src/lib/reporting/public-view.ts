import { createHash, randomBytes } from 'node:crypto'
import type { RenderData } from './types'
import { buildShareCaption } from './share-caption'
export function issueReportToken() {
  const token = randomBytes(32).toString('hex')
  return { token, hash: hashReportToken(token) }
}
export function hashReportToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
export function publicReportView(data: RenderData) {
  // Explicit allowlist: no recipients, wallets, benchmarks, internal AI, tokens,
  // staff identities, database keys, or raw render snapshots leave this function.
  return {
    client: data.project.clientName, title: data.project.campaignName,
    from: data.config.dateFrom, to: data.config.dateTo,
    caption: buildShareCaption(data),
    campaigns: (data.campaigns ?? []).map(c => ({ name: c.campaignName, spend: c.spend,
      resultLabel: c.resultLabel, results: c.results, costPerResult: c.costPerResult })),
  }
}
export function reportShareAllowed(report: { status: string; review_status: string }, share: { expires_at: string; revoked_at: string | null }, now = Date.now()) {
  return report.status === 'ready' && report.review_status === 'approved'
    && !share.revoked_at && Number.isFinite(Date.parse(share.expires_at)) && Date.parse(share.expires_at) > now
}

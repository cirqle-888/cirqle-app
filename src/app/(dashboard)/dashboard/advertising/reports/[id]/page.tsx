import Link from 'next/link'
import { ReportReview } from '@/components/reporting/report-review'
import { ManualReportShare } from '@/components/reporting/manual-share'
import { buildShareCaption } from '@/lib/reporting/share-caption'
import { ReportProgress } from '@/components/reporting/report-progress'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import WebReportViewer from '../components/WebReportViewer'
import type { RenderData, ReportFormat } from '@/lib/reporting/types'

export const dynamic = 'force-dynamic'

export default async function InteractiveReportPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await loadCurrentUser().catch(() => null)
  if (!me || (!me.isAdmin && !hasPermission(me, 'advertising.view_reports'))) {
    throw new Error('Unauthorized')
  }

  const { id } = await params
  const admin = createAdminClient()

  const { data: report } = await admin
    .from('ad_reports')
    .select('render_data, status, pdf_url, image_url_portrait, image_url_square, review_status, image_bundle_url, config, delivery_results')
    .eq('id', id)
    .single()

  if (!report) notFound()
  if (!['ready', 'partial'].includes(report.status) || !report.render_data) {
    return <ReportProgress reportId={id} canRetry={me.isAdmin || hasPermission(me, 'advertising.edit')} />
  }

  const renderData = report.render_data as unknown as RenderData

  return (
    <div className="min-h-screen bg-muted/20">
      <div className="border-b border-border bg-background px-6 py-4 flex items-center justify-between">
        <h1 className="font-medium text-foreground">Report Interactive View</h1>
        <Link
          href="/dashboard/advertising/reports"
          className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          Back to Reports Hub
        </Link>
      </div>
      {report.status === 'partial' && <ReportProgress reportId={id} canRetry={me.isAdmin || hasPermission(me, 'advertising.edit')} />}
      {(me.isAdmin || hasPermission(me, 'advertising.edit')) && <ReportReview reportId={id} reviewStatus={report.review_status ?? 'unreviewed'} recipients={(report.config?.recipients ?? []).map((r: { email: string }) => r.email)} delivery={report.delivery_results ?? []} summary={renderData.ai.executiveSummary} />}
      <ManualReportShare reportId={id} caption={buildShareCaption(renderData)} formats={[
        ...(report.image_bundle_url ? ['image_bundle' as ReportFormat] : []),
        ...(report.pdf_url ? ['pdf' as ReportFormat] : []),
        ...(report.image_url_portrait ? ['image_portrait' as ReportFormat] : []),
        ...(report.image_url_square ? ['image_square' as ReportFormat] : []),
      ]} />
      <WebReportViewer data={renderData} />
    </div>
  )
}

import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import WebReportViewer from '../components/WebReportViewer'
import type { RenderData } from '@/lib/reporting/types'

export const dynamic = 'force-dynamic'

export default async function InteractiveReportPage({ params }: { params: { id: string } }) {
  const me = await loadCurrentUser().catch(() => null)
  if (!me || (!me.isAdmin && !hasPermission(me, 'advertising.view_reports'))) {
    throw new Error('Unauthorized')
  }

  const admin = createAdminClient()

  const { data: report } = await admin
    .from('ad_reports')
    .select('render_data, status')
    .eq('id', params.id)
    .single()

  if (!report || report.status !== 'ready' || !report.render_data) {
    notFound()
  }

  const renderData = report.render_data as unknown as RenderData

  return (
    <div className="min-h-screen bg-muted/20">
      <div className="border-b border-border bg-background px-6 py-4 flex items-center justify-between">
        <h1 className="font-medium text-foreground">Report Interactive View</h1>
        <a 
          href="/dashboard/advertising/reports" 
          className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          Back to Reports Hub
        </a>
      </div>
      <WebReportViewer data={renderData} />
    </div>
  )
}

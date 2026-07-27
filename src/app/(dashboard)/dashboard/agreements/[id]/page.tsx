import { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadClientMonthProgress } from '@/lib/agreements/server'
import { AGREEMENT_STATUS_CHIP, STATUS_LABEL } from '@/lib/agreements/types'
import { ArrowLeft, Calendar, FileSignature } from 'lucide-react'

export const metadata: Metadata = {
  title: 'Agreement Detail | Cirqle',
}

export default async function AgreementDetailPage({
  params,
}: {
  params: { id: string }
}) {
  const supabase = await createAdminClient()
  
  const { data: agreement } = await supabase
    .from('client_agreements')
    .select(`
      *,
      client:clients(id, name, default_currency)
    `)
    .eq('id', params.id)
    .is('deleted_at', null)
    .single()
    
  if (!agreement) {
    notFound()
  }

  // Load progress for current month
  const currentMonth = new Date().toISOString().slice(0, 7)
  let progress: any[] = []
  
  try {
    progress = await loadClientMonthProgress(agreement.client_id, currentMonth)
  } catch (err) {
    console.error('Failed to load progress', err)
  }
  
  const currentProgress = progress.find(p => p.agreementId === agreement.id)

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8 max-w-7xl mx-auto w-full">
      <div className="flex items-center gap-4 text-sm">
        <Link 
          href="/dashboard/agreements" 
          className="flex items-center text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to Agreements
        </Link>
      </div>
      
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              {agreement.title}
            </h1>
            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${AGREEMENT_STATUS_CHIP[agreement.status]}`}>
              {STATUS_LABEL[agreement.status] || agreement.status}
            </span>
          </div>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <span>{agreement.agreement_number}</span>
            <span>•</span>
            <span>{agreement.client?.name}</span>
            <span>•</span>
            <span className="flex items-center">
              <Calendar className="w-3.5 h-3.5 mr-1" />
              {agreement.start_date} &rarr; {agreement.end_date || 'Ongoing'}
            </span>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          {/* Action buttons will go here */}
        </div>
      </div>
      
      {/* Progress Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-card border rounded-xl p-6 shadow-sm">
          <div className="text-sm font-medium text-muted-foreground mb-1">Committed ({currentMonth})</div>
          <div className="text-3xl font-bold">{currentProgress?.totalCommitted || 0}</div>
        </div>
        <div className="bg-card border rounded-xl p-6 shadow-sm">
          <div className="text-sm font-medium text-muted-foreground mb-1">Planned</div>
          <div className="text-3xl font-bold text-blue-600">{currentProgress?.totalPlanned || 0}</div>
        </div>
        <div className="bg-card border rounded-xl p-6 shadow-sm">
          <div className="text-sm font-medium text-muted-foreground mb-1">Delivered</div>
          <div className="text-3xl font-bold text-green-600">{currentProgress?.totalDelivered || 0}</div>
        </div>
        <div className="bg-card border rounded-xl p-6 shadow-sm">
          <div className="text-sm font-medium text-muted-foreground mb-1">Remaining</div>
          <div className="text-3xl font-bold text-amber-600">{currentProgress?.totalRemaining || 0}</div>
        </div>
      </div>
      
      {/* Items List */}
      <div className="rounded-xl border bg-card text-card-foreground shadow-sm">
        <div className="p-6 border-b flex justify-between items-center">
          <h3 className="font-semibold text-lg flex items-center gap-2">
            <FileSignature className="w-5 h-5 text-muted-foreground" />
            Agreement Items
          </h3>
        </div>
        <div className="p-6 text-center text-muted-foreground py-12">
          <p>Phase 1 Implementation - UI components for adding/editing items will be implemented here.</p>
        </div>
      </div>
    </div>
  )
}

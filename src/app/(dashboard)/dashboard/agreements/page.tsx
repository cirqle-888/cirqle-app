import { Metadata } from 'next'
import Link from 'next/link'
import { loadAgreementOverview } from '@/lib/agreements/server'
import { AGREEMENT_STATUS_CHIP, STATUS_LABEL } from '@/lib/agreements/types'
import { FileSignature, Plus } from 'lucide-react'

export const metadata: Metadata = {
  title: 'Client Agreements | Cirqle',
}

export default async function AgreementsPage({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined }
}) {
  // Defensive read (try/catch logic for when migration isn't applied)
  let agreements: any[] = []
  let errorMsg = null
  
  try {
    agreements = await loadAgreementOverview({})
  } catch (err: any) {
    console.error('Failed to load agreements', err)
    errorMsg = 'Agreements module is not fully initialized. Please ensure migrations are applied.'
  }

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8 max-w-7xl mx-auto w-full">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <FileSignature className="w-6 h-6 text-muted-foreground" />
            Client Agreements
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage long-term commitments, retainers, and package deliverables.
          </p>
        </div>
        
        <button className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2">
          <Plus className="w-4 h-4 mr-2" />
          New Agreement
        </button>
      </div>
      
      {errorMsg ? (
        <div className="bg-destructive/10 text-destructive text-sm p-4 rounded-md border border-destructive/20">
          {errorMsg}
        </div>
      ) : agreements.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center border rounded-xl border-dashed bg-muted/30">
          <FileSignature className="w-12 h-12 text-muted-foreground/50 mb-4" />
          <h3 className="text-lg font-medium text-foreground">No agreements found</h3>
          <p className="text-muted-foreground mt-2 max-w-sm">
            You don't have any client agreements yet. Create one to start tracking retainers and packages.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-muted/50 text-muted-foreground border-b text-xs uppercase">
                <tr>
                  <th className="px-6 py-3 font-medium">Agreement</th>
                  <th className="px-6 py-3 font-medium">Client</th>
                  <th className="px-6 py-3 font-medium">Term</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                  <th className="px-6 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {agreements.map((agr) => (
                  <tr key={agr.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-6 py-4">
                      <Link href={`/dashboard/agreements/${agr.id}`} className="font-medium hover:underline">
                        {agr.title}
                      </Link>
                      <div className="text-xs text-muted-foreground mt-1">{agr.agreement_number}</div>
                    </td>
                    <td className="px-6 py-4">
                      {agr.client?.name || 'Unknown'}
                    </td>
                    <td className="px-6 py-4 text-muted-foreground">
                      {agr.start_date} &rarr; {agr.end_date || 'Ongoing'}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${AGREEMENT_STATUS_CHIP[agr.status]}`}>
                        {STATUS_LABEL[agr.status] || agr.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <Link 
                        href={`/dashboard/agreements/${agr.id}`}
                        className="text-primary hover:underline font-medium text-sm"
                      >
                        View Details
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

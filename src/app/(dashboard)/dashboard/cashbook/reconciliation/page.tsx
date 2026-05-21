import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ReconciliationClient from './reconciliation-client'

export const metadata = { title: 'Reconciliation Toolkit | Cirqle' }

export default async function ReconciliationPage() {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) redirect('/login')

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6 pb-24 overflow-y-auto">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Reconciliation Toolkit</h2>
          <p className="text-muted-foreground text-sm mt-1">
            Admin utilities for identifying orphaned payments and auditing mathematical integrity between cashbook and invoices.
          </p>
        </div>
      </div>
      
      <ReconciliationClient />
    </div>
  )
}

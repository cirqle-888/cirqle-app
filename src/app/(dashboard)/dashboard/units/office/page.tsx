import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import Header from '@/components/layout/header'
import { loadOfficeTeam } from '@/lib/units/office-load'
import { NotInstalled } from '../_not-installed'
import { ROOT, requireDepartmentSharesPage } from '../_page'
import { OfficeTeam } from './office-client'

export const dynamic = 'force-dynamic'

/**
 * Office team — Cirqle's own staff (the parent company, not a unit): who is on
 * it, and what each person can open. Admin only. People by CQID only.
 */
export default async function OfficePage({ searchParams }: { searchParams: Promise<{ person?: string }> }) {
  const { admin, installed } = await requireDepartmentSharesPage()
  const header = <Header title="Office team" subtitle="Cirqle's own staff — who they are and what each person can open." crumbLabel="Office team" />
  if (!installed) return <>{header}<div className="mx-auto max-w-6xl px-4 py-6 md:px-6"><NotInstalled /></div></>
  const [data, sp] = await Promise.all([loadOfficeTeam(admin), searchParams])
  return (
    <>
      {header}
      <div className="mx-auto max-w-6xl space-y-5 px-4 py-6 md:px-6">
        <div className="flex flex-wrap items-center gap-4 text-xs">
          <Link href={`${ROOT}/hq`} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"><ArrowLeft className="h-3.5 w-3.5" /> Cirqle HQ</Link>
          <Link href={`${ROOT}/access`} className="text-primary hover:underline">Access map (clients and units) →</Link>
          <Link href="/dashboard/settings/chat-access" className="text-primary hover:underline">Chat access →</Link>
        </div>
        <OfficeTeam {...data} initialPerson={sp.person ?? null} />
      </div>
    </>
  )
}

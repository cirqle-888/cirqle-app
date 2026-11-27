import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import Header from '@/components/layout/header'
import { loadAccessMap } from '@/lib/units/access-map'
import { NotInstalled } from '../_not-installed'
import { ROOT, requireDepartmentSharesPage } from '../_page'
import { AccessMap } from './access-client'

export const dynamic = 'force-dynamic'

/**
 * Access map — one place for who reaches which part of Cirqle: which people
 * are on which unit, which clients belong where (and which are mixed), and
 * exactly what one person will see. Admin only.
 */
export default async function AccessMapPage() {
  const { admin, installed } = await requireDepartmentSharesPage()
  const header = <Header title="Access map" subtitle="Who is on which unit, which clients belong where, and what each person sees." crumbLabel="Access map" />
  if (!installed) return <>{header}<div className="mx-auto max-w-6xl px-4 py-6 md:px-6"><NotInstalled /></div></>

  const map = await loadAccessMap(admin)
  return (
    <>
      {header}
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-6 md:px-6">
        <Link href={ROOT} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="h-3.5 w-3.5" /> Departments &amp; Brands</Link>
        <AccessMap
          units={map.units.filter(u => u.isActive).map(u => ({ id: u.id, name: u.name, color: u.color, kind: u.kind, hasWork: u.categoryIds.length > 0 }))}
          departments={map.departments}
          people={map.people}
          clients={map.clients}
          designationsWithoutReach={map.designationsWithoutReach}
        />
      </div>
    </>
  )
}

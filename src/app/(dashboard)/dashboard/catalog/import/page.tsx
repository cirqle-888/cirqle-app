import { resolveCurrentEmployeeId } from '@/lib/permissions/check'
import { redirect } from 'next/navigation'
import ImportClient from './import-client'

export const dynamic = 'force-dynamic'

export default async function CatalogImportPage() {
  const empId = await resolveCurrentEmployeeId()
  if (!empId) redirect('/login')

  return <ImportClient />
}

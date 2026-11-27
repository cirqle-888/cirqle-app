import { notFound } from 'next/navigation'
import { loadDepartments } from '@/lib/units/load'
import { NotInstalled } from '../../_not-installed'
import { requireDepartmentSharesPage } from '../../_page'
import { FormPage } from '../../_form-page'

export const dynamic = 'force-dynamic'

export default async function EditDepartmentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { admin, me, installed } = await requireDepartmentSharesPage()
  if (!installed) return <div className="mx-auto max-w-6xl px-4 py-6 md:px-6"><NotInstalled /></div>
  const { slug } = await params
  const dept = (await loadDepartments(admin)).find(d => d.slug === slug)
  if (!dept) notFound()
  return <FormPage admin={admin} me={me} dept={dept} />
}

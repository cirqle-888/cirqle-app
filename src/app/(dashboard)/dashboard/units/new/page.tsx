import { NotInstalled } from '../_not-installed'
import { requireDepartmentSharesPage } from '../_page'
import { FormPage } from '../_form-page'

export const dynamic = 'force-dynamic'

export default async function NewDepartmentPage() {
  const { admin, me, installed } = await requireDepartmentSharesPage()
  if (!installed) return <div className="mx-auto max-w-6xl px-4 py-6 md:px-6"><NotInstalled /></div>
  return <FormPage admin={admin} me={me} dept={null} />
}

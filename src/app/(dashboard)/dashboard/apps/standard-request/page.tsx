import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import StandardRequestClient from './standard-request-client'

export const dynamic = 'force-dynamic'

export default async function IntakeLinksPage() {
  const me = await loadCurrentUser().catch(() => null)
  const allowed = (me?.isAdmin ?? true)
    || !!me?.permissions?.has('intake_links.manage')
    || !!me?.permissions?.has('agency_links.manage')
  if (me && !allowed) redirect('/dashboard')

  const admin = createAdminClient()

  // Defensive: tables may not exist until the portal migration is applied.
  let links: any[] = []
  let agencies: any[] = []
  let migrated = true
  try {
    const [linksRes, agenciesRes] = await Promise.all([
      admin.from('intake_links')
        .select('*, client:clients(id, name, code), agency:agencies(id, name)')
        .order('created_at', { ascending: false }),
      admin.from('agencies').select('*').eq('is_active', true).order('name'),
    ])
    if (linksRes.error || agenciesRes.error) migrated = false
    links = linksRes.data || []
    agencies = agenciesRes.data || []
  } catch { migrated = false }

  // drive_folder_link needs the v1.1 patch migration — fall back without it.
  let clients: any[] | null = null
  {
    const withDrive = await admin
      .from('clients').select('id, name, code, drive_folder_link').eq('is_active', true).order('name')
    if (!withDrive.error) clients = withDrive.data
    else {
      const basic = await admin
        .from('clients').select('id, name, code').eq('is_active', true).order('name')
      clients = basic.data
    }
  }

  return (
    <StandardRequestClient
      migrated={migrated}
      initialLinks={links}
      initialAgencies={agencies}
      clients={clients || []}
      appUrl={process.env.NEXT_PUBLIC_APP_URL || 'https://app.cirqle.work'}
    />
  )
}

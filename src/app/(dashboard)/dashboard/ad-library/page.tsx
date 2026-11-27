import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { cleanSavedAd, type AdFolder, type SavedAd } from '@/lib/ad-library/core'
import { signedMediaLinks, todayInIndia } from '@/lib/ad-library/server'
import AdLibraryClient from './ad-library-client'
import type { ConnectKeyRow } from './actions'

export const dynamic = 'force-dynamic'

/**
 * Ad Library — ads the team saved from facebook.com/ads/library with the
 * Cirqle Ad Saver Chrome extension: a swipe file of competitor and
 * inspiration ads, kept after Facebook takes them down (pictures and videos
 * are copied into a private bucket), sorted into folders and linked to clients.
 */
export default async function AdLibraryPage() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me || !hasPermission(me, PERMS.ADVERTISING_VIEW)) redirect('/dashboard')

  const admin = createAdminClient()
  const [ads, folders, clients, keys, people] = await Promise.all([
    admin.from('saved_ads').select('*').is('deleted_at', null).order('created_at', { ascending: false }).limit(1500),
    admin.from('ad_folders').select('id, name, sort').is('deleted_at', null).order('sort').order('name'),
    admin.from('clients').select('id, name').eq('is_active', true).order('name'),
    admin.from('ad_saver_keys').select('id, key_hint, label, created_at, last_used_at').eq('employee_id', me.employeeId).is('revoked_at', null).order('created_at', { ascending: false }),
    admin.from('employees').select('id, name:cqid'),
  ])

  // Probed, not assumed: safe to deploy before 20261123120000_ad_library runs.
  const notSetUp = !!(ads.error || folders.error || keys.error)
  const list: SavedAd[] = ((ads.data ?? []) as Record<string, unknown>[]).map(cleanSavedAd)
  const links = notSetUp ? {} : await signedMediaLinks(admin, list).catch(() => ({}))

  return (
    <AdLibraryClient
      ads={list}
      links={links}
      folders={(folders.data ?? []) as AdFolder[]}
      clients={((clients.data ?? []) as { id: string; name: string }[])}
      people={Object.fromEntries(((people.data ?? []) as { id: string; name: string }[]).map(p => [p.id, p.name]))}
      keys={(keys.data ?? []) as ConnectKeyRow[]}
      canEdit={hasPermission(me, PERMS.ADVERTISING_EDIT)}
      canDelete={hasPermission(me, PERMS.ADVERTISING_DELETE)}
      canConnect={hasPermission(me, PERMS.ADVERTISING_CREATE)}
      notSetUp={notSetUp}
      today={todayInIndia()}
    />
  )
}

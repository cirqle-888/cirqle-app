import { redirect } from 'next/navigation'
import Header from '@/components/layout/header'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { websiteSupabaseConfigured } from '@/lib/supabase/website-admin'
import { listShowcases } from '../../../showcase-actions'
import { listPortfolio } from '../../../actions'
import AreasClient from './areas-client'

export const dynamic = 'force-dynamic'

/**
 * Clickable areas for one presentation, on a screen of its own.
 *
 * This was a fieldset inside the Edit Presentation modal, which is the wrong
 * shape for the work: placing an outline accurately is a drawing job, and it
 * was being done in a 720px box with a form scrolling underneath it. Here the
 * artwork gets the window and the tools get a panel beside it.
 *
 * Nothing else about the presentation is editable here. Areas are saved on
 * their own (`saveShowcaseHotspots`), so this screen cannot overwrite a
 * description or a crop that somebody changed while it was open.
 */
export default async function PresentationAreasPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  // Editing areas is a write, so this is the manage permission rather than the
  // view one the portfolio list uses.
  if (me && !(isAdmin || hasPermission(me, PERMS.PORTFOLIO_MANAGE))) redirect('/dashboard/portfolio')
  if (!websiteSupabaseConfigured()) redirect('/dashboard/portfolio')

  const [showcaseRes, galleryRes] = await Promise.all([listShowcases(), listPortfolio()])
  const showcase = showcaseRes.ok ? showcaseRes.data?.find(s => s.id === id) : undefined
  if (!showcase) {
    return (
      <>
        <Header title="Presentation not found" crumbLabel="Clickable areas" />
        <div className="p-4 sm:p-6">
          <p className="text-sm text-muted-foreground">
            {showcaseRes.ok
              ? 'It may have been deleted since this link was opened.'
              : showcaseRes.error}
          </p>
        </div>
      </>
    )
  }

  // Flattened here rather than in the browser: the picker needs a label and a
  // path, and the gallery tree is a lot of rows to ship for two fields.
  const galleries = (galleryRes.data || []).flatMap(c => [
    { label: c.title, path: `/portfolio/${c.slug}` },
    ...c.brands
      .filter(b => b.items.some(i => i.published))
      .map(b => ({ label: `${c.title} / ${b.name}`, path: `/portfolio/${c.slug}/${b.slug}` })),
  ])

  return <AreasClient showcase={showcase} galleries={galleries} />
}

import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { redirect } from 'next/navigation'
import CaptureClient from './capture-client'

export const metadata = { title: 'AI Capture · Cirqle' }
export const dynamic = 'force-dynamic'

/**
 * AI Capture — paste (or forward from the desktop app) any snippet; the
 * Capture Engine classifies it, detects the client, and prepares a draft for
 * review before it commits to the right module.
 *
 * An offer list is detected but not parsed here: offers are prepared in Offer
 * Studio, so the review screen sends the user there (lib/capture/adapters/offer).
 */
export default async function CapturePage() {
  const me = await loadCurrentUser().catch(() => null)
  if (!hasPermission(me, PERMS.CAPTURE_USE)) redirect('/dashboard')
  return <CaptureClient />
}

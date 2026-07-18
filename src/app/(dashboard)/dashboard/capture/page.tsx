import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import CaptureClient from './capture-client'

export const metadata = { title: 'AI Capture · Cirqle' }
export const dynamic = 'force-dynamic'

/**
 * AI Capture — paste (or forward from the desktop app) any snippet; the
 * Capture Engine classifies it, detects the client, and prepares a draft for
 * review before it commits to the right module.
 *
 * Offer mode: employees dedicated to offer-flyer work (they hold `offer.prepare`
 * but not the broader `requests.view`) don't juggle invoices/tasks/etc. — their
 * pastes are always offer lists. For them, skip classification and the
 * "Choose a destination" step entirely and parse straight as an Offer.
 */
export default async function CapturePage() {
  const me = await loadCurrentUser().catch(() => null)
  const offerMode = !!me && !me.isAdmin
    && hasPermission(me, PERMS.OFFER_PREPARE)
    && !hasPermission(me, PERMS.REQUESTS_VIEW)
  return <CaptureClient offerMode={offerMode} />
}

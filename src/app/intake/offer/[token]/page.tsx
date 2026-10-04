/**
 * Retired client offer-intake link.
 *
 * Clients used to type their weekly offer list here. Since Oct 2026 offer
 * lists are prepared by the Cirqle team in Offer Studio (flyer.cirqle.work),
 * which pushes them into Cirqle through /api/figma/campaign — so this page no
 * longer reads or writes anything. It stays as a polite notice rather than a
 * 404 because these links were shared with clients and may still be
 * bookmarked or pinned in a WhatsApp chat.
 */

export const metadata = { title: 'Offer link · Cirqle' }

export default function RetiredOfferIntakePage() {
  return (
    <div className="min-h-dvh flex items-center justify-center p-6">
      <div className="text-center max-w-sm">
        <div className="text-4xl mb-4">📋</div>
        <h1 className="text-lg font-semibold mb-2">This offer link is no longer used</h1>
        <p className="text-sm text-muted-foreground">
          Please send your offer list to your Cirqle contact on WhatsApp, as usual. The team prepares the flyer from there.
        </p>
      </div>
    </div>
  )
}

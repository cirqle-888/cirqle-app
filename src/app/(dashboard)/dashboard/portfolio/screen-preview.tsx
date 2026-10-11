'use client'

import { DESKTOP_ASPECT, MOBILE_ASPECT, objectPosition, type ResolvedMedia } from '@/lib/portfolio/showcase'

interface Props {
  viewport: 'desktop' | 'mobile'
  media: ResolvedMedia | null
  clientName: string
  category: string
  description: string
  /** Draw the website's own UI over the picture, so a crop is judged against it. */
  showOverlay: boolean
}

/**
 * A scaled-down copy of the website's hero at one screen size.
 *
 * Mirrors WorkPresentation.css: the picture is `object-fit: cover` with
 * `object-position` from the focal point, under the same dark gradient, with
 * the client list on the left (desktop) and the caption card at the bottom.
 * The overlay matters — a subject cropped neatly into frame is still spoilt
 * if the caption card lands on top of it.
 *
 * `media` comes from `resolveForViewport`, the same rule the website follows,
 * so this cannot show a phone the desktop picture when the site would not.
 */
export default function ScreenPreview({ viewport, media, clientName, category, description, showOverlay }: Props) {
  const isDesktop = viewport === 'desktop'
  const aspect = isDesktop ? DESKTOP_ASPECT : MOBILE_ASPECT

  const picture: React.CSSProperties = {
    position: 'absolute', inset: 0, width: '100%', height: '100%',
    objectFit: 'cover',
    objectPosition: media ? objectPosition(media.focalX, media.focalY) : '50% 50%',
  }

  const screen = (
    <div
      className="relative overflow-hidden bg-[#100d18] text-white"
      style={{ aspectRatio: String(aspect) }}
    >
      {media ? (
        media.type === 'video' ? (
          <video src={media.url} poster={media.posterUrl ?? undefined} muted playsInline preload="metadata" style={picture} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={media.url} alt="" style={picture} draggable={false} />
        )
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-[10px] text-white/40">No media yet</div>
      )}

      {showOverlay && (
        <>
          {/* The website's own shading, so text stays legible over the picture. */}
          <div
            aria-hidden
            className="absolute inset-0 pointer-events-none"
            style={{
              background: isDesktop
                ? 'linear-gradient(90deg,#100d187a,transparent 55%),linear-gradient(0deg,#100d18cf,transparent 45%),linear-gradient(180deg,#100d185c,transparent 25%)'
                : 'linear-gradient(0deg,#100d18e8,transparent 65%),linear-gradient(180deg,#100d1890,transparent 40%)',
            }}
          />

          {isDesktop && (
            // Where the client list sits on the site.
            <div
              aria-hidden
              className="absolute rounded-md border border-white/15 bg-white/10 backdrop-blur-[2px]"
              style={{ left: '3%', top: '24%', bottom: '15%', width: '19%' }}
            />
          )}

          <div
            className="absolute rounded-md border border-white/20 bg-[#100d18]/60 backdrop-blur-[2px]"
            style={isDesktop
              ? { right: '4%', bottom: '8%', width: '38%', padding: '3.5% 4%' }
              : { left: '8%', right: '8%', bottom: '5%', padding: '8%' }}
          >
            {category && (
              <p className="uppercase tracking-[0.15em] text-[#eee5ff] truncate" style={{ fontSize: isDesktop ? 6 : 6 }}>
                {category}
              </p>
            )}
            <p className="font-medium leading-tight truncate" style={{ fontSize: isDesktop ? 11 : 11, margin: '3px 0' }}>
              {clientName || 'Client name'}
            </p>
            {description && (
              <p className="text-[#f0ebf6] line-clamp-2" style={{ fontSize: 6, lineHeight: 1.5 }}>{description}</p>
            )}
          </div>
        </>
      )}
    </div>
  )

  if (isDesktop) {
    return (
      <div className="rounded-lg border border-border bg-card shadow-sm overflow-hidden">
        <div className="flex items-center gap-1 px-2.5 py-1.5 border-b border-border bg-secondary/60" aria-hidden>
          <span className="w-1.5 h-1.5 rounded-full bg-red-400/70" />
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400/70" />
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/70" />
        </div>
        {screen}
      </div>
    )
  }

  return (
    <div className="mx-auto w-[150px] rounded-[22px] border-[5px] border-neutral-800 bg-neutral-800 shadow-md overflow-hidden">
      <div className="rounded-[16px] overflow-hidden">{screen}</div>
    </div>
  )
}

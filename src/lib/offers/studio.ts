/**
 * Offer Studio — the separate flyer app (its own repo and database) where
 * offer lists are prepared since Oct 2026. It pushes saved offers into Cirqle
 * through /api/figma/campaign; Cirqle only links out to it. The desktop app
 * opens the same address in its Offer Studio pane (desktop/src/main.js).
 */
export const OFFER_STUDIO_URL =
  (process.env.NEXT_PUBLIC_OFFER_STUDIO_URL || 'https://flyer.cirqle.work').replace(/\/$/, '')

/** True for an absolute http(s) link — one the in-app router must not push. */
export function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href)
}

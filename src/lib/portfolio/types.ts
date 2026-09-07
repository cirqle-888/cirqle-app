/**
 * Shared shapes for the website portfolio module.
 *
 * These live outside actions.ts because a 'use server' module may only export
 * async functions — exporting a const from there survives the server-actions
 * transform as a value reference and breaks the whole module.
 */

/** Rendition widths generated for every upload.
 *  Must stay in step with cirqle-website/scripts/seed-portfolio.mjs. */
export const VARIANT_WIDTHS = [480, 960, 1600, 2000] as const

/** WebP encode quality used by the browser-side resizer. */
export const WEBP_QUALITY = 0.82

/** Largest file the browser will accept before resizing. */
export const MAX_SOURCE_BYTES = 40 * 1024 * 1024

/** What a portfolio entry is. */
export type WorkKind = 'image' | 'video' | 'reel'

/**
 * What shape the piece was designed for. Independent of `kind`: a story frame
 * can be a still or a clip. Brands answer who the work was for, formats answer
 * what it is, and the website filters on both.
 */
export type WorkFormat =
  // social media
  | 'post' | 'reel' | 'story'
  // brand identity
  | 'logo' | 'guidelines' | 'brandbook' | 'chart'

export const WORK_FORMATS: readonly WorkFormat[] =
  ['post', 'reel', 'story', 'logo', 'guidelines', 'brandbook', 'chart'] as const

export const WORK_FORMAT_LABEL: Record<WorkFormat, string> = {
  post: 'Post',
  reel: 'Reel',
  story: 'Story',
  logo: 'Logo',
  guidelines: 'Guidelines',
  brandbook: 'Brandbook',
  chart: 'Brand chart',
}

/**
 * Which formats a collection actually uses.
 *
 * A brand identity job is not one fixed thing — one client gets a logo and
 * nothing else, another a full brandbook, another a single brand chart — so
 * they all live in one collection and the type is per item. Offering the
 * social media types there (or the identity types on a social page) would
 * just be a way to file something wrongly.
 */
export const FORMATS_BY_COLLECTION: Record<string, readonly WorkFormat[]> = {
  'social-media': ['post', 'reel', 'story'],
  'brand-identity': ['logo', 'guidelines', 'brandbook', 'chart'],
}

/** Formats offered for a collection; every format if it is not a known one. */
export const formatsFor = (collectionSlug: string | undefined): readonly WorkFormat[] =>
  (collectionSlug && FORMATS_BY_COLLECTION[collectionSlug]) || WORK_FORMATS

/** Video containers accepted for upload, and the extension each is stored as. */
export const VIDEO_EXT_BY_TYPE: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
}

/** Storage caps. The bucket enforces the same limit — a browser can lie. */
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024

export interface WorkVariant {
  width: number
  height: number
  path: string
  bytes?: number
}

export interface PortfolioItem {
  id: string
  slug: string
  title: string
  kind: WorkKind
  format: WorkFormat
  /** Storage path of an uploaded video, for kind 'video' */
  mediaPath: string | null
  /** Where it lives on a social platform */
  externalUrl: string | null
  durationSeconds: number | null
  width: number
  height: number
  variants: WorkVariant[]
  published: boolean
  position: number
  /** Hand-picked place in the collection's All view; null when never dragged. */
  collectionPosition: number | null
  previewUrl: string
}

export interface FlyerRow {
  id: string
  title: string
  /** True when this page belongs to the same booklet as the page before it. */
  bookletContinues: boolean
  width: number
  height: number
  variants: WorkVariant[]
  published: boolean
  position: number
  previewUrl: string
}

export interface PortfolioBrand {
  id: string
  slug: string
  name: string
  tagline: string | null
  position: number
  /** Public URL of the brand logo, or null when the chip shows its name. */
  logoUrl: string | null
  logoPath: string | null
  items: PortfolioItem[]
}

export interface PortfolioCollection {
  id: string
  slug: string
  title: string
  eyebrow: string
  position: number
  brands: PortfolioBrand[]
}

export interface UploadTarget {
  width: number
  uploadUrl: string
  path: string
}

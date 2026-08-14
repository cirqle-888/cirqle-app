/**
 * How tall is an Instagram grid tile?
 *
 * Instagram has changed this before — the profile grid was square (1:1) for
 * years, then moved to portrait (4:5) — and will change it again. A hardcoded
 * ratio means the mockup silently stops matching reality, which defeats the
 * only purpose a feed preview has.
 *
 * So it is a setting, stored in `company_settings` under `social_feed_aspect`.
 * Changing it is a dropdown, not a deploy, and the planner and the client's
 * approval view read the same value so the two can never disagree.
 */

export type FeedAspect = '1:1' | '4:5' | '3:4'

export interface FeedAspectOption {
  value: FeedAspect
  label: string
  /** Tailwind aspect utility for a grid tile. */
  className: string
  hint: string
}

/**
 * Portrait 4:5 is the default because it is what Instagram's profile grid
 * currently crops to. If that changes again, change the default here — or,
 * better, just change the setting and never touch this file.
 */
export const DEFAULT_FEED_ASPECT: FeedAspect = '4:5'

export const FEED_ASPECT_OPTIONS: FeedAspectOption[] = [
  {
    value: '4:5',
    label: 'Portrait 4:5',
    className: 'aspect-[4/5]',
    hint: "Instagram's current profile grid",
  },
  {
    value: '1:1',
    label: 'Square 1:1',
    className: 'aspect-square',
    hint: 'The classic grid, before 2025',
  },
  {
    value: '3:4',
    label: 'Portrait 3:4',
    className: 'aspect-[3/4]',
    hint: 'Taller crop, if Instagram moves again',
  },
]

/**
 * Read a stored value into a known aspect.
 *
 * Anything unrecognised — a typo, a value from a newer version, a NULL — falls
 * back to the default rather than producing a broken layout. A wrong-but-valid
 * crop is recoverable; a collapsed grid is not.
 */
export function parseFeedAspect(raw: string | null | undefined): FeedAspect {
  if (raw === '1:1' || raw === '4:5' || raw === '3:4') return raw
  return DEFAULT_FEED_ASPECT
}

/** Tailwind class for a given aspect. */
export function aspectClass(aspect: FeedAspect): string {
  return FEED_ASPECT_OPTIONS.find(o => o.value === aspect)?.className
    ?? 'aspect-[4/5]'
}

/** Human label, for the setting control and any explanatory copy. */
export function aspectLabel(aspect: FeedAspect): string {
  return FEED_ASPECT_OPTIONS.find(o => o.value === aspect)?.label ?? aspect
}

/** The settings key, named once so reader and writer cannot drift. */
export const FEED_ASPECT_KEY = 'social_feed_aspect'

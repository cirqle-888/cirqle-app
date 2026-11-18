/**
 * The opening cover of the native app.
 *
 * Android's own launch screen can only be a logo on a plain colour, so the
 * designed cover (public/mobile/cover.webp) is shown by the page instead:
 *
 *   1. public/theme-init.js runs before first paint. Inside the native shell,
 *      on the first page of an app session, it sets
 *      `data-intro-cover="show"` on <html>.
 *   2. globals.css draws the cover full-screen for that attribute — as a CSS
 *      background, `cover`-fitted, so it is cropped to the phone's shape and
 *      never stretched, and so browsers and the desktop app never download it.
 *   3. This module takes it down once the app underneath is ready.
 *
 * The native splash is held until the cover image has loaded, so the hand-over
 * is logo → cover → app with no blank frame in between.
 */

export const COVER_SRC = '/mobile/cover.webp'
/** How long the cover stays once it is actually visible. */
export const COVER_SHOW_MS = 1500
/** Give up waiting for the image after this long; the plain tint shows instead. */
export const COVER_LOAD_TIMEOUT_MS = 2500
/** Matches the opacity transition in globals.css. */
export const COVER_FADE_MS = 350

export interface IntroCoverDeps {
  /** Resolves when the cover image is decoded, rejects if it cannot load. */
  loadImage: (src: string) => Promise<void>
  /** Hides the native splash screen. */
  hideSplash: () => void
  setTimer: (fn: () => void, ms: number) => unknown
}

/** The slice of <html> this needs — keeps it testable without a DOM. */
export interface CoverRoot { dataset: Record<string, string | undefined> }

/**
 * Runs the hand-over. Resolves when the cover is gone (immediately when there
 * is no cover to show). Never rejects: a cover that fails must not be able to
 * leave the app hidden behind it.
 */
export async function runIntroCover(root: CoverRoot, deps: IntroCoverDeps): Promise<void> {
  if (root.dataset.introCover !== 'show') {
    deps.hideSplash()
    return
  }
  const wait = (ms: number) => new Promise<void>(resolve => { deps.setTimer(resolve, ms) })

  // Hold the native splash until the cover can actually be seen.
  await Promise.race([
    deps.loadImage(COVER_SRC).catch(() => {}),
    wait(COVER_LOAD_TIMEOUT_MS),
  ])
  deps.hideSplash()

  await wait(COVER_SHOW_MS)
  root.dataset.introCover = 'hide'          // fades out (globals.css)
  await wait(COVER_FADE_MS)
  delete root.dataset.introCover
}

/** Browser implementation of `loadImage`. */
export function loadImageInBrowser(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('cover failed to load'))
    img.src = src
  })
}

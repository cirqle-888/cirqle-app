'use client'

import { containsFigure, isBlurrable, type FigureOptions } from './figures'

/**
 * Marks every on-screen figure so CSS can blur it, and keeps marking as the
 * page changes. Runs ONLY while presentation mode is on, so it costs nothing
 * the rest of the time.
 *
 * A MutationObserver rather than a one-off pass because this app is alive:
 * realtime events refresh routes, tabs swap, tables paginate. A single sweep
 * would blur what was on screen when the toggle was flipped and then quietly
 * stop — which is the worst possible behaviour for the thing it protects.
 *
 * The marker is a `data-` attribute rather than a class so it cannot collide
 * with Tailwind's class churn, and removing it is a single querySelectorAll.
 */

const ATTR = 'data-cq-figure'
const ROOT_ATTR = 'data-cq-hide-figures'

let observer: MutationObserver | null = null
let scheduled = 0

/** Mark the figures inside one subtree. */
function mark(root: ParentNode, opts: FigureOptions): void {
  // Leaf-ish elements only: blurring a container would blur the labels too,
  // and the point is to demo the app, not a grey rectangle.
  const candidates = root.querySelectorAll<HTMLElement>('*:not(script):not(style)')
  for (const el of candidates) {
    if (el.hasAttribute(ATTR)) continue
    if (el.childElementCount > 0) continue
    if (!isBlurrable(el.tagName, el.childElementCount > 0)) continue
    const text = el.textContent || ''
    if (text.length > 400) continue          // prose, not a figure
    if (containsFigure(text, opts)) el.setAttribute(ATTR, '')
  }
}

/** Coalesce the bursts a React re-render produces into one pass. */
function schedulePass(opts: FigureOptions): void {
  if (scheduled) return
  scheduled = window.requestAnimationFrame(() => {
    scheduled = 0
    mark(document.body, opts)
  })
}

export function startHidingFigures(opts: FigureOptions = {}): void {
  if (typeof document === 'undefined' || observer) return
  document.documentElement.setAttribute(ROOT_ATTR, '')
  mark(document.body, opts)

  observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      // An element whose own text changed may have become a figure, or
      // stopped being one — re-test it rather than trusting the old mark.
      if (m.type === 'characterData' && m.target.parentElement) {
        m.target.parentElement.removeAttribute(ATTR)
      }
      for (const node of m.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) (node as HTMLElement).removeAttribute?.(ATTR)
      }
    }
    schedulePass(opts)
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
}

export function stopHidingFigures(): void {
  if (typeof document === 'undefined') return
  if (scheduled) { window.cancelAnimationFrame(scheduled); scheduled = 0 }
  observer?.disconnect()
  observer = null
  document.documentElement.removeAttribute(ROOT_ATTR)
  for (const el of document.querySelectorAll('[' + ATTR + ']')) el.removeAttribute(ATTR)
}

export const FIGURE_ATTR = ATTR
export const HIDE_ROOT_ATTR = ROOT_ATTR

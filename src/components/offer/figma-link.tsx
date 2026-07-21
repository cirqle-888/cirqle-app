'use client'

import { useCallback } from 'react'

/**
 * Open a Figma file in the DESKTOP app, falling back to the browser.
 *
 * Figma registers the `figma://` protocol when its desktop app is installed,
 * and the desktop app understands the same paths as the website — so the deep
 * link is the https URL with its origin swapped. Keeping the rest of the URL
 * intact matters: `?node-id=` survives, so a link to one frame still lands on
 * that frame rather than the file root.
 *
 * There is no API that answers "is the desktop app installed". The reliable
 * signal is indirect: if the handler exists the OS hands focus to Figma, and
 * the browser tab goes hidden or loses focus. So we fire the protocol URL, wait
 * briefly, and open the website only if the tab is still in the foreground.
 * Worst case for a user without the app is the website opening a beat late;
 * worst case for a user with it is nothing extra happens.
 */

/** `https://www.figma.com/design/KEY/Name?x` → `figma://design/KEY/Name?x` */
export function figmaDesktopUrl(url: string): string | null {
  try {
    const u = new URL(url)
    if (!/(^|\.)figma\.com$/i.test(u.hostname)) return null
    return `figma://${u.pathname.replace(/^\//, '')}${u.search}${u.hash}`
  } catch {
    return null
  }
}

/** How long to wait for the OS to switch away before assuming no desktop app. */
const HANDOFF_GRACE_MS = 1200

export function openFigma(url: string): void {
  const deepLink = figmaDesktopUrl(url)
  if (!deepLink) {
    window.open(url, '_blank', 'noopener,noreferrer')
    return
  }

  let handedOff = false
  const noteHandoff = () => { handedOff = true }

  // Any of these firing means the OS switched to another app — i.e. Figma
  // opened. `visibilitychange` covers most browsers; `blur` catches the rest.
  document.addEventListener('visibilitychange', noteHandoff)
  window.addEventListener('blur', noteHandoff)

  // A hidden iframe avoids the "site can't be reached" flash that assigning
  // window.location produces in some browsers when no handler is registered.
  const frame = document.createElement('iframe')
  frame.style.display = 'none'
  frame.src = deepLink
  document.body.appendChild(frame)

  window.setTimeout(() => {
    document.removeEventListener('visibilitychange', noteHandoff)
    window.removeEventListener('blur', noteHandoff)
    frame.remove()
    if (!handedOff && !document.hidden) {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  }, HANDOFF_GRACE_MS)
}

/**
 * Anchor that prefers the desktop app. Stays a real <a> with a working href so
 * middle-click, cmd-click and "copy link address" behave normally — the desktop
 * handoff is an enhancement layered on the plain-click path only.
 */
export function FigmaLink({
  url, title, className, children,
}: {
  url: string
  title?: string
  className?: string
  children: React.ReactNode
}) {
  const onClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
    // Let the browser handle modified clicks — the user asked for a new tab or
    // window explicitly, and hijacking that is worse than not helping.
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    e.preventDefault()
    openFigma(url)
  }, [url])

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={title ?? 'Open in the Figma desktop app'}
      onClick={onClick}
      className={className}
    >
      {children}
    </a>
  )
}

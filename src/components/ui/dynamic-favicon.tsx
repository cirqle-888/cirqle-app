'use client'

import { useEffect } from 'react'

/**
 * DynamicFavicon — points the tab icon at /api/favicon, which serves the
 * workspace icon configured in Settings (falling back to the static
 * /icon.svg when none is set).
 *
 * This component mounts in the ROOT layout, so it runs on every page load of
 * every route. It used to query `company_settings.favicon_url` directly with
 * the browser Supabase client, which meant ~20 KB of un-cacheable Supabase
 * egress on every one of those loads — the icon is stored as a base64 data
 * URL — and it 401'd on every public page, where there is no session and the
 * anon role cannot read that table.
 *
 * Handing the browser a same-origin URL fixes both: the response is cached
 * for an hour like any other image, and the route reads through the service
 * role so the custom icon now appears on the public invoice/intake/portal
 * pages too. See src/app/api/favicon/route.ts.
 */
export function DynamicFavicon() {
  useEffect(() => {
    // Unconditional: /api/favicon always resolves to an image (custom or the
    // static default), so there is nothing to probe for first.
    let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')
    if (!link) {
      link = document.createElement('link')
      link.rel = 'icon'
      document.head.appendChild(link)
    }
    link.href = '/api/favicon'
  }, [])

  return null
}

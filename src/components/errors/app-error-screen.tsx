'use client'

/**
 * Cirqle's own error screen, shared by the dashboard error boundary and the
 * root global-error. Replaces Next's bare "This page couldn't load".
 *
 * Two jobs:
 *  1. A tab running an OLDER BUILD than the server (see lib/errors/stale-build)
 *     reloads itself once — that is what most of these screens were.
 *  2. Anything else is a real error: show a calm screen and send the details to
 *     /api/client-error, so the next one can be diagnosed from the server logs.
 *     Until now nothing recorded browser-side crashes at all.
 */

import { useEffect, useState } from 'react'
import { isStaleBuildError, shouldAutoReload, STALE_RELOAD_KEY } from '@/lib/errors/stale-build'

type Props = {
  error: Error & { digest?: string }
  /** Where the boundary sits, for the log. */
  boundary: 'dashboard' | 'global'
}

function readLastReload(): number | null {
  try { const v = sessionStorage.getItem(STALE_RELOAD_KEY); return v ? Number(v) : null } catch { return null }
}

export default function AppErrorScreen({ error, boundary }: Props) {
  const stale = isStaleBuildError(error)
  // Decided once, on the first client render: reload for a stale build unless
  // this tab already did so within the last minute (then reloading won't help).
  const [reloading] = useState(() =>
    typeof window !== 'undefined' && stale && shouldAutoReload(readLastReload(), Date.now()))

  useEffect(() => {
    if (reloading) {
      try { sessionStorage.setItem(STALE_RELOAD_KEY, String(Date.now())) } catch { /* reload anyway */ }
      window.location.reload()
      return
    }
    // Report once per error. keepalive lets it finish even if the user
    // reloads straight away.
    try {
      void fetch('/api/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          boundary,
          stale,
          name: error?.name,
          message: error?.message,
          digest: error?.digest,
          stack: error?.stack,
          url: window.location.href,
          userAgent: navigator.userAgent,
        }),
      }).catch(() => {})
    } catch { /* reporting must never throw */ }
  }, [error, stale, boundary, reloading])

  if (reloading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">Cirqle was just updated — reloading…</p>
      </div>
    )
  }

  const serverError = !!error?.digest
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="text-center max-w-sm">
        <h1 className="text-lg font-semibold text-foreground">Something went wrong on this page</h1>
        <p className="text-sm text-muted-foreground mt-1.5">
          {stale
            ? 'Cirqle was updated while this page was open. Reload to get the new version.'
            : serverError
              ? 'The server couldn’t finish loading it. Reload to try again.'
              : 'Reload to try again, or go back. The error has been reported.'}
        </p>
        <div className="mt-5 flex items-center justify-center gap-2">
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity">
            Reload
          </button>
          <button
            onClick={() => { if (window.history.length > 1) window.history.back(); else window.location.href = '/dashboard' }}
            className="px-4 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-secondary transition-colors">
            Back
          </button>
        </div>
        {error?.digest && <p className="mt-4 text-[11px] text-muted-foreground/60 font-mono">Ref {error.digest}</p>}
      </div>
    </div>
  )
}

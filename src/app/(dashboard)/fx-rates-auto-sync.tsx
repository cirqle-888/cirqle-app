'use client'

/**
 * Host-agnostic FX rate auto-refresh.
 *
 * Fires once per dashboard mount and asks the server to refresh exchange rates
 * **only if** the freshest stored rate is older than the configured interval
 * (`fx_auto_refresh_hours`). The server action self-throttles, so this is cheap
 * and safe to run on every load — no cron / scheduler required, works on
 * localhost, a VPS, Vercel, Docker, anywhere. Fire-and-forget: never blocks the
 * UI and silently ignores failures (rates simply stay as they are).
 */

import { useEffect, useRef } from 'react'
import { syncExchangeRatesIfStale } from './dashboard/settings/actions'

export function FxRatesAutoSync() {
  const ran = useRef(false)
  useEffect(() => {
    if (ran.current) return // guard React StrictMode's double-invoke in dev
    ran.current = true
    syncExchangeRatesIfStale().catch(() => {})
  }, [])
  return null
}

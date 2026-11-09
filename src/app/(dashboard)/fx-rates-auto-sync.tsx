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

/**
 * How often one browser may ask. The server self-throttles on the stored
 * rates' age, but ASKING costs three database round trips (who are you, what
 * is the interval, how old are the rates) on every full page load — a reload
 * of a heavy page paid for those while it was still rendering. Rates refresh
 * daily; one question an hour per browser is plenty.
 */
const ASK_EVERY_MS = 60 * 60 * 1000
const LAST_ASKED_KEY = 'cirqle-fx-last-asked'

export function FxRatesAutoSync() {
  const ran = useRef(false)
  useEffect(() => {
    if (ran.current) return // guard React StrictMode's double-invoke in dev
    ran.current = true
    try {
      const last = Number(window.localStorage.getItem(LAST_ASKED_KEY) || 0)
      if (Date.now() - last < ASK_EVERY_MS) return
      window.localStorage.setItem(LAST_ASKED_KEY, String(Date.now()))
    } catch { /* storage blocked — ask as before */ }
    syncExchangeRatesIfStale().catch(() => {})
  }, [])
  return null
}

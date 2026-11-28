'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { usePermissions } from '@/contexts/permission-context'
import { featureForPath } from '@/lib/feature-usage/catalogue'
import { todayISO } from '@/lib/utils/local-date'

const SENT_KEY = 'cirqle-feature-visits'
/** Sent this session, so a page is reported once per day, not on every click. */
const sent = new Set<string>()

function alreadySent(key: string): boolean {
  if (sent.has(key)) return true
  try {
    const list = JSON.parse(window.sessionStorage.getItem(SENT_KEY) ?? '[]') as string[]
    if (list.includes(key)) { sent.add(key); return true }
  } catch { /* private window: the in-memory set is enough */ }
  return false
}

function remember(key: string) {
  sent.add(key)
  try {
    const today = key.slice(key.lastIndexOf('|') + 1)
    const list = (JSON.parse(window.sessionStorage.getItem(SENT_KEY) ?? '[]') as string[])
      .filter(k => k.endsWith(`|${today}`))
    window.sessionStorage.setItem(SENT_KEY, JSON.stringify([...list, key]))
  } catch { /* fine */ }
}

/**
 * Notes which sidebar page this person opened today, for Insights → Feature
 * Usage. Sends only the page path; the server maps it to its sidebar feature
 * and stores one row per person per page per day. Off during view-as.
 * Renders nothing.
 */
export function FeatureVisitTracker() {
  const pathname = usePathname()
  const { user } = usePermissions()
  const who = user.employeeId
  const active = !!who && !user.isViewAs

  useEffect(() => {
    if (!active || !pathname) return
    const href = featureForPath(pathname)
    if (!href) return
    const key = `${who}|${href}|${todayISO()}`
    if (alreadySent(key)) return
    remember(key)
    try {
      void fetch('/api/feature-visit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({ path: pathname }),
      }).catch(() => {})
    } catch { /* tracking must never break a page */ }
  }, [active, who, pathname])

  return null
}

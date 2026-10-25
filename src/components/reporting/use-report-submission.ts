'use client'
import { useRef } from 'react'

/** A network retry or double click must reuse the same server run. */
export function useReportSubmission() {
  const request = useRef<{ body: string; key: string } | null>(null)
  return async (body: unknown): Promise<{ reportId: string; jobId: string; status: string }> => {
    const serialized = JSON.stringify(body)
    if (request.current?.body !== serialized) request.current = { body: serialized, key: crypto.randomUUID() }
    const res = await fetch('/api/advertising/reports/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.current.key }, body: serialized,
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error ?? 'Could not queue report.')
    return json
  }
}

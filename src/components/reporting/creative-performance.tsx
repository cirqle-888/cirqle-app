'use client'
/* eslint-disable @next/next/no-img-element -- expiring provider thumbnails, with fallback */
import { useState } from 'react'
import { todayISO, daysFromTodayISO } from '@/lib/utils/local-date'
interface CreativeData { currency: string; resultLabel: string; costLabel: string; rows: { id: string; name: string; spend: number | null; results: number | null; cost: number | null; thumbnail?: string; limited: boolean }[] }
export function CreativePerformance({ projectId }: { projectId: string }) {
  const [from, setFrom] = useState(daysFromTodayISO(-7)), [to, setTo] = useState(todayISO())
  const [data, setData] = useState<CreativeData | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  async function load() {
    setBusy(true); setError(''); setData(null)
    try {
      const res = await fetch(`/api/advertising/projects/${projectId}/creatives?${new URLSearchParams({ from, to })}`)
      const json = await res.json(); if (!res.ok) throw new Error(json.error); setData(json)
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not load creatives.') }
    finally { setBusy(false) }
  }
  return <section className="rounded-xl border p-4 space-y-3"><h2 className="font-semibold">Creative performance</h2>
    <div className="flex flex-wrap gap-2"><input type="date" aria-label="Creative report start" className="border rounded bg-background p-2" value={from} onChange={e => setFrom(e.target.value)} /><input type="date" aria-label="Creative report end" className="border rounded bg-background p-2" value={to} onChange={e => setTo(e.target.value)} /><button disabled={busy} onClick={load} className="rounded border p-2">{busy ? 'Loading…' : 'Compare creatives'}</button></div>
    <p role="status" className="text-sm text-muted-foreground">{error || 'Compare the same objective and period. Fewer than 20 results is a limited sample, not a reliable winner.'}</p>
    {data && <div className="grid gap-3 sm:grid-cols-2">{data.rows.map(row => <article key={row.id} className="border rounded p-3 space-y-2 text-sm">
      {row.thumbnail && <img src={row.thumbnail} alt={row.name} className="h-32 w-full object-contain" referrerPolicy="no-referrer" onError={e => { e.currentTarget.style.display = 'none' }} />}
      <h3 className="font-medium">{row.name}</h3><p className="text-xs text-muted-foreground">Ad {row.id} · {from} — {to}</p>
      <p>Spend: {row.spend == null ? 'Not available' : `${data.currency} ${row.spend.toLocaleString('en-IN')}`}</p><p>{data.resultLabel}: {row.results ?? 'Not available'}</p><p>{data.costLabel}: {row.cost == null ? 'Not available' : `${data.currency} ${row.cost.toFixed(2)}`}</p>
      {row.limited && <p className="text-amber-700 dark:text-amber-400">Limited result data</p>}
    </article>)}{data.rows.length === 0 && <p>No creative data for this period.</p>}</div>}
  </section>
}

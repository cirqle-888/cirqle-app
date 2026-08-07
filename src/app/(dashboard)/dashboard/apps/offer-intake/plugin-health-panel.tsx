'use client'

/**
 * Plugin health — admin-only operational glance at Cirqle Studio.
 *
 * A small stat row by default; the full breakdown (versions, durations,
 * platforms, auth failures) lives in one collapsed Details disclosure.
 * Read-only; loads lazily on first expand of the card.
 */

import { useState } from 'react'
import { Activity, ChevronDown, Loader2 } from 'lucide-react'
import { getPluginHealth, type PluginHealth } from './actions'

function fmtDateTime(d: string) {
  return new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function PluginHealthPanel() {
  const [health, setHealth] = useState<PluginHealth | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    if (health || loading) return
    setLoading(true)
    try {
      const res = await getPluginHealth(30)
      if (res.ok && res.data) setHealth(res.data)
      else setError(res.error || 'Could not load plugin health.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <details className="group bg-card border border-border rounded-2xl mb-5" onToggle={e => { if ((e.target as HTMLDetailsElement).open) void load() }}>
      <summary className="cursor-pointer list-none px-4 py-3 flex items-center gap-2.5">
        <Activity className="w-4 h-4 text-violet-400 shrink-0" />
        <span className="text-sm font-semibold flex-1">Plugin health <span className="font-normal text-muted-foreground">— Cirqle Studio, last 30 days</span></span>
        <ChevronDown className="w-4 h-4 text-muted-foreground group-open:rotate-180 transition-transform" />
      </summary>
      <div className="px-4 pb-4">
        {loading && <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Loading…</p>}
        {error && <p className="text-xs text-muted-foreground">{error}</p>}
        {health && (
          <>
            {/* Default: the four numbers that matter */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                ['Saves', String(health.totalSaves)],
                ['Failed saves', String(health.failedSaves)],
                ['Conflicts', String(health.conflicts)],
                ['Last activity', health.lastActivity ? fmtDateTime(health.lastActivity) : '—'],
              ].map(([label, value]) => (
                <div key={label} className="bg-secondary/40 rounded-xl px-3 py-2.5">
                  <p className="text-sm font-semibold">{value}</p>
                  <p className="text-[11px] text-muted-foreground">{label}</p>
                </div>
              ))}
            </div>

            {/* Everything else stays folded */}
            <details className="group/details mt-3">
              <summary className="cursor-pointer list-none text-xs text-muted-foreground/70 hover:text-muted-foreground flex items-center gap-1">
                Details <ChevronDown className="w-3 h-3 group-open/details:rotate-180 transition-transform" />
              </summary>
              <div className="mt-2 space-y-3 text-xs text-muted-foreground">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1">
                  <span>Photo uploads: <span className="text-foreground">{health.imageUploads}</span></span>
                  <span>Failed uploads: <span className="text-foreground">{health.failedImageUploads}</span></span>
                  <span>Auth failures: <span className="text-foreground">{health.authFailures}</span></span>
                  <span>Update refusals: <span className="text-foreground">{health.updateRefusals}</span></span>
                  <span>Avg save: <span className="text-foreground">{health.avgSaveMs != null ? `${(health.avgSaveMs / 1000).toFixed(1)}s` : '—'}</span></span>
                  <span>Platforms: <span className="text-foreground">{Object.entries(health.platforms).map(([p, n]) => `${p} ${n}`).join(' · ') || '—'}</span></span>
                </div>
                {health.versions.length > 0 && (
                  <div>
                    <p className="font-semibold text-foreground/80 mb-1">Versions seen</p>
                    <div className="space-y-0.5">
                      {health.versions.map(v => (
                        <p key={`${v.version}-${v.platform}`}>
                          {v.version}{v.platform ? ` (${v.platform})` : ''} — {v.count} events · last {fmtDateTime(v.lastSeen)}
                        </p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </details>
          </>
        )}
      </div>
    </details>
  )
}

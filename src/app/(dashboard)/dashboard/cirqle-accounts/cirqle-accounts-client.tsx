'use client'

/**
 * Cirqle Accounts — the agency's own marketing, kept out of client data.
 *
 * Reads only; ownership changes happen on Asset Assignment, where the
 * confirmation rule lives. One write path, not two.
 */

import Link from 'next/link'
import Header from '@/components/layout/header'
import { EmptyState } from '@/components/ui/empty-state'
import { ASSET_KIND_LABEL, type AssetRow } from '@/lib/assets/registry'
import { Megaphone, ClipboardList, Building2, ShieldCheck } from 'lucide-react'
import { PlatformIcon } from '@/components/social-hub/platform-icon'

/** Social kinds reuse the shared PlatformIcon; the rest are plain lucide. */
function KindIcon({ kind, className }: { kind: string; className?: string }) {
  if (kind === 'facebook_page' || kind === 'instagram') {
    return <PlatformIcon platform={kind} className={className} />
  }
  const Icon = kind === 'ad_account' ? Megaphone : kind === 'lead_form' ? ClipboardList : Building2
  return <Icon className={className} />
}

const fmt = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString('en-IN')
}

export default function CirqleAccountsClient({
  assets, stats,
}: {
  assets: AssetRow[]
  stats: { reach: number; views: number; interactions: number; leads: number; followers: number }
}) {
  const byKind = (kinds: string[]) => assets.filter(a => kinds.includes(a.kind))

  const sections: { title: string; rows: AssetRow[] }[] = [
    { title: 'Facebook Pages', rows: byKind(['facebook_page']) },
    { title: 'Instagram accounts', rows: byKind(['instagram']) },
    { title: 'Ad accounts', rows: byKind(['ad_account']) },
    { title: 'Lead forms', rows: byKind(['lead_form']) },
  ].filter(s => s.rows.length > 0)

  return (
    <>
      <Header
        title="Cirqle Accounts"
        subtitle="Our own marketing — never included in client reports, leads or billing"
      />

      <div className="p-4 md:p-6 space-y-4 max-w-4xl">
        {/* State the isolation guarantee, because the whole point of this page
            is that these numbers are NOT client numbers. */}
        <div className="rounded-xl border border-primary/25 bg-primary/[0.04] px-4 py-3 flex items-start gap-2.5">
          <ShieldCheck className="w-4 h-4 text-primary shrink-0 mt-0.5" />
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            These are the agency&rsquo;s own assets. Their reach, leads and ad spend are
            excluded from every client report, dashboard and invoice — and from the
            client totals on the Agency dashboard.{' '}
            <Link href="/dashboard/assets" className="text-primary hover:underline">
              Change an owner in Asset Assignment
            </Link>.
          </p>
        </div>

        {assets.length === 0 ? (
          <div className="rounded-xl border border-border bg-card">
            <EmptyState
              icon={Building2}
              title="No Cirqle-owned assets yet"
              body="Mark our own Pages, Instagram accounts and ad accounts as Cirqle-owned in Asset Assignment. They will then be tracked here and kept out of every client's reporting."
              action={{ label: 'Open Asset Assignment', onClick: () => { window.location.href = '/dashboard/assets' } }}
            />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {([
                ['Followers', stats.followers],
                ['Reach 30d', stats.reach],
                ['Views 30d', stats.views],
                ['Interactions', stats.interactions],
                ['Leads', stats.leads],
              ] as const).map(([label, value]) => (
                <div key={label} className="rounded-xl border border-border bg-card px-4 py-3">
                  <p className="text-[10px] text-muted-foreground">{label}</p>
                  <p className="text-lg font-semibold tabular-nums mt-0.5">{fmt(value)}</p>
                </div>
              ))}
            </div>

            {sections.map(s => (
              <div key={s.title} className="rounded-xl border border-border bg-card overflow-hidden">
                <div className="px-4 py-2.5 border-b border-border/60 flex items-center gap-2">
                  <p className="text-xs font-semibold">{s.title}</p>
                  <span className="text-[11px] text-muted-foreground tabular-nums">{s.rows.length}</span>
                </div>
                {s.rows.map(a => {
                  return (
                    <div key={a.id} className="flex items-center gap-3 px-4 py-2.5 border-t border-border/60 first:border-t-0">
                      <KindIcon kind={a.kind} className="w-4 h-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm truncate">{a.name}</p>
                        <p className="text-[11px] text-muted-foreground truncate">
                          {ASSET_KIND_LABEL[a.kind]}
                          {a.externalId && <> · {a.externalId}</>}
                        </p>
                      </div>
                      {a.followers != null && (
                        <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                          {fmt(a.followers)} followers
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </>
        )}
      </div>
    </>
  )
}

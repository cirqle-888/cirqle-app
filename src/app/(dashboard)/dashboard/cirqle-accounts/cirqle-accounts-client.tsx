'use client'

/**
 * Cirqle Brands — the agency's own brands and marketing, kept out of client data.
 *
 * Ownership (is this Cirqle's at all?) is decided on Asset Assignment, where
 * the confirmation rule lives. This page only decides WHICH brand one of
 * Cirqle's own accounts belongs to, and shows each brand's numbers.
 */

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Header from '@/components/layout/header'
import { EmptyState } from '@/components/ui/empty-state'
import { ASSET_KIND_LABEL, type AssetRow } from '@/lib/assets/registry'
import { Megaphone, ClipboardList, Building2, ShieldCheck, Settings2, ChevronRight, Loader2 } from 'lucide-react'
import { PlatformIcon } from '@/components/social-hub/platform-icon'
import { taskNoun, type Brand } from '@/lib/brands/brands'
import { BRAND_PERIODS, type BrandPeriod, type BrandSummary } from '@/lib/brands/dashboard'
import { setAccountBrand } from './actions'
import { BrandMark, compact, inr } from './brand-ui'

function KindIcon({ kind, className }: { kind: string; className?: string }) {
  if (kind === 'facebook_page' || kind === 'instagram') {
    return <PlatformIcon platform={kind} className={className} />
  }
  const Icon = kind === 'ad_account' ? Megaphone : kind === 'lead_form' ? ClipboardList : Building2
  return <Icon className={className} />
}

interface Props {
  assets: AssetRow[]
  brands: Brand[]
  summaries: BrandSummary[]
  accountBrand: Record<string, string | null>
  period: BrandPeriod
  range: { from: string; to: string }
  totalLeads: number
  perms: { money: boolean; manage: boolean; assign: boolean }
}

export default function CirqleAccountsClient({ assets, brands, summaries, accountBrand, period, range, totalLeads, perms }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [savingId, setSavingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const social = assets.filter(a => a.kind === 'facebook_page' || a.kind === 'instagram')
  const other = [
    { title: 'Ad accounts', rows: assets.filter(a => a.kind === 'ad_account') },
    { title: 'Lead forms', rows: assets.filter(a => a.kind === 'lead_form') },
  ].filter(s => s.rows.length > 0)

  const def = brands.find(b => b.is_default) ?? brands[0]
  const brandOfAccount = (id: string) => accountBrand[id] || def?.id || ''

  async function moveAccount(accountId: string, brandId: string) {
    setSavingId(accountId); setError(null)
    const res = await setAccountBrand(accountId, brandId && brandId !== def?.id ? brandId : null)
    setSavingId(null)
    if (!res.ok) { setError(res.error ?? 'Could not move the account.'); return }
    startTransition(() => router.refresh())
  }

  return (
    <>
      <Header
        title="Cirqle Brands"
        subtitle="Our own brands and marketing — never included in client reports, leads or billing"
        actions={perms.manage && brands.length > 0 ? (
          <Link href="/dashboard/cirqle-accounts/manage"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-secondary">
            <Settings2 className="h-3.5 w-3.5" /> Manage brands
          </Link>
        ) : undefined}
      />

      <div className="p-4 md:p-6 space-y-5 max-w-6xl">
        <div className="rounded-xl border border-primary/25 bg-primary/[0.04] px-4 py-3 flex items-start gap-2.5">
          <ShieldCheck className="w-4 h-4 text-primary shrink-0 mt-0.5" />
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            These are Cirqle&rsquo;s own brands and assets. Their reach, leads and ad spend are
            excluded from every client report, dashboard and invoice.{' '}
            <Link href="/dashboard/assets" className="text-primary hover:underline">Mark a new page as Cirqle&rsquo;s in Asset Assignment</Link>,
            then pick its brand below.
          </p>
        </div>

        {error && <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</div>}

        {brands.length > 0 && (
          <section aria-labelledby="brands-heading" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="brands-heading" className="text-sm font-semibold">
                Brands <span className="font-normal text-muted-foreground">· {range.from} → {range.to}</span>
              </h2>
              <nav aria-label="Period" className="flex flex-wrap gap-1">
                {BRAND_PERIODS.map(p => (
                  <Link key={p.value} href={`/dashboard/cirqle-accounts?period=${p.value}`} scroll={false}
                    aria-current={p.value === period ? 'page' : undefined}
                    className={`rounded-full px-2.5 py-1 text-[11px] border ${p.value === period
                      ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                    {p.label}
                  </Link>
                ))}
              </nav>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {summaries.map(s => (
                <Link key={s.brand.id} href={`/dashboard/cirqle-accounts/${s.brand.slug}?period=${period}`}
                  className="group rounded-xl border border-border bg-card overflow-hidden hover:border-primary/40 hover:shadow-sm transition">
                  <div className="h-1" style={{ background: s.brand.color || 'var(--primary)' }} />
                  <div className="p-4 space-y-3">
                    <div className="flex items-center gap-3">
                      <BrandMark brand={s.brand} size={36} />
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold truncate">{s.brand.name}</p>
                        <p className="text-[11px] text-muted-foreground truncate">
                          {s.brand.tagline || (s.brand.is_default ? 'Default brand' : 'Cirqle brand')}
                        </p>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground" />
                    </div>
                    <dl className="grid grid-cols-3 gap-2 text-center">
                      {([
                        ['Followers', compact(s.followers)],
                        ['Reach', compact(s.reach)],
                        ['Leads', compact(s.leads)],
                        ['Campaigns', `${s.activeCampaigns}/${s.campaigns.length}`],
                        [`Open ${taskNoun(s.brand).many.toLowerCase()}`, String(s.openTasks.length)],
                        ['Accounts', String(s.accounts.length)],
                      ] as const).map(([label, value]) => (
                        <div key={label} className="rounded-lg bg-secondary/50 px-1.5 py-1.5">
                          <dt className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</dt>
                          <dd className="text-sm font-semibold tabular-nums">{value}</dd>
                        </div>
                      ))}
                    </dl>
                    {s.pnl && (
                      <dl className="grid grid-cols-3 gap-2 border-t border-border/60 pt-2 text-center">
                        <div><dt className="text-[9px] uppercase tracking-wide text-muted-foreground">Revenue</dt><dd className="text-xs font-semibold tabular-nums">{inr(s.pnl.revenueInr + s.pnl.otherIncomeInr)}</dd></div>
                        <div><dt className="text-[9px] uppercase tracking-wide text-muted-foreground">Ad spend</dt><dd className="text-xs font-semibold tabular-nums">{inr(s.pnl.adSpendInr)}</dd></div>
                        <div><dt className="text-[9px] uppercase tracking-wide text-muted-foreground">Result</dt>
                          <dd className={`text-xs font-semibold tabular-nums ${s.pnl.resultInr < 0 ? 'text-red-500' : 'text-emerald-600'}`}>{inr(s.pnl.resultInr)}</dd></div>
                      </dl>
                    )}
                  </div>
                </Link>
              ))}
            </div>
            {perms.money && (
              <p className="text-[10px] text-muted-foreground">
                Result = revenue from the brand&rsquo;s services − staff earnings on that work − its ad spend (incl. GST) − cash-book costs tagged with the brand.
                Shared overheads (salaries, rent, untagged costs) are not split across brands.
              </p>
            )}
          </section>
        )}

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
            {social.length > 0 && (
              <section className="rounded-xl border border-border bg-card overflow-hidden" aria-labelledby="accounts-heading">
                <div className="px-4 py-2.5 border-b border-border/60 flex items-center gap-2">
                  <h2 id="accounts-heading" className="text-xs font-semibold">Pages &amp; Instagram accounts</h2>
                  <span className="text-[11px] text-muted-foreground tabular-nums">{social.length} · {compact(totalLeads)} leads all time</span>
                  {pending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                </div>
                {social.map(a => (
                  <div key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 border-t border-border/60 first:border-t-0">
                    <KindIcon kind={a.kind} className="w-4 h-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm truncate">{a.name}</p>
                      <p className="text-[11px] text-muted-foreground truncate">
                        {ASSET_KIND_LABEL[a.kind]}{a.externalId && <> · {a.externalId}</>}
                        {a.followers != null && <> · {compact(a.followers)} followers</>}
                      </p>
                    </div>
                    {brands.length > 0 && (perms.assign ? (
                      <span className="inline-flex items-center gap-1.5">
                        <select
                          value={brandOfAccount(a.id)}
                          onChange={e => void moveAccount(a.id, e.target.value)}
                          disabled={savingId === a.id}
                          aria-label={`Brand of ${a.name}`}
                          className="rounded-lg border border-border bg-background px-2 py-1 text-xs disabled:opacity-50"
                        >
                          {brands.filter(b => b.is_active || b.id === brandOfAccount(a.id)).map(b => (
                            <option key={b.id} value={b.id}>{b.name}</option>
                          ))}
                        </select>
                        {savingId === a.id && <Loader2 className="h-3 w-3 animate-spin" />}
                      </span>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">{brands.find(b => b.id === brandOfAccount(a.id))?.name}</span>
                    ))}
                  </div>
                ))}
              </section>
            )}

            {other.map(s => (
              <section key={s.title} className="rounded-xl border border-border bg-card overflow-hidden">
                <div className="px-4 py-2.5 border-b border-border/60 flex items-center gap-2">
                  <h2 className="text-xs font-semibold">{s.title}</h2>
                  <span className="text-[11px] text-muted-foreground tabular-nums">{s.rows.length}</span>
                </div>
                {s.rows.map(a => (
                  <div key={a.id} className="flex items-center gap-3 px-4 py-2.5 border-t border-border/60 first:border-t-0">
                    <KindIcon kind={a.kind} className="w-4 h-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm truncate">{a.name}</p>
                      <p className="text-[11px] text-muted-foreground truncate">
                        {ASSET_KIND_LABEL[a.kind]}{a.externalId && <> · {a.externalId}</>}
                      </p>
                    </div>
                  </div>
                ))}
              </section>
            ))}
          </>
        )}
      </div>
    </>
  )
}

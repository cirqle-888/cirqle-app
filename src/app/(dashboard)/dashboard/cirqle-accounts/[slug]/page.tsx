import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { MessageCircle, Globe, Megaphone, ListTodo, Settings2, Plus } from 'lucide-react'
import Header from '@/components/layout/header'
import { PlatformIcon } from '@/components/social-hub/platform-icon'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { loadBrands } from '@/lib/brands/load'
import { BRAND_PERIODS, loadBrandSummaries, resolveBrandPeriod } from '@/lib/brands/dashboard'
import { BrandMark, compact, inr } from '../brand-ui'

export const dynamic = 'force-dynamic'

/** One of Cirqle's brands: its audience, leads, campaigns, internal work and (gated) money. */
export default async function BrandPage({
  params, searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  if (!(isAdmin || hasPermission(me, PERMS.ASSETS_VIEW_CIRQLE))) redirect('/dashboard')
  const money = isAdmin || hasPermission(me, PERMS.REPORTS_VIEW_COMPANY_FINANCIALS)
  const manage = isAdmin || hasPermission(me, PERMS.SETTINGS_MANAGE_COMPANY)
  const canCreateCampaign = isAdmin || hasPermission(me, PERMS.ADVERTISING_CREATE)

  const { slug } = await params
  const sp = await searchParams
  const { period, from, to } = resolveBrandPeriod(typeof sp.period === 'string' ? sp.period : null)

  const admin = createAdminClient()
  const brands = await loadBrands(admin)
  const brand = brands.find(b => b.slug === slug || b.id === slug)
  if (!brand) notFound()

  // Summaries need every brand: a NULL brand_id resolves to the default.
  const summaries = await loadBrandSummaries(admin, brands, { from, to, withMoney: money })
  const s = summaries.find(x => x.brand.id === brand.id)
  if (!s) notFound()
  const pnl = s.pnl

  const card = 'rounded-xl border border-border bg-card'
  const kpis: [string, string][] = [
    ['Followers', compact(s.followers)],
    ['Reach', compact(s.reach)],
    ['Views', compact(s.views)],
    ['Interactions', compact(s.interactions)],
    ['Leads', compact(s.leads)],
  ]

  return (
    <>
      <Header
        title={brand.name}
        crumbLabel={brand.name}
        subtitle={brand.tagline || (brand.is_default ? 'Default brand — everything not given another brand counts here' : 'A Cirqle brand')}
        actions={
          <div className="flex items-center gap-2">
            {canCreateCampaign && (
              <Link href={`/dashboard/advertising/new?brand=${brand.id}`}
                className="inline-flex items-center gap-1.5 rounded-lg gradient-bg px-3 py-1.5 text-xs font-medium text-white hover:opacity-90">
                <Plus className="h-3.5 w-3.5" /> Campaign
              </Link>
            )}
            {manage && (
              <Link href={`/dashboard/cirqle-accounts/manage#${brand.slug}`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-secondary">
                <Settings2 className="h-3.5 w-3.5" /> Edit brand
              </Link>
            )}
          </div>
        }
      />

      <div className="p-4 md:p-6 space-y-5 max-w-6xl">
        <div className={`${card} overflow-hidden`}>
          <div className="h-1.5" style={{ background: brand.color || 'var(--primary)' }} />
          <div className="p-4 flex flex-wrap items-center gap-4">
            <BrandMark brand={brand} size={48} />
            <div className="min-w-0 flex-1">
              <p className="text-lg font-semibold">{brand.name}</p>
              <p className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 mt-0.5">
                {brand.whatsapp_number && (
                  <a href={`https://wa.me/${brand.whatsapp_number.replace(/\D/g, '')}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
                    <MessageCircle className="h-3.5 w-3.5" /> {brand.whatsapp_number}
                  </a>
                )}
                {brand.website && (
                  <a href={/^https?:/.test(brand.website) ? brand.website : `https://${brand.website}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
                    <Globe className="h-3.5 w-3.5" /> {brand.website}
                  </a>
                )}
                {!brand.is_active && <span className="text-amber-600">Inactive</span>}
              </p>
            </div>
            <nav aria-label="Period" className="flex flex-wrap gap-1">
              {BRAND_PERIODS.map(p => (
                <Link key={p.value} href={`/dashboard/cirqle-accounts/${brand.slug}?period=${p.value}`} scroll={false}
                  aria-current={p.value === period ? 'page' : undefined}
                  className={`rounded-full px-2.5 py-1 text-[11px] border ${p.value === period
                    ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                  {p.label}
                </Link>
              ))}
            </nav>
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground">{from} → {to}</p>

        <dl className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {kpis.map(([label, value]) => (
            <div key={label} className={`${card} px-4 py-3`}>
              <dt className="text-[10px] text-muted-foreground">{label}</dt>
              <dd className="text-lg font-semibold tabular-nums mt-0.5">{value}</dd>
            </div>
          ))}
        </dl>

        {pnl && (
          <section className={`${card} p-4 space-y-3`} aria-labelledby="money-heading">
            <h2 id="money-heading" className="text-sm font-semibold">Money</h2>
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              {([
                ['Revenue from its services', inr(pnl.revenueInr), `${pnl.billedTasks} billed task${pnl.billedTasks === 1 ? '' : 's'}`],
                ['Other income', inr(pnl.otherIncomeInr), 'Cash-book receipts tagged with the brand'],
                ['Staff earnings on that work', `−${inr(pnl.directLabourInr)}`, `Margin ${inr(pnl.contributionMarginInr)}`],
                ['Ad spend (incl. GST)', `−${inr(pnl.adSpendInr)}`, 'Company campaigns for this brand'],
                ['Brand costs', `−${inr(pnl.brandExpensesInr)}`, 'Cash-book payments tagged with the brand'],
              ] as const).map(([label, value, sub]) => (
                <div key={label} className="rounded-lg bg-secondary/40 px-3 py-2">
                  <dt className="text-[10px] text-muted-foreground">{label}</dt>
                  <dd className="font-semibold tabular-nums">{value}</dd>
                  <dd className="text-[10px] text-muted-foreground">{sub}</dd>
                </div>
              ))}
              <div className="rounded-lg border border-border px-3 py-2">
                <dt className="text-[10px] text-muted-foreground">Brand result</dt>
                <dd className={`font-semibold tabular-nums ${pnl.resultInr < 0 ? 'text-red-500' : 'text-emerald-600'}`}>{inr(pnl.resultInr)}</dd>
                <dd className="text-[10px] text-muted-foreground">Before shared overheads</dd>
              </div>
            </dl>
          </section>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <section className={`${card} overflow-hidden`} aria-labelledby="acc-heading">
            <h2 id="acc-heading" className="px-4 py-2.5 border-b border-border/60 text-xs font-semibold">Pages &amp; Instagram ({s.accounts.length})</h2>
            {s.accounts.length === 0 ? (
              <p className="px-4 py-4 text-xs text-muted-foreground">
                No accounts yet. Mark the brand&rsquo;s page as Cirqle&rsquo;s in Asset Assignment, then choose this brand for it on Cirqle Brands.
              </p>
            ) : s.accounts.map(a => (
              <div key={a.id} className="flex items-center gap-3 px-4 py-2.5 border-t border-border/60 first:border-t-0">
                <PlatformIcon platform={a.platform} className="w-4 h-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm truncate">{a.platform === 'instagram' && a.username ? `@${a.username}` : a.name}</p>
                  <p className="text-[11px] text-muted-foreground">{a.platform === 'instagram' ? 'Instagram' : 'Facebook Page'} · {a.external_id}</p>
                </div>
                {a.followers != null && <span className="text-[11px] text-muted-foreground tabular-nums">{compact(a.followers)} followers</span>}
              </div>
            ))}
          </section>

          <section className={`${card} overflow-hidden`} aria-labelledby="camp-heading">
            <h2 id="camp-heading" className="px-4 py-2.5 border-b border-border/60 text-xs font-semibold inline-flex items-center gap-1.5 w-full">
              <Megaphone className="h-3.5 w-3.5" /> Ad campaigns ({s.campaigns.length})
            </h2>
            {s.campaigns.length === 0 ? (
              <p className="px-4 py-4 text-xs text-muted-foreground">No company campaigns for this brand yet.</p>
            ) : s.campaigns.map(c => (
              <Link key={c.id} href={`/dashboard/advertising/${c.id}`} className="flex items-center gap-3 px-4 py-2.5 border-t border-border/60 first:border-t-0 hover:bg-secondary/40">
                <div className="min-w-0 flex-1">
                  <p className="text-sm truncate">{c.campaign_name}</p>
                  <p className="text-[11px] text-muted-foreground">{c.status} · {c.start_date || '—'} → {c.end_date || 'ongoing'}</p>
                </div>
                {c.spendInclGstInr != null && <span className="text-[11px] tabular-nums text-muted-foreground">{inr(c.spendInclGstInr)}</span>}
              </Link>
            ))}
          </section>

          <section className={`${card} overflow-hidden`} aria-labelledby="task-heading">
            <h2 id="task-heading" className="px-4 py-2.5 border-b border-border/60 text-xs font-semibold inline-flex items-center gap-1.5 w-full">
              <ListTodo className="h-3.5 w-3.5" /> Open internal work ({s.openTasks.length})
            </h2>
            {s.openTasks.length === 0 ? (
              <p className="px-4 py-4 text-xs text-muted-foreground">Nothing open. Internal tasks get a brand in the task form when Client is “Internal — Cirqle”.</p>
            ) : s.openTasks.slice(0, 25).map(t => (
              <Link key={t.id} href={`/dashboard/tasks?q=${encodeURIComponent('#' + (t.task_number ?? ''))}`}
                className="flex items-center gap-3 px-4 py-2.5 border-t border-border/60 first:border-t-0 hover:bg-secondary/40">
                <span className="text-[11px] text-muted-foreground tabular-nums w-12 shrink-0">#{t.task_number ?? '—'}</span>
                <p className="text-sm truncate flex-1">{t.title}</p>
                <span className="text-[11px] text-muted-foreground">{t.status}</span>
              </Link>
            ))}
          </section>

          <section className={`${card} p-4 space-y-2`} aria-labelledby="svc-heading">
            <h2 id="svc-heading" className="text-xs font-semibold">Services it sells ({s.services.length})</h2>
            {s.services.length === 0 ? (
              <p className="text-xs text-muted-foreground">No services yet{manage ? ' — assign them under Manage brands' : ''}. Client work on its services counts as this brand&rsquo;s revenue.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {s.services.map(sv => (
                  <span key={sv.id} className="rounded-full border border-border px-2 py-0.5 text-[11px]">{sv.name}</span>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  )
}

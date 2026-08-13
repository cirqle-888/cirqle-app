'use client'

/**
 * Per-account social dashboard client. KPI cards compare the current window to
 * the previous equal window; content tabs sort by a chosen metric.
 */

import { useMemo, useState, useTransition } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import AppSelect from '@/components/ui/app-select'
import { EmptyState } from '@/components/ui/empty-state'
import { ToastContainer, useToast } from '@/components/ui/toast'
import { formatDistanceToNow } from 'date-fns'
import {
  RefreshCw, Loader2, ExternalLink, ArrowUpRight, ArrowDownRight,
  Eye, Users, Heart, BarChart3, ImageIcon,
} from 'lucide-react'
import { PlatformIcon } from '@/components/social-hub/platform-icon'
import { syncAccountNow } from '../../actions'

const ReachViewsArea = dynamic(() => import('./_charts').then((m) => m.ReachViewsArea), {
  ssr: false, loading: () => <ChartSkeleton h={220} />,
})
const FollowerLine = dynamic(() => import('./_charts').then((m) => m.FollowerLine), {
  ssr: false, loading: () => <ChartSkeleton h={180} />,
})

interface MediaItem {
  id: string
  external_media_id: string
  media_product_type: string | null
  caption: string | null
  permalink: string | null
  thumbnail_url: string | null
  posted_at: string | null
  is_story: boolean
  views: number | null
  reach: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  saves: number | null
  total_interactions: number | null
  engagement_rate: number | null
}

interface Props {
  account: {
    id: string; client_id: string; platform: 'facebook_page' | 'instagram'
    name: string; username: string | null; profile_picture_url: string | null
    status: string; last_synced_at: string | null; last_error: string | null; client_name: string
  }
  rangeKey: string
  days: number
  kpis: {
    followersNow: number | null; followersPrev: number | null
    reach: { cur: number; prev: number }; views: { cur: number; prev: number }
    interactions: { cur: number; prev: number }; profileTaps: { cur: number; prev: number }
    pageViews: { cur: number; prev: number }
  }
  series: { date: string; reach: number; views: number; interactions: number; followers: number | null }[]
  media: MediaItem[]
}

const RANGES = [
  { key: 'last7', label: 'Last 7 days' },
  { key: 'last30', label: 'Last 30 days' },
  { key: 'last90', label: 'Last 90 days' },
]
const compact = (n: number | null | undefined) =>
  n == null ? '—' : Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)

function pctDelta(cur: number, prev: number): number | null {
  if (!prev) return cur > 0 ? 100 : null
  return ((cur - prev) / prev) * 100
}

export default function AccountDashboardClient({ account, rangeKey, days, kpis, series, media }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const toast = useToast()
  const [syncing, startSync] = useTransition()

  const isIG = account.platform === 'instagram'

  const [contentTab, setContentTab] = useState<'posts' | 'reels' | 'stories'>('posts')
  const [sortMetric, setSortMetric] = useState<'reach' | 'views' | 'total_interactions' | 'engagement_rate' | 'shares' | 'saves'>('reach')

  const engRate = (m: { cur: number }, r: { cur: number }) => (r.cur > 0 ? (m.cur / r.cur) * 100 : 0)

  const kpiCards = useMemo(() => {
    const cards: Array<{ label: string; value: string; delta: number | null; show: boolean }> = [
      { label: 'Followers', value: compact(kpis.followersNow), delta: kpis.followersPrev != null && kpis.followersNow != null ? pctDelta(kpis.followersNow, kpis.followersPrev) : null, show: true },
      { label: 'Reach', value: compact(kpis.reach.cur), delta: pctDelta(kpis.reach.cur, kpis.reach.prev), show: true },
      { label: 'Views', value: compact(kpis.views.cur), delta: pctDelta(kpis.views.cur, kpis.views.prev), show: true },
      { label: 'Engagement', value: compact(kpis.interactions.cur), delta: pctDelta(kpis.interactions.cur, kpis.interactions.prev), show: true },
      { label: 'Engagement rate', value: `${engRate(kpis.interactions, kpis.reach).toFixed(1)}%`, delta: null, show: true },
      { label: 'Profile taps', value: compact(kpis.profileTaps.cur), delta: pctDelta(kpis.profileTaps.cur, kpis.profileTaps.prev), show: isIG },
      { label: 'Page views', value: compact(kpis.pageViews.cur), delta: pctDelta(kpis.pageViews.cur, kpis.pageViews.prev), show: !isIG },
    ]
    return cards.filter((c) => c.show)
  }, [kpis, isIG])

  const content = useMemo(() => {
    const posts = media.filter((m) => !m.is_story && m.media_product_type !== 'REELS' && m.media_product_type !== 'STORY')
    const reels = media.filter((m) => m.media_product_type === 'REELS')
    const stories = media.filter((m) => m.is_story || m.media_product_type === 'STORY')
    const pick = contentTab === 'posts' ? posts : contentTab === 'reels' ? reels : stories
    const sorted = [...pick].sort((a, b) => (Number(b[sortMetric] ?? 0) - Number(a[sortMetric] ?? 0)))
    return { posts, reels, stories, sorted }
  }, [media, contentTab, sortMetric])

  const setRange = (key: string) => {
    const p = new URLSearchParams()
    p.set('range', key)
    router.push(`${pathname}?${p.toString()}`)
  }

  const hasData = series.length > 0 || media.length > 0

  return (
    <>
      <Header
        title={account.name}
        subtitle={
          <span className="flex items-center gap-1.5">
            <PlatformIcon platform={account.platform} className="w-3.5 h-3.5" />
            {account.username ? `@${account.username}` : account.platform === 'instagram' ? 'Instagram' : 'Facebook Page'}
            <span className="text-muted-foreground">· {account.client_name}</span>
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            <a href={`/api/social/report?clientId=${account.client_id}&days=${days}`} target="_blank" rel="noopener noreferrer">
              <Button size="sm" variant="ghost"><ExternalLink className="w-4 h-4 mr-1.5" /> Report</Button>
            </a>
            <AppSelect value={rangeKey} onChange={(e) => setRange(e.target.value)} wrapperClassName="w-auto">
              {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </AppSelect>
            <Button
              size="sm"
              variant="secondary"
              disabled={syncing}
              onClick={() => startSync(async () => {
                const res = await syncAccountNow(account.id)
                if (!res.ok) toast.error('Sync failed', res.error)
                else { toast.success('Synced', `${res.data?.dailyRows ?? 0} days · ${res.data?.mediaItems ?? 0} items`); router.refresh() }
              })}
            >
              {syncing ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1.5" />}
              Sync now
            </Button>
          </div>
        }
      />

      <div className="px-4 sm:px-6 pb-16 max-w-[1400px] mx-auto w-full space-y-4">
        {account.status === 'needs_reauth' && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
            This account needs re-authorization — reconnect Meta to resume syncing and publishing.
          </div>
        )}

        {!hasData ? (
          <Card><CardContent className="p-0">
            <EmptyState
              icon={BarChart3}
              title="No insight data yet"
              body="Run the first sync to pull reach, views, engagement and recent content from Meta. After that, the daily sync keeps it current automatically."
              action={{ label: 'Run first sync', onClick: () => startSync(async () => { const r = await syncAccountNow(account.id); if (r.ok) router.refresh(); else toast.error('Sync failed', r.error) }) }}
            />
          </CardContent></Card>
        ) : (
          <>
            {/* KPI cards */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2.5">
              {kpiCards.map((c) => (
                <div key={c.label} className="rounded-xl border border-border bg-card px-3 py-3">
                  <div className="text-xs text-muted-foreground">{c.label}</div>
                  <div className="text-2xl font-semibold text-foreground mt-1 tabular-nums">{c.value}</div>
                  {c.delta != null && (
                    <div className={`text-xs mt-1 inline-flex items-center gap-0.5 ${c.delta >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {c.delta >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                      {Math.abs(c.delta).toFixed(1)}%
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <Card className="lg:col-span-2">
                <CardContent className="pt-4">
                  <div className="text-sm font-medium mb-3 flex items-center gap-1.5"><Eye className="w-4 h-4" /> Reach & Views</div>
                  <ReachViewsArea data={series.map((s) => ({ date: s.date, reach: s.reach, views: s.views }))} />
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4">
                  <div className="text-sm font-medium mb-3 flex items-center gap-1.5"><Users className="w-4 h-4" /> Follower trend</div>
                  {series.some((s) => s.followers != null)
                    ? <FollowerLine data={series.map((s) => ({ date: s.date, followers: s.followers }))} />
                    : <div className="h-[180px] flex items-center justify-center text-xs text-muted-foreground">No follower snapshots in range</div>}
                </CardContent>
              </Card>
            </div>

            {/* Content */}
            <Card>
              <CardContent className="pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  <div className="flex items-center gap-1">
                    {(['posts', 'reels', 'stories'] as const).map((t) => {
                      if (t === 'stories' && !isIG) return null
                      const count = t === 'posts' ? content.posts.length : t === 'reels' ? content.reels.length : content.stories.length
                      return (
                        <button
                          key={t}
                          onClick={() => setContentTab(t)}
                          className={`px-3 py-1.5 text-sm font-medium rounded-lg capitalize transition-colors ${
                            contentTab === t ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {t} <span className="opacity-60">{count}</span>
                        </button>
                      )
                    })}
                  </div>
                  <AppSelect value={sortMetric} onChange={(e) => setSortMetric(e.target.value as typeof sortMetric)} wrapperClassName="w-auto">
                    <option value="reach">Top reach</option>
                    <option value="views">Top views</option>
                    <option value="total_interactions">Top engagement</option>
                    <option value="engagement_rate">Top engagement rate</option>
                    <option value="shares">Top shares</option>
                    <option value="saves">Top saves</option>
                  </AppSelect>
                </div>

                {content.sorted.length === 0 ? (
                  <div className="py-10 text-center text-sm text-muted-foreground">No {contentTab} in this range.</div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {content.sorted.slice(0, 12).map((m) => <ContentCard key={m.id} m={m} />)}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {account.last_synced_at ? `Last synced ${formatDistanceToNow(new Date(account.last_synced_at), { addSuffix: true })}` : 'Never synced'}
            {account.last_error ? ` · ${account.last_error}` : ''}
          </span>
          <Link href="/dashboard/social" className="text-primary hover:underline">← All accounts</Link>
        </div>
      </div>

      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
    </>
  )
}

function ContentCard({ m }: { m: MediaItem }) {
  return (
    <div className="rounded-xl border border-border overflow-hidden bg-card">
      <div className="aspect-video bg-secondary flex items-center justify-center overflow-hidden">
        {m.thumbnail_url
          ? // eslint-disable-next-line @next/next/no-img-element
            <img src={m.thumbnail_url} alt="" className="w-full h-full object-cover" />
          : <ImageIcon className="w-6 h-6 text-muted-foreground" />}
      </div>
      <div className="p-3">
        <div className="flex items-center justify-between mb-1.5">
          <Badge variant={m.media_product_type === 'REELS' ? 'purple' : m.is_story || m.media_product_type === 'STORY' ? 'info' : 'default'}>
            {m.media_product_type === 'REELS' ? 'Reel' : m.is_story || m.media_product_type === 'STORY' ? 'Story' : 'Post'}
          </Badge>
          {m.permalink && <a href={m.permalink} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary"><ExternalLink className="w-3.5 h-3.5" /></a>}
        </div>
        {m.caption && <p className="text-xs text-muted-foreground line-clamp-2 mb-2">{m.caption}</p>}
        <div className="grid grid-cols-3 gap-1 text-xs">
          <Metric label="Reach" v={m.reach} />
          <Metric label="Views" v={m.views} />
          <Metric icon={<Heart className="w-3 h-3" />} v={m.likes} />
          <Metric label="Comments" v={m.comments} />
          <Metric label="Shares" v={m.shares} />
          <Metric label="Saves" v={m.saves} />
        </div>
        {m.engagement_rate != null && (
          <div className="text-xs text-muted-foreground mt-1.5">Eng. rate {Number(m.engagement_rate).toFixed(1)}%</div>
        )}
      </div>
    </div>
  )
}

function Metric({ label, v, icon }: { label?: string; v: number | null; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="text-muted-foreground flex items-center gap-0.5 text-[10px]">{icon}{label}</span>
      <span className="text-foreground tabular-nums font-medium">{v == null ? '—' : Intl.NumberFormat('en', { notation: 'compact' }).format(v)}</span>
    </div>
  )
}

function ChartSkeleton({ h }: { h: number }) {
  return <div className="w-full animate-pulse rounded-lg bg-secondary/50" style={{ height: h }} />
}

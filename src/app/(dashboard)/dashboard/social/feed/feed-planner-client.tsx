'use client'

/**
 * Instagram Feed Planner.
 *
 * The point is fidelity: three columns, square crops, newest at the top-left —
 * because a feed is judged as a whole, and a mockup that does not match what
 * Instagram renders is worse than none. Planned creatives sit above a divider,
 * real published posts below it, so you see exactly how new work will land
 * against what is already there.
 *
 * Ordering is decided by the shared engine (@/lib/social/feed-grid); this file
 * only presents it and reports drags back.
 */

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Header from '@/components/layout/header'
import AppSelect from '@/components/ui/app-select'
import { EmptyState } from '@/components/ui/empty-state'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { createSignedMediaUpload } from '../calendar/actions'
import { createClient } from '@/lib/supabase/client'
import {
  FEED_STATUS_CHIP, FEED_STATUS_LABEL, type FeedTile,
} from '@/lib/social/feed-grid'
import { analyseHarmony, type TileColor, type HarmonyReport } from '@/lib/social/feed-harmony'
import { aspectClass, FEED_ASPECT_OPTIONS, type FeedAspect } from '@/lib/social/feed-aspect'
import { setFeedAspect } from './actions'
import {
  addFeedCreative, moveFeedTile, unplaceFeedTile, deleteFeedCreative,
  sendFeedForApproval, createFeedShareLink,
} from './actions'
import {
  Upload, Grid3x3, Loader2, Trash2, Send, Link2, Play, X,
  Calendar, MessageSquare, Heart, ExternalLink, GripVertical, Palette, AlertTriangle,
} from 'lucide-react'

interface Account {
  id: string; name: string; username: string | null; client_id: string | null
  /** 'cirqle' = one of our own accounts, which correctly has no client. */
  owner_type: string | null
  profile_picture_url: string | null; followers_count: number | null
}

const fmtNum = (n: number | null) => {
  const v = Number(n ?? 0)
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return v.toLocaleString('en-IN')
}

/**
 * Average colour of an image, sampled on a tiny canvas.
 *
 * Downscaling to 16×16 IS the averaging — the browser's own resampler does the
 * work, far faster than reading every pixel of a full-size creative.
 *
 * Returns null rather than throwing when the image is cross-origin-tainted or
 * fails to load; one unreadable creative must not break the whole check.
 */
async function averageColor(url: string): Promise<{ r: number; g: number; b: number } | null> {
  return new Promise(resolve => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const size = 16
        const canvas = document.createElement('canvas')
        canvas.width = size; canvas.height = size
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return resolve(null)
        ctx.drawImage(img, 0, 0, size, size)
        const { data } = ctx.getImageData(0, 0, size, size)
        let r = 0, g = 0, b = 0, n = 0
        for (let i = 0; i < data.length; i += 4) {
          // Skip near-transparent pixels — they are not part of the artwork.
          if (data[i + 3] < 16) continue
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++
        }
        if (!n) return resolve(null)
        resolve({ r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) })
      } catch {
        resolve(null)   // tainted canvas
      }
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

const fmtDate = (iso: string | null) => {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export default function FeedPlannerClient({
  accounts, selectedId, profile, tiles, plannedCount, publishedCount,
  shareLinks, canPlan, aspect,
}: {
  accounts: Account[]
  selectedId: string | null
  profile: Account | null
  tiles: FeedTile[]
  plannedCount: number
  publishedCount: number
  shareLinks: { id: string; token: string; label: string | null; expires_at: string | null }[]
  canPlan: boolean
  aspect: FeedAspect
}) {
  const router = useRouter()
  const { toasts, dismiss, success, error: toastError } = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const [detail, setDetail] = useState<FeedTile | null>(null)
  const [harmony, setHarmony] = useState<HarmonyReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<FeedTile | null>(null)
  // Instagram has changed its grid crop before; this is a setting so the next
  // change is a dropdown rather than a code change.
  const tileAspect = aspectClass(aspect)

  const plannedIds = useMemo(
    () => tiles.filter(t => t.kind === 'planned').map(t => t.id),
    [tiles],
  )

  function switchAccount(id: string) {
    router.push(`/dashboard/social/feed?account=${id}`)
  }

  // ── Upload ────────────────────────────────────────────────────────────────
  async function handleFiles(files: FileList | null) {
    if (!files?.length || !profile) return
    // A missing client is only a problem on a CLIENT-owned account. Our own
    // accounts (@cirqle.works) have none by design and are grouped in Asset
    // Assignment as "excluded from all client reporting" — telling someone to
    // go and assign one there is advice that cannot be followed.
    if (!profile.client_id && profile.owner_type === 'client') {
      toastError('No client on this account', 'Assign it to a client in Asset Assignment first.')
      return
    }
    setUploading(true)
    const supabase = createClient()
    let added = 0
    try {
      for (const file of Array.from(files)) {
        const signed = await createSignedMediaUpload(profile.client_id, file.name)
        if (!signed.ok || !signed.data) { toastError('Upload failed', signed.error); continue }
        const { error } = await supabase.storage
          .from('social-media')
          .uploadToSignedUrl(signed.data.path, signed.data.token, file)
        if (error) { toastError('Upload failed', error.message); continue }

        const res = await addFeedCreative({
          accountId: profile.id,
          clientId: profile.client_id,
          mediaUrl: signed.data.publicUrl,
          storagePath: signed.data.path,
          contentType: file.type.startsWith('video/') ? 'video' : 'image',
        })
        if (!res.ok) { toastError('Could not add to the grid', res.error); continue }
        added++
      }
      if (added) {
        success(`${added} creative${added === 1 ? '' : 's'} added`, 'Drag to arrange the grid.')
        router.refresh()
      }
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  // ── Reorder ───────────────────────────────────────────────────────────────
  async function drop(toIndex: number) {
    const movedId = dragId
    setDragId(null); setOverIndex(null)
    if (!movedId || !profile) return
    const from = plannedIds.indexOf(movedId)
    if (from === -1 || from === toIndex) return

    setBusy(movedId)
    const res = await moveFeedTile({
      accountId: profile.id, plannedIds, movedId, toIndex,
    })
    setBusy(null)
    if (!res.ok) toastError('Could not reorder', res.error)
    else router.refresh()
  }

  async function handleUnplace(t: FeedTile) {
    setBusy(t.id)
    const res = await unplaceFeedTile(t.id)
    setBusy(null)
    if (res.ok) { success('Removed from the grid', 'The creative is kept as a draft.'); router.refresh() }
    else toastError('Could not remove', res.error)
  }

  async function handleDelete(t: FeedTile) {
    setBusy(t.id)
    const res = await deleteFeedCreative(t.id)
    setBusy(null)
    if (res.ok) { success('Creative deleted'); router.refresh() }
    else toastError('Could not delete', res.error)
  }

  async function handleSendForApproval() {
    if (!profile) return
    setBusy('approval')
    const res = await sendFeedForApproval(profile.id)
    setBusy(null)
    if (!res.ok) { toastError('Could not send', res.error); return }
    const { sent = 0, skipped = 0 } = res.data ?? {}
    success(
      sent ? `${sent} creative${sent === 1 ? '' : 's'} sent for approval` : 'Nothing to send',
      skipped ? `${skipped} skipped — no image yet.` : undefined,
    )
    router.refresh()
  }

  async function handleShare() {
    if (!profile) return
    setBusy('share')
    const res = await createFeedShareLink({
      accountId: profile.id, clientId: profile.client_id, expiresInDays: 30,
    })
    setBusy(null)
    if (!res.ok || !res.data) { toastError('Could not create link', res.error); return }
    const url = `${window.location.origin}/feed/${res.data.token}`
    try { await navigator.clipboard.writeText(url) } catch { /* clipboard blocked */ }
    success('Client link copied', 'Read-only, expires in 30 days.')
    router.refresh()
  }

  /**
   * Sample each tile's average colour and ask the shared analyser what it makes
   * of the grid. Runs on demand rather than on every render — it decodes every
   * image, which is not something to do while someone is dragging tiles.
   */
  async function changeAspect(next: string) {
    const res = await setFeedAspect(next)
    if (res.ok) { success('Grid ratio updated', 'The client preview matches too.'); router.refresh() }
    else toastError('Could not change the ratio', res.error)
  }

  async function runHarmonyCheck() {
    setChecking(true)
    try {
      const colors: TileColor[] = []
      for (const t of tiles) {
        if (!t.imageUrl) continue
        try {
          const color = await averageColor(t.imageUrl)
          if (color) colors.push({ key: t.key, ...color })
        } catch { /* a single unreadable image must not fail the check */ }
      }
      setHarmony(analyseHarmony({ colors }))
    } finally {
      setChecking(false)
    }
  }

  if (accounts.length === 0) {
    return (
      <>
        <Header title="Feed Planner" subtitle="Plan an Instagram grid before anything goes live" />
        <div className="p-4 md:p-6 max-w-3xl">
          <div className="rounded-xl border border-border bg-card">
            <EmptyState
              icon={Grid3x3}
              title="No Instagram accounts connected"
              body="Connect Meta in Connections, then assign the Instagram account to its client. The feed grid appears here once an account is available."
              action={{ label: 'Go to Connections', onClick: () => { window.location.href = '/dashboard/connections' } }}
            />
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <Header
        title="Feed Planner"
        subtitle="Arrange creatives exactly as they will appear on the profile"
        actions={canPlan ? (
          <div className="flex items-center gap-2">
            <input ref={fileRef} type="file" accept="image/*,video/*" multiple hidden
              onChange={e => handleFiles(e.target.files)} />
            <button onClick={() => fileRef.current?.click()} disabled={uploading}
              className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity whitespace-nowrap">
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              {uploading ? 'Uploading…' : 'Add creatives'}
            </button>
          </div>
        ) : undefined}
      />

      <div className="p-4 md:p-6 space-y-4 max-w-3xl">
        <div className="flex flex-wrap items-center gap-2">
          {accounts.length > 1 && (
            <AppSelect value={selectedId ?? ''} onChange={e => switchAccount(e.target.value)} wrapperClassName="max-w-xs">
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.username ? `@${a.username}` : a.name}</option>
              ))}
            </AppSelect>
          )}
          {/* Instagram has changed its grid crop before and will again — so it
              is a setting here, not a constant in the code. */}
          {canPlan && (
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              Grid crop
              <AppSelect value={aspect} onChange={e => changeAspect(e.target.value)} wrapperClassName="w-40">
                {FEED_ASPECT_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </AppSelect>
            </label>
          )}
        </div>

        {/* Profile header — the mock exists so the grid is judged in context,
            the way the client will actually meet it. */}
        {profile && (
          <div className="rounded-xl border border-border bg-card p-4 flex items-center gap-4">
            {profile.profile_picture_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={profile.profile_picture_url} alt="" className="w-16 h-16 rounded-full object-cover border border-border" />
            ) : (
              <div className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center text-lg font-semibold">
                {(profile.username ?? profile.name).slice(0, 2).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <p className="font-semibold text-sm truncate">
                {profile.username ? `@${profile.username}` : profile.name}
              </p>
              <div className="flex gap-4 mt-1 text-[11px] text-muted-foreground">
                <span><span className="font-semibold text-foreground tabular-nums">{publishedCount}</span> posts</span>
                <span><span className="font-semibold text-foreground tabular-nums">{fmtNum(profile.followers_count)}</span> followers</span>
                <span><span className="font-semibold text-violet-500 tabular-nums">{plannedCount}</span> planned</span>
              </div>
            </div>
            {canPlan && plannedCount > 0 && (
              <div className="ml-auto flex items-center gap-2">
                <button onClick={runHarmonyCheck} disabled={checking}
                  title="Check how the grid hangs together visually"
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-secondary transition-colors disabled:opacity-50">
                  {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Palette className="w-3.5 h-3.5" />}
                  {checking ? 'Checking…' : 'Colour check'}
                </button>
                <button onClick={handleShare} disabled={busy === 'share'}
                  title="Create a read-only link for the client"
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-secondary transition-colors disabled:opacity-50">
                  <Link2 className="w-3.5 h-3.5" /> Share
                </button>
                <button onClick={handleSendForApproval} disabled={busy === 'approval'}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300 hover:bg-amber-500/20 transition-colors disabled:opacity-50">
                  <Send className="w-3.5 h-3.5" /> Send for approval
                </button>
              </div>
            )}
          </div>
        )}

        {shareLinks.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            {shareLinks.length} active client link{shareLinks.length === 1 ? '' : 's'} — anyone with the URL can view this plan.
          </p>
        )}

        {/* Colour harmony — advisory only. A deliberate clash is a legitimate
            choice, so this reports observations and never blocks anything. */}
        {harmony && (
          <div className="rounded-xl border border-border bg-card px-4 py-3 space-y-2">
            <div className="flex items-center gap-2">
              <Palette className="w-3.5 h-3.5 text-primary shrink-0" />
              <p className="text-xs font-semibold">Colour harmony</p>
              <span className={`text-[11px] tabular-nums font-medium ${
                harmony.score >= 80 ? 'text-emerald-500'
                  : harmony.score >= 55 ? 'text-amber-500' : 'text-red-500'}`}>
                {harmony.score}/100
              </span>
              <span className="text-[10px] text-muted-foreground">
                avg brightness {harmony.averageBrightness}/255
              </span>
              <button onClick={() => setHarmony(null)} className="ml-auto text-muted-foreground hover:text-foreground">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            {harmony.findings.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                Nothing stands out — the grid reads as a set.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {harmony.findings.map((f, i) => (
                  <li key={i} className="flex items-start gap-2 text-[11px] text-muted-foreground">
                    <AlertTriangle className={`w-3 h-3 shrink-0 mt-0.5 ${
                      f.severity === 'warn' ? 'text-amber-500' : 'text-muted-foreground/60'}`} />
                    <span>{f.message}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[10px] text-muted-foreground/70">
              Advisory only — a deliberate contrast is a design choice, not a mistake.
            </p>
          </div>
        )}

        {/* ── The grid ── */}
        {tiles.length === 0 ? (
          <div className="rounded-xl border border-border bg-card">
            <EmptyState
              icon={Grid3x3}
              title="Nothing in the feed yet"
              body="Add your creatives and drag them into the order you want. You will see the grid exactly as the client will — and nothing goes live until you schedule it."
              action={canPlan ? { label: 'Add creatives', onClick: () => fileRef.current?.click() } : undefined}
            />
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card p-2">
            <div className="grid grid-cols-3 gap-1">
              {tiles.map((t, i) => {
                const planned = t.kind === 'planned'
                const idx = planned ? plannedIds.indexOf(t.id) : -1
                const isDragging = dragId === t.id
                return (
                  <div
                    key={t.key}
                    draggable={canPlan && planned}
                    onDragStart={() => planned && setDragId(t.id)}
                    onDragEnd={() => { setDragId(null); setOverIndex(null) }}
                    onDragOver={e => { if (planned && dragId) { e.preventDefault(); setOverIndex(idx) } }}
                    onDrop={e => { if (planned && dragId) { e.preventDefault(); void drop(idx) } }}
                    onClick={() => setDetail(t)}
                    className={`relative ${tileAspect} group cursor-pointer overflow-hidden bg-secondary transition-all ${
                      isDragging ? 'opacity-30' : ''
                    } ${overIndex === idx && dragId && !isDragging ? 'ring-2 ring-primary ring-inset' : ''}`}
                  >
                    {t.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={t.imageUrl} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[10px] text-muted-foreground px-2 text-center">
                        No image yet
                      </div>
                    )}

                    {/* Planned tiles are visibly not-yet-live: a violet edge and
                        a status chip. Published ones stay clean, as on IG. */}
                    {planned && <div className="absolute inset-0 ring-1 ring-inset ring-violet-500/40 pointer-events-none" />}

                    {t.isVideo && (
                      <Play className="absolute top-1.5 right-1.5 w-3.5 h-3.5 text-white drop-shadow" />
                    )}

                    <div className="absolute top-1 left-1 right-1 flex items-start gap-1">
                      <span className={`text-[9px] px-1 py-0.5 rounded border leading-none ${FEED_STATUS_CHIP[t.status]}`}>
                        {FEED_STATUS_LABEL[t.status]}
                      </span>
                      {canPlan && planned && (
                        <GripVertical className="ml-auto w-3 h-3 text-white/70 opacity-0 group-hover:opacity-100 drop-shadow" />
                      )}
                    </div>

                    {/* Date badge — the answer to "when does this go out?"
                        without opening anything. */}
                    {fmtDate(t.date) && (
                      <span className="absolute bottom-1 left-1 text-[9px] px-1 py-0.5 rounded bg-black/60 text-white leading-none flex items-center gap-0.5">
                        <Calendar className="w-2.5 h-2.5" /> {fmtDate(t.date)}
                      </span>
                    )}

                    {!planned && (t.likes != null || t.comments != null) && (
                      <div className="absolute inset-0 bg-black/55 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-3 text-white text-[11px] font-medium">
                        {t.likes != null && <span className="flex items-center gap-1"><Heart className="w-3 h-3" />{fmtNum(t.likes)}</span>}
                        {t.comments != null && <span className="flex items-center gap-1"><MessageSquare className="w-3 h-3" />{fmtNum(t.comments)}</span>}
                      </div>
                    )}

                    {busy === t.id && (
                      <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                        <Loader2 className="w-4 h-4 text-white animate-spin" />
                      </div>
                    )}

                    {/* The seam between plan and reality. */}
                    {planned && i === plannedCount - 1 && publishedCount > 0 && (
                      <span className="absolute -bottom-px left-0 right-0 h-0.5 bg-violet-500/60" />
                    )}
                  </div>
                )
              })}
            </div>

            {plannedCount > 0 && publishedCount > 0 && (
              <p className="text-[10px] text-muted-foreground mt-2 px-1">
                Everything above the violet line is planned and not yet on Instagram.
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── Tile detail ── */}
      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => setDetail(null)}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-sm overflow-hidden shadow-2xl"
            onClick={e => e.stopPropagation()}>
            {detail.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={detail.imageUrl} alt="" className={`w-full ${tileAspect} object-cover`} />
            )}
            <div className="p-4 space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-[10px] px-1.5 py-0.5 rounded border ${FEED_STATUS_CHIP[detail.status]}`}>
                  {FEED_STATUS_LABEL[detail.status]}
                </span>
                {fmtDate(detail.date) && (
                  <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                    <Calendar className="w-3 h-3" /> {fmtDate(detail.date)}
                  </span>
                )}
                <button onClick={() => setDetail(null)} className="ml-auto text-muted-foreground hover:text-foreground">
                  <X className="w-4 h-4" />
                </button>
              </div>

              {detail.reviewNote && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
                  <p className="text-[10px] font-medium text-red-600 dark:text-red-300 mb-0.5">Client asked for changes</p>
                  <p className="text-[11px] text-muted-foreground">{detail.reviewNote}</p>
                </div>
              )}

              {detail.caption ? (
                <p className="text-xs whitespace-pre-wrap leading-relaxed">{detail.caption}</p>
              ) : (
                <p className="text-xs text-muted-foreground italic">No caption yet.</p>
              )}
              {detail.hashtags && (
                <p className="text-[11px] text-primary break-words">{detail.hashtags}</p>
              )}

              <div className="flex items-center gap-2 pt-1">
                {detail.permalink && (
                  <a href={detail.permalink} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-secondary transition-colors">
                    <ExternalLink className="w-3.5 h-3.5" /> View on Instagram
                  </a>
                )}
                {canPlan && detail.kind === 'planned' && (
                  <>
                    <button onClick={() => { const d = detail; setDetail(null); void handleUnplace(d) }}
                      className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-secondary transition-colors">
                      Remove from grid
                    </button>
                    <button onClick={() => { setDeleteTarget(detail); setDetail(null) }}
                      className="ml-auto flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors">
                      <Trash2 className="w-3.5 h-3.5" /> Delete
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete this creative?"
          body="The image and any caption written for it are removed from the plan. Nothing on Instagram changes."
          confirmLabel="Delete"
          danger
          onConfirm={() => { const t = deleteTarget; setDeleteTarget(null); void handleDelete(t) }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </>
  )
}

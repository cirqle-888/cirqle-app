'use client'

/**
 * Post composer — client picker → account → content type (platform-aware) →
 * media upload → caption/hashtags/first comment/link → schedule → live
 * validation. Persists via the calendar server actions.
 */

import { useMemo, useRef, useState } from 'react'
import { createClient as createBrowserClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import AppSelect from '@/components/ui/app-select'
import { Badge } from '@/components/ui/badge'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { PlatformIcon } from '@/components/social-hub/platform-icon'
import {
  X, Upload, Loader2, AlertTriangle, Info, Trash2, ImageIcon,
} from 'lucide-react'
import {
  validateSocialPost, PLATFORM_CONTENT_SUPPORT,
  type MediaDescriptor, type SocialContentType, type SocialPlatform,
} from '@/lib/social-hub/validation'
import {
  createSocialPost, updateSocialPost, approvePost, publishPostNow, createSignedMediaUpload,
  crossPost, type CrossPostOutcome,
} from './actions'

/**
 * Stands in for a client in the picker when the post belongs to one of OUR
 * accounts. Not a UUID, so it can never collide with a real client id, and it
 * is translated back to NULL before anything is written.
 */
export const CIRQLE_OWNED = '__cirqle__'

export interface ComposerAccount {
  id: string; client_id: string | null; owner_type?: string | null; platform: SocialPlatform
  name: string; username: string | null; publishing_enabled: boolean; status: string
}
export interface ComposerEmployee { id: string; cqid: string | null; name: string | null }

export interface EditablePost {
  id: string; client_id: string; account_id: string; content_type: SocialContentType
  caption: string | null; hashtags: string | null; first_comment: string | null
  link_url: string | null; media: MediaDescriptor[]; cover_url: string | null
  share_to_feed: boolean; scheduled_at: string | null; status: string
  designer_id: string | null; assigned_to: string | null
}

const CONTENT_TYPES: { key: SocialContentType; label: string }[] = [
  { key: 'image', label: 'Single image' },
  { key: 'carousel', label: 'Carousel' },
  { key: 'reel', label: 'Reel' },
  { key: 'video', label: 'Video' },
  { key: 'story_image', label: 'Story (image)' },
  { key: 'story_video', label: 'Story (video)' },
  { key: 'text', label: 'Text' },
  { key: 'link', label: 'Link' },
]

async function readDimensions(file: File): Promise<Partial<MediaDescriptor>> {
  return new Promise((resolve) => {
    if (file.type.startsWith('image/')) {
      const img = new Image()
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
      img.onerror = () => resolve({})
      img.src = URL.createObjectURL(file)
    } else if (file.type.startsWith('video/')) {
      const v = document.createElement('video')
      v.preload = 'metadata'
      v.onloadedmetadata = () => resolve({ width: v.videoWidth, height: v.videoHeight, duration_s: Math.round(v.duration) })
      v.onerror = () => resolve({})
      v.src = URL.createObjectURL(file)
    } else resolve({})
  })
}

export function Composer({
  post, clients, accounts, employees, canApprove, defaultClientId, defaultDate, onClose, onSaved,
}: {
  post: EditablePost | null
  clients: { id: string; name: string }[]
  accounts: ComposerAccount[]
  employees: ComposerEmployee[]
  canApprove: boolean
  defaultClientId?: string
  defaultDate?: string // YYYY-MM-DD
  onClose: () => void
  onSaved: () => void
}) {
  const [clientId, setClientId] = useState(post?.client_id ?? defaultClientId ?? '')
  const [accountId, setAccountId] = useState(post?.account_id ?? '')
  const [contentType, setContentType] = useState<SocialContentType>(post?.content_type ?? 'image')
  const [caption, setCaption] = useState(post?.caption ?? '')
  const [hashtags, setHashtags] = useState(post?.hashtags ?? '')
  const [firstComment, setFirstComment] = useState(post?.first_comment ?? '')
  const [linkUrl, setLinkUrl] = useState(post?.link_url ?? '')
  const [media, setMedia] = useState<MediaDescriptor[]>(post?.media ?? [])
  const [scheduledAt, setScheduledAt] = useState<string>(
    post?.scheduled_at ? toLocalInput(post.scheduled_at) : (defaultDate ? `${defaultDate}T10:00` : ''),
  )
  const [assignedTo, setAssignedTo] = useState(post?.assigned_to ?? '')
  const [designerId, setDesignerId] = useState(post?.designer_id ?? '')
  const [uploading, setUploading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // Extra accounts to mirror this content to. Instagram and Facebook are
  // separate accounts on separate platforms — Meta has no single call for
  // both — so this creates one post each, from one filled-in form.
  const [alsoPostTo, setAlsoPostTo] = useState<string[]>([])
  const [outcomes, setOutcomes] = useState<CrossPostOutcome[] | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Cirqle's own accounts carry no client_id, so filtering by it could never
  // reach them — @cirqle.works was simply absent from the composer whatever
  // you picked.
  const clientAccounts = useMemo(
    () => accounts.filter(a => clientId === CIRQLE_OWNED
      ? (a.owner_type ?? 'client') === 'cirqle'
      : a.client_id === clientId),
    [accounts, clientId],
  )
  const hasOwnAccounts = useMemo(
    () => accounts.some(a => (a.owner_type ?? 'client') === 'cirqle'),
    [accounts],
  )
  /** NULL for our own accounts — that is what the column means there. */
  const payloadClientId = clientId === CIRQLE_OWNED ? null : (clientId || null)

  /** The client's OTHER connected accounts — the cross-post candidates. */
  const otherAccounts = useMemo(
    () => clientAccounts.filter(a => a.id !== accountId && a.publishing_enabled && a.status !== 'disconnected'),
    [clientAccounts, accountId],
  )
  const account = accounts.find((a) => a.id === accountId)
  const platform: SocialPlatform | null = account?.platform ?? null

  const availableTypes = useMemo(() => {
    if (!platform) return CONTENT_TYPES
    const support = PLATFORM_CONTENT_SUPPORT[platform]
    return CONTENT_TYPES.filter((t) => support?.[t.key] && support[t.key] !== 'not_supported')
  }, [platform])

  const validation = useMemo(() => {
    if (!platform) return { ok: false, errors: ['Select an account.'], warnings: [] as string[] }
    return validateSocialPost({
      platform, contentType, caption, hashtags, firstComment, linkUrl,
      media, scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
    })
  }, [platform, contentType, caption, hashtags, firstComment, linkUrl, media, scheduledAt])

  async function handleFiles(files: FileList | null) {
    if (!files || !clientId) { if (!clientId) setErr('Pick a client before uploading.'); return }
    // payloadClientId is null for our own accounts; the upload helper namespaces
    // those under `cirqle/` rather than a client id.
    setUploading(true); setErr(null)
    const supabase = createBrowserClient()
    const added: MediaDescriptor[] = []
    for (const file of Array.from(files)) {
      const signed = await createSignedMediaUpload(payloadClientId, file.name)
      if (!signed.ok || !signed.data) { setErr(signed.error ?? 'Upload failed'); continue }
      const { error } = await supabase.storage.from('social-media').uploadToSignedUrl(signed.data.path, signed.data.token, file)
      if (error) { setErr(error.message); continue }
      const dims = await readDimensions(file)
      added.push({
        url: signed.data.publicUrl,
        type: file.type.startsWith('video/') ? 'video' : 'image',
        mime: file.type, size_bytes: file.size, storage_path: signed.data.path, ...dims,
      })
    }
    setMedia((prev) => [...prev, ...added])
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  function buildPayload() {
    return {
      id: post?.id, client_id: payloadClientId, account_id: accountId, content_type: contentType,
      caption: caption || null, hashtags: hashtags || null,
      first_comment: platform === 'instagram' ? (firstComment || null) : null,
      link_url: contentType === 'link' ? (linkUrl || null) : null,
      media, cover_url: post?.cover_url ?? null, share_to_feed: true,
      scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
      designer_id: designerId || null, assigned_to: assignedTo || null,
    }
  }

  async function run(kind: 'draft' | 'approval' | 'approve' | 'publish') {
    setErr(null); setOutcomes(null); setBusy(kind)
    try {
      // Mirroring to other accounts only makes sense for NEW content; editing
      // an existing post edits that post.
      if (!post?.id && alsoPostTo.length) {
        const res = await crossPost(buildPayload(), [accountId, ...alsoPostTo], kind)
        if (res.data?.outcomes) setOutcomes(res.data.outcomes)
        if (!res.ok) { setErr(res.error ?? 'Nothing could be posted.'); return }
        // Some accounts may have been skipped; hold the sheet open so the
        // result is read rather than dismissed.
        if (res.data?.outcomes?.some(o => !o.ok)) return
        onSaved()
        return
      }
      const payload = buildPayload()
      // Save (create or update) first.
      let id = post?.id
      if (id) {
        const res = await updateSocialPost(id, payload)
        if (!res.ok) { setErr(res.error ?? 'Save failed'); return }
      } else {
        const res = await createSocialPost(payload, kind === 'approval' ? 'approval' : 'draft')
        if (!res.ok) { setErr(res.error ?? 'Save failed'); return }
        id = res.data?.id
      }
      if (!id) { onSaved(); return }

      if (kind === 'approve') {
        const res = await approvePost(id)
        if (!res.ok) { setErr(res.error ?? 'Approve failed'); return }
      } else if (kind === 'publish') {
        const res = await publishPostNow(id)
        if (!res.ok) { setErr(res.error ?? 'Publish failed'); return }
      }
      onSaved()
    } finally {
      setBusy(null)
    }
  }

  const igStory = platform === 'instagram' && (contentType === 'story_image' || contentType === 'story_video')

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="bg-card w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-card z-10">
          <h2 className="text-base font-semibold">{post ? 'Edit post' : 'New post'}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Left: target + media */}
          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground">Client</label>
              <AppSelect value={clientId} onChange={(e) => { setClientId(e.target.value); setAccountId('') }} className="mt-1">
                <option value="">Select client…</option>
                {/* Our own accounts first: they belong to nobody in the client
                    list, and posting to @cirqle.works is a normal thing to do. */}
                {hasOwnAccounts && <option value={CIRQLE_OWNED}>Cirqle — our own accounts</option>}
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </AppSelect>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Account</label>
              <AppSelect value={accountId} onChange={(e) => setAccountId(e.target.value)} className="mt-1" disabled={!clientId}>
                <option value="">{clientId ? 'Select account…' : 'Pick a client first'}</option>
                {clientAccounts.map((a) => (
                  <option key={a.id} value={a.id} disabled={!a.publishing_enabled || a.status !== 'connected'}>
                    {a.platform === 'instagram' ? 'IG' : 'FB'} · {a.name}{a.username ? ` (@${a.username})` : ''}{!a.publishing_enabled ? ' — publishing off' : ''}
                  </option>
                ))}
              </AppSelect>
              {account && <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><PlatformIcon platform={account.platform} className="w-3.5 h-3.5" />{account.platform === 'instagram' ? 'Instagram' : 'Facebook Page'}</div>}
            </div>
            {/* Cross-post. Only for new content: editing a post edits that post. */}
            {!post?.id && otherAccounts.length > 0 && (
              <div className="rounded-lg border border-border bg-secondary/40 p-2.5">
                <p className="text-xs font-medium">Also post to</p>
                <p className="text-[10px] text-muted-foreground mt-0.5 mb-1.5">
                  One post per account — Meta has no single call for both.
                </p>
                <div className="space-y-1">
                  {otherAccounts.map(a => (
                    <label key={a.id} className="flex items-center gap-2 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={alsoPostTo.includes(a.id)}
                        onChange={e => setAlsoPostTo(prev =>
                          e.target.checked ? [...prev, a.id] : prev.filter(x => x !== a.id))}
                        className="rounded border-border"
                      />
                      <PlatformIcon platform={a.platform} className="w-3.5 h-3.5" />
                      <span>{a.username ?? a.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div>
              <label className="text-xs text-muted-foreground">Content type</label>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {availableTypes.map((t) => {
                  const support = platform ? PLATFORM_CONTENT_SUPPORT[platform]?.[t.key] : undefined
                  return (
                    <button
                      key={t.key}
                      onClick={() => setContentType(t.key)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                        contentType === t.key ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {t.label}{support === 'limited' && <span className="ml-1 opacity-60">·limited</span>}
                    </button>
                  )
                })}
              </div>
            </div>

            {contentType !== 'text' && contentType !== 'link' && (
              <div>
                <label className="text-xs text-muted-foreground">Media</label>
                <div className="mt-1 grid grid-cols-3 gap-2">
                  {media.map((m, i) => (
                    <div key={i} className="relative aspect-square rounded-lg overflow-hidden border border-border bg-secondary group">
                      {m.type === 'image'
                        ?   <img src={m.url} alt="" className="w-full h-full object-cover" />
                        : <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs">Video</div>}
                      <button onClick={() => setMedia((prev) => prev.filter((_, x) => x !== i))} className="absolute top-1 right-1 bg-black/60 rounded p-0.5 opacity-0 group-hover:opacity-100"><Trash2 className="w-3 h-3 text-white" /></button>
                    </div>
                  ))}
                  <button
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading || !clientId}
                    className="aspect-square rounded-lg border border-dashed border-border flex flex-col items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    {uploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Upload className="w-5 h-5" /><span className="text-[10px] mt-1">Upload</span></>}
                  </button>
                </div>
                <input
                  ref={fileRef} type="file" hidden multiple={contentType === 'carousel'}
                  accept={contentType.includes('video') || contentType === 'reel' ? 'video/*' : 'image/jpeg,image/jpg'}
                  onChange={(e) => handleFiles(e.target.files)}
                />
              </div>
            )}
          </div>

          {/* Right: text + schedule */}
          <div className="space-y-3">
            {contentType !== 'link' && (
              <div>
                <label className="text-xs text-muted-foreground flex justify-between"><span>Caption</span><span className="opacity-60">{caption.length}{platform === 'instagram' ? '/2200' : ''}</span></label>
                <textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={4} className="mt-1 w-full rounded-lg bg-secondary text-sm border border-border p-2.5 focus:outline-none focus:ring-1 focus:ring-primary" placeholder="Write a caption…" />
              </div>
            )}
            {contentType === 'link' && (
              <div><label className="text-xs text-muted-foreground">Link URL</label><input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} className="mt-1 w-full h-9 px-3 rounded-lg bg-secondary text-sm border border-border" placeholder="https://…" /></div>
            )}
            {contentType !== 'link' && contentType !== 'text' && (
              <div><label className="text-xs text-muted-foreground">Hashtags</label><input value={hashtags} onChange={(e) => setHashtags(e.target.value)} className="mt-1 w-full h-9 px-3 rounded-lg bg-secondary text-sm border border-border" placeholder="#brand #campaign" /></div>
            )}
            {platform === 'instagram' && !igStory && (
              <div><label className="text-xs text-muted-foreground">First comment (optional)</label><input value={firstComment} onChange={(e) => setFirstComment(e.target.value)} className="mt-1 w-full h-9 px-3 rounded-lg bg-secondary text-sm border border-border" placeholder="Posted right after publish" /></div>
            )}
            <div>
              <label className="text-xs text-muted-foreground">Schedule (leave empty to publish now / keep as draft)</label>
              <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className="mt-1 w-full h-9 px-3 rounded-lg bg-secondary text-sm border border-border" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div><label className="text-xs text-muted-foreground">Designer</label><AppSelect value={designerId} onChange={(e) => setDesignerId(e.target.value)} className="mt-1"><option value="">—</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.cqid || e.name}</option>)}</AppSelect></div>
              <div><label className="text-xs text-muted-foreground">Assigned</label><AppSelect value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} className="mt-1"><option value="">—</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.cqid || e.name}</option>)}</AppSelect></div>
            </div>
          </div>
        </div>

        {/* Validation feedback */}
        {(validation.errors.length > 0 || validation.warnings.length > 0 || err) && (
          <div className="px-4 space-y-1.5">
            {outcomes && (
            <div className="rounded-lg border border-border bg-secondary/40 p-2.5 space-y-1">
              {outcomes.map(o => (
                <div key={o.accountId} className="flex items-start gap-2 text-xs">
                  <span className={o.ok ? 'text-green-500' : 'text-amber-500'}>{o.ok ? '✓' : '—'}</span>
                  <span className="font-medium shrink-0">{o.accountLabel}</span>
                  <span className="text-muted-foreground">{o.ok ? 'posted' : o.error}</span>
                </div>
              ))}
            </div>
          )}

          {err && <div className="text-xs text-red-400 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" />{err}</div>}
            {validation.errors.map((e, i) => <div key={i} className="text-xs text-red-400 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0" />{e}</div>)}
            {validation.warnings.map((w, i) => <div key={i} className="text-xs text-amber-400 flex items-center gap-1.5"><Info className="w-3.5 h-3.5 shrink-0" />{w}</div>)}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 p-4 border-t border-border mt-3 sticky bottom-0 bg-card">
          <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => run('draft')}>{busy === 'draft' && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}Save draft</Button>
          <Button variant="secondary" size="sm" disabled={!!busy || !validation.ok} onClick={() => run('approval')}>Send for approval</Button>
          {canApprove && scheduledAt && (
            <Button size="sm" disabled={!!busy || !validation.ok} onClick={() => run('approve')}>{busy === 'approve' && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}Approve & schedule</Button>
          )}
          {canApprove && !scheduledAt && (
            <Button size="sm" disabled={!!busy || !validation.ok} onClick={() => run('publish')}>{busy === 'publish' && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}Publish now</Button>
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}

/** ISO → value for <input type="datetime-local"> in local time. */
function toLocalInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

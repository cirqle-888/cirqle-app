'use client'

/**
 * Ad Library — the interactive client. Reads arrive as props from the server
 * page; every write goes through actions.ts.
 */

import { useMemo, useState } from 'react'
import Header from '@/components/layout/header'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import AppSelect from '@/components/ui/app-select'
import { EmptyState } from '@/components/ui/empty-state'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ToastContainer, useToast } from '@/components/ui/toast'
import {
  Bookmark, Search, X, Download, Play, ExternalLink, Copy, Check, Plug, FolderPlus, Pencil, Trash2, Loader2, Info,
} from 'lucide-react'
import { adLibraryLink, adsToCsv, daysRunning, type AdFolder, type SavedAd } from '@/lib/ad-library/core'
import {
  createConnectKey, deleteFolder, moveAds, removeAds, revokeConnectKey, saveFolder, updateAd, type ConnectKeyRow,
} from './actions'

type Sort = 'saved' | 'longest' | 'newest'
const INPUT = 'w-full h-9 px-3 rounded-lg bg-secondary text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary'
const AREA = 'w-full px-3 py-2 rounded-lg bg-secondary text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary'
const niceDay = (d: string | null) => (d ? new Date(d + 'T00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '')

interface Props {
  ads: SavedAd[]
  links: Record<string, string>
  folders: AdFolder[]
  clients: { id: string; name: string }[]
  people: Record<string, string>
  keys: ConnectKeyRow[]
  canEdit: boolean
  canDelete: boolean
  canConnect: boolean
  notSetUp: boolean
  today: string
}

export default function AdLibraryClient(props: Props) {
  const { links, clients, people, canEdit, canDelete, canConnect, notSetUp, today } = props
  const toast = useToast()
  const [ads, setAds] = useState(props.ads)
  const [folders, setFolders] = useState(props.folders)
  const [keys, setKeys] = useState(props.keys)

  const [q, setQ] = useState('')
  const [folder, setFolder] = useState<string>('all') // all | none | folder id
  const [client, setClient] = useState('')
  const [runningOnly, setRunningOnly] = useState(false)
  const [sort, setSort] = useState<Sort>('saved')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<SavedAd | null>(null)
  const [connectOpen, setConnectOpen] = useState(false)
  const [foldersOpen, setFoldersOpen] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const folderName = (id: string | null) => folders.find(f => f.id === id)?.name ?? ''
  const clientName = (id: string | null) => clients.find(c => c.id === id)?.name ?? ''
  const days = (a: SavedAd) => daysRunning(a.started_on, a.status === 'active' ? null : a.ended_on, today)

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = ads.filter(a => {
      if (folder === 'none' && a.folder_id) return false
      if (folder !== 'all' && folder !== 'none' && a.folder_id !== folder) return false
      if (client && a.client_id !== client) return false
      if (runningOnly && a.status !== 'active') return false
      if (needle) {
        const hay = [a.page_name, a.body, a.headline, a.link_caption, a.landing_url, a.cta, a.notes, a.tags.join(' '), a.library_id].join(' ').toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
    if (sort === 'longest') list.sort((a, b) => (days(b) ?? -1) - (days(a) ?? -1))
    if (sort === 'newest') list.sort((a, b) => (b.started_on ?? '').localeCompare(a.started_on ?? ''))
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ads, q, folder, client, runningOnly, sort, today])

  const counts = useMemo(() => {
    const m: Record<string, number> = { all: ads.length, none: 0 }
    for (const a of ads) { if (a.folder_id) m[a.folder_id] = (m[a.folder_id] ?? 0) + 1; else m.none++ }
    return m
  }, [ads])

  function togglePick(id: string) {
    setPicked(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }

  function exportCsv(list: SavedAd[]) {
    const csv = adsToCsv(list, folderName, clientName, today)
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `ad-library-${today}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  }

  async function moveSelected(folderId: string) {
    const ids = [...picked]
    const res = await moveAds(ids, folderId || null)
    if (!res.ok) { toast.error('Could not move', res.error); return }
    setAds(prev => prev.map(a => (picked.has(a.id) ? { ...a, folder_id: folderId || null } : a)))
    setPicked(new Set())
    toast.success(`Moved ${ids.length} ad${ids.length === 1 ? '' : 's'}`)
  }

  async function removeSelected() {
    const ids = [...picked]
    const res = await removeAds(ids)
    setConfirmRemove(false)
    if (!res.ok) { toast.error('Could not remove', res.error); return }
    setAds(prev => prev.filter(a => !picked.has(a.id)))
    setPicked(new Set())
    toast.success(`Removed ${ids.length} ad${ids.length === 1 ? '' : 's'}`)
  }

  return (
    <>
      <Header
        title="Ad Library"
        subtitle="Ads saved from the Facebook Ad Library"
        actions={notSetUp ? undefined : (
          <div className="flex items-center gap-2">
            {ads.length > 0 && (
              <Button size="sm" variant="outline" onClick={() => exportCsv(picked.size ? ads.filter(a => picked.has(a.id)) : shown)}>
                <Download className="w-4 h-4 mr-1.5" /> CSV
              </Button>
            )}
            {canConnect && (
              <Button size="sm" onClick={() => setConnectOpen(true)}>
                <Plug className="w-4 h-4 mr-1.5" /> Connect Chrome
              </Button>
            )}
          </div>
        )}
      />

      <div className="px-4 sm:px-6 pb-24 max-w-[1300px] mx-auto w-full">
        {notSetUp ? (
          <Card><CardContent className="p-0">
            <EmptyState icon={Bookmark} title="Ad Library is not switched on yet" body="The Ad Library tables have not been created in the database. Ask the admin to run the ad library migration." />
          </CardContent></Card>
        ) : (
          <>
            {/* Folders */}
            <div className="flex flex-wrap items-center gap-1.5 mb-3" role="tablist" aria-label="Folders">
              <Chip on={folder === 'all'} onClick={() => setFolder('all')} label="All" count={counts.all} />
              {folders.map(f => <Chip key={f.id} on={folder === f.id} onClick={() => setFolder(f.id)} label={f.name} count={counts[f.id] ?? 0} />)}
              {counts.none > 0 && counts.none !== counts.all && <Chip on={folder === 'none'} onClick={() => setFolder('none')} label="No folder" count={counts.none} />}
              {canEdit && (
                <button type="button" onClick={() => setFoldersOpen(true)} aria-label="Manage folders"
                  className="h-8 w-8 grid place-items-center rounded-full text-muted-foreground hover:bg-secondary"><FolderPlus className="w-4 h-4" /></button>
              )}
            </div>

            {/* Search and filters */}
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search page, text, link, tag" className={INPUT + ' pl-9'} />
              </div>
              {clients.length > 0 && (
                <AppSelect value={client} onChange={e => setClient(e.target.value)} wrapperClassName="w-44" aria-label="Client">
                  <option value="">All clients</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </AppSelect>
              )}
              <AppSelect value={sort} onChange={e => setSort(e.target.value as Sort)} wrapperClassName="w-44" aria-label="Sort">
                <option value="saved">Recently saved</option>
                <option value="longest">Longest running</option>
                <option value="newest">Newest ads</option>
              </AppSelect>
              <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
                <input type="checkbox" checked={runningOnly} onChange={e => setRunningOnly(e.target.checked)} className="accent-primary" />
                Running now
              </label>
            </div>

            {ads.length === 0 ? (
              <Card><CardContent className="p-0">
                <EmptyState icon={Bookmark} title="No ads saved yet"
                  body="Connect the Chrome extension, open the Facebook Ad Library and press Save on any ad. It shows up here."
                  action={canConnect ? { label: 'Connect Chrome', onClick: () => setConnectOpen(true) } : undefined} />
              </CardContent></Card>
            ) : shown.length === 0 ? (
              <Card><CardContent className="p-0">
                <EmptyState icon={Search} title="No ads match" body="Try another folder, client or search word." compact />
              </CardContent></Card>
            ) : (
              <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {shown.map(a => (
                  <AdCard key={a.id} ad={a} links={links} days={days(a)} folder={folderName(a.folder_id)} client={clientName(a.client_id)}
                    picked={picked.has(a.id)} onPick={() => togglePick(a.id)} onOpen={() => setOpen(a)} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Selection bar */}
      {picked.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 bg-card border border-border shadow-xl rounded-2xl px-3 py-2 flex flex-wrap items-center gap-2">
          <span className="text-sm px-1">{picked.size} selected</span>
          {canEdit && (
            <AppSelect value="" onChange={e => { if (e.target.value) void moveSelected(e.target.value === '_none' ? '' : e.target.value) }} wrapperClassName="w-40" aria-label="Move to folder">
              <option value="">Move to…</option>
              {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              <option value="_none">No folder</option>
            </AppSelect>
          )}
          <Button size="sm" variant="outline" onClick={() => exportCsv(ads.filter(a => picked.has(a.id)))}><Download className="w-4 h-4 mr-1" /> CSV</Button>
          {canDelete && <Button size="sm" variant="outline" onClick={() => setConfirmRemove(true)}><Trash2 className="w-4 h-4 mr-1" /> Remove</Button>}
          <button type="button" onClick={() => setPicked(new Set())} aria-label="Clear selection" className="w-8 h-8 grid place-items-center rounded hover:bg-secondary"><X className="w-4 h-4" /></button>
        </div>
      )}

      {open && (
        <AdSheet ad={open} links={links} folders={folders} clients={clients} savedBy={open.saved_by ? people[open.saved_by] : undefined}
          days={days(open)} canEdit={canEdit}
          onClose={() => setOpen(null)}
          onSaved={next => { setAds(prev => prev.map(a => (a.id === next.id ? next : a))); setOpen(null); toast.success('Saved') }}
          onError={msg => toast.error('Could not save', msg)} />
      )}

      {connectOpen && (
        <ConnectSheet keys={keys} onClose={() => setConnectOpen(false)}
          onMade={row => setKeys(prev => [row, ...prev])}
          onRevoked={id => setKeys(prev => prev.filter(k => k.id !== id))}
          onError={msg => toast.error('Something went wrong', msg)} />
      )}

      {foldersOpen && (
        <FoldersSheet folders={folders} onClose={() => setFoldersOpen(false)}
          onChange={next => setFolders(next)}
          onDeleted={id => { setAds(prev => prev.map(a => (a.folder_id === id ? { ...a, folder_id: null } : a))); if (folder === id) setFolder('all') }}
          onError={msg => toast.error('Something went wrong', msg)} />
      )}

      {confirmRemove && (
        <ConfirmDialog title={`Remove ${picked.size} ad${picked.size === 1 ? '' : 's'}?`}
          body="They leave the library. Saving the same ad again from Chrome brings it back."
          confirmLabel="Remove" danger onConfirm={() => void removeSelected()} onCancel={() => setConfirmRemove(false)} />
      )}

      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
    </>
  )
}

// ── pieces ───────────────────────────────────────────────────────────────────

function Chip({ on, onClick, label, count }: { on: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button type="button" role="tab" aria-selected={on} onClick={onClick}
      className={`h-8 px-3 rounded-full text-sm border transition-colors ${on ? 'bg-primary text-primary-foreground border-primary' : 'bg-secondary border-border text-foreground hover:bg-secondary/70'}`}>
      {label} <span className={on ? 'opacity-80' : 'text-muted-foreground'}>{count}</span>
    </button>
  )
}

function thumbOf(ad: SavedAd, links: Record<string, string>): { src: string | null; video: boolean; more: number } {
  const first = ad.media[0]
  if (!first) return { src: null, video: false, more: 0 }
  const src = first.kind === 'video' ? (first.poster ? links[first.poster] : null) : links[first.path]
  return { src: src ?? null, video: first.kind === 'video', more: ad.media.length - 1 }
}

function AdCard({ ad, links, days, folder, client, picked, onPick, onOpen }: {
  ad: SavedAd; links: Record<string, string>; days: number | null; folder: string; client: string; picked: boolean; onPick: () => void; onOpen: () => void
}) {
  const t = thumbOf(ad, links)
  const avatar = ad.page_avatar ? links[ad.page_avatar] : null
  return (
    <Card className={`overflow-hidden ${picked ? 'ring-2 ring-primary' : ''}`}>
      <div className="relative">
        <button type="button" onClick={onOpen} className="block w-full aspect-square bg-secondary" aria-label={`Open ad from ${ad.page_name ?? 'unknown page'}`}>
          {t.src
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={t.src} alt="" loading="lazy" className="w-full h-full object-cover" />
            : <span className="w-full h-full grid place-items-center text-xs text-muted-foreground">No picture</span>}
          {t.video && <span className="absolute inset-0 grid place-items-center"><span className="w-11 h-11 rounded-full bg-black/55 grid place-items-center"><Play className="w-5 h-5 text-white fill-white" /></span></span>}
          {t.more > 0 && <span className="absolute bottom-2 right-2 text-[11px] px-1.5 py-0.5 rounded bg-black/60 text-white">+{t.more}</span>}
        </button>
        <label className="absolute top-2 left-2 w-7 h-7 grid place-items-center rounded-md bg-black/45 cursor-pointer" aria-label="Select ad">
          <input type="checkbox" checked={picked} onChange={onPick} className="accent-primary w-4 h-4" />
        </label>
        {days != null && (
          <span className={`absolute top-2 right-2 text-[11px] font-medium px-2 py-0.5 rounded-full ${ad.status === 'active' ? 'bg-green-500 text-white' : 'bg-black/60 text-white'}`}>
            {days} day{days === 1 ? '' : 's'}{ad.status === 'active' ? '' : ' · ended'}
          </span>
        )}
      </div>
      <CardContent className="p-3 space-y-1.5">
        <div className="flex items-center gap-2 min-w-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {avatar && <img src={avatar} alt="" className="w-5 h-5 rounded-full" />}
          <span className="text-sm font-medium truncate">{ad.page_name || 'Unknown page'}</span>
        </div>
        {ad.body && <p className="text-xs text-muted-foreground line-clamp-3 whitespace-pre-line">{ad.body}</p>}
        <div className="flex flex-wrap gap-1 pt-0.5">
          {folder && <span className="text-[11px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400">{folder}</span>}
          {client && <span className="text-[11px] px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-400">{client}</span>}
          {ad.tags.slice(0, 3).map(t => <span key={t} className="text-[11px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">#{t}</span>)}
        </div>
      </CardContent>
    </Card>
  )
}

function Sheet({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className={`bg-card w-full ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'} sm:rounded-2xl rounded-t-2xl max-h-[92vh] overflow-y-auto`}>
        <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-card z-10">
          <h2 className="text-base font-semibold truncate">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4 space-y-3">{children}</div>
        {footer && <div className="flex items-center justify-between gap-2 p-4 border-t border-border sticky bottom-0 bg-card">{footer}</div>}
      </div>
    </ModalOverlay>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  )
}

function AdSheet({ ad, links, folders, clients, savedBy, days, canEdit, onClose, onSaved, onError }: {
  ad: SavedAd; links: Record<string, string>; folders: AdFolder[]; clients: { id: string; name: string }[]; savedBy?: string
  days: number | null; canEdit: boolean; onClose: () => void; onSaved: (a: SavedAd) => void; onError: (m?: string) => void
}) {
  const [folderId, setFolderId] = useState(ad.folder_id ?? '')
  const [clientId, setClientId] = useState(ad.client_id ?? '')
  const [tags, setTags] = useState(ad.tags.join(', '))
  const [notes, setNotes] = useState(ad.notes ?? '')
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    const res = await updateAd(ad.id, { folder_id: folderId || null, client_id: clientId || null, tags, notes })
    setBusy(false)
    if (!res.ok) { onError(res.error); return }
    onSaved({ ...ad, folder_id: folderId || null, client_id: clientId || null, notes: notes.trim() || null,
      tags: tags.split(',').map(t => t.trim().toLowerCase().replace(/^#/, '')).filter(Boolean) })
  }

  return (
    <Sheet title={ad.page_name || 'Saved ad'} onClose={onClose} wide
      footer={canEdit ? (
        <>
          <a href={adLibraryLink(ad.library_id)} target="_blank" rel="noreferrer" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
            Ad Library <ExternalLink className="w-3.5 h-3.5" />
          </a>
          <Button size="sm" onClick={() => void save()} disabled={busy}>{busy && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}Save</Button>
        </>
      ) : undefined}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          {ad.media.length === 0 && <div className="aspect-square rounded-lg bg-secondary grid place-items-center text-xs text-muted-foreground">No picture was copied</div>}
          {ad.media.map((m, i) => (
            m.kind === 'video'
              ? <video key={i} src={links[m.path]} poster={m.poster ? links[m.poster] : undefined} controls playsInline className="w-full rounded-lg bg-black" />
              // eslint-disable-next-line @next/next/no-img-element
              : <img key={i} src={links[m.path]} alt="" className="w-full rounded-lg" />
          ))}
        </div>
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{ad.status === 'active' ? 'Running' : ad.status === 'inactive' ? 'Ended' : 'Status unknown'}{days != null ? ` · ${days} day${days === 1 ? '' : 's'}` : ''}</span>
            {ad.started_on && <span>From {niceDay(ad.started_on)}{ad.ended_on ? ` to ${niceDay(ad.ended_on)}` : ''}</span>}
            {ad.multiple_versions && <span>Has more versions</span>}
          </div>
          {ad.body && <p className="whitespace-pre-line">{ad.body}</p>}
          {(ad.headline || ad.landing_url) && (
            <div className="rounded-lg bg-secondary p-3 space-y-1">
              {ad.link_caption && <div className="text-[11px] uppercase text-muted-foreground">{ad.link_caption}</div>}
              {ad.headline && <div className="font-medium">{ad.headline}</div>}
              <div className="flex items-center justify-between gap-2">
                {ad.landing_url && <a href={ad.landing_url} target="_blank" rel="noreferrer" className="text-xs text-primary truncate inline-flex items-center gap-1">Landing page <ExternalLink className="w-3 h-3" /></a>}
                {ad.cta && <span className="text-xs px-2 py-1 rounded border border-border">{ad.cta}</span>}
              </div>
            </div>
          )}
          {canEdit ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Folder">
                  <AppSelect value={folderId} onChange={e => setFolderId(e.target.value)}>
                    <option value="">No folder</option>
                    {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </AppSelect>
                </Field>
                <Field label="Client">
                  <AppSelect value={clientId} onChange={e => setClientId(e.target.value)}>
                    <option value="">None</option>
                    {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </AppSelect>
                </Field>
              </div>
              <Field label="Tags"><input value={tags} onChange={e => setTags(e.target.value)} placeholder="offer, video, diwali" className={INPUT} /></Field>
              <Field label="Notes"><textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="What is good about this ad?" className={AREA} /></Field>
            </>
          ) : ad.notes ? <p className="text-muted-foreground whitespace-pre-line">{ad.notes}</p> : null}
          {savedBy && <div className="text-[11px] text-muted-foreground">Saved by {savedBy} on {niceDay(ad.created_at.slice(0, 10))}</div>}
        </div>
      </div>
    </Sheet>
  )
}

function ConnectSheet({ keys, onClose, onMade, onRevoked, onError }: {
  keys: ConnectKeyRow[]; onClose: () => void; onMade: (r: ConnectKeyRow) => void; onRevoked: (id: string) => void; onError: (m?: string) => void
}) {
  const [fresh, setFresh] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  async function make() {
    setBusy(true)
    const res = await createConnectKey('Chrome')
    setBusy(false)
    if (!res.ok || !res.data) { onError(res.error); return }
    setFresh(res.data.key)
    onMade(res.data.row)
  }

  async function copy() {
    if (!fresh) return
    await navigator.clipboard.writeText(fresh).catch(() => undefined)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Sheet title="Connect Chrome" onClose={onClose}>
      <ol className="text-sm space-y-1.5 list-decimal pl-5">
        <li>Install the <b>Cirqle Ad Saver</b> extension in Chrome.</li>
        <li>Make a key below and copy it.</li>
        <li>Open the extension&apos;s settings, paste the key and press <b>Connect</b>.</li>
      </ol>
      {fresh ? (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <div className="text-xs text-muted-foreground flex items-center gap-1"><Info className="w-3.5 h-3.5" /> Shown only once. Copy it now.</div>
          <div className="flex gap-2">
            <code className="flex-1 min-w-0 truncate text-xs bg-secondary rounded px-2 py-2">{fresh}</code>
            <Button size="sm" onClick={() => void copy()}>{copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}</Button>
          </div>
        </div>
      ) : (
        <Button onClick={() => void make()} disabled={busy}>{busy && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}Make a key</Button>
      )}
      {keys.length > 0 && (
        <div className="pt-2">
          <div className="text-xs text-muted-foreground mb-1">Your keys</div>
          <div className="divide-y divide-border/60 rounded-lg border border-border">
            {keys.map(k => (
              <div key={k.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="flex-1 min-w-0 truncate">{k.label || 'Chrome'} ····{k.key_hint}</span>
                <span className="text-xs text-muted-foreground">{k.last_used_at ? `used ${niceDay(k.last_used_at.slice(0, 10))}` : 'not used yet'}</span>
                <button type="button" aria-label="Switch key off" className="w-7 h-7 grid place-items-center rounded hover:bg-secondary text-muted-foreground"
                  onClick={async () => { const r = await revokeConnectKey(k.id); if (r.ok) onRevoked(k.id); else onError(r.error) }}>
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </Sheet>
  )
}

function FoldersSheet({ folders, onClose, onChange, onDeleted, onError }: {
  folders: AdFolder[]; onClose: () => void; onChange: (f: AdFolder[]) => void; onDeleted: (id: string) => void; onError: (m?: string) => void
}) {
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  async function add() {
    const res = await saveFolder(null, name)
    if (!res.ok || !res.data) { onError(res.error); return }
    onChange([...folders, res.data]); setName('')
  }
  async function rename(id: string) {
    const res = await saveFolder(id, editName)
    if (!res.ok || !res.data) { onError(res.error); return }
    onChange(folders.map(f => (f.id === id ? res.data! : f))); setEditing(null)
  }
  async function remove(id: string) {
    const res = await deleteFolder(id)
    if (!res.ok) { onError(res.error); return }
    onChange(folders.filter(f => f.id !== id)); onDeleted(id)
  }

  return (
    <Sheet title="Folders" onClose={onClose}>
      <div className="flex gap-2">
        <input value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && name.trim()) void add() }} placeholder="New folder" className={INPUT} />
        <Button size="sm" onClick={() => void add()} disabled={!name.trim()}>Add</Button>
      </div>
      <div className="divide-y divide-border/60 rounded-lg border border-border">
        {folders.map(f => (
          <div key={f.id} className="flex items-center gap-2 px-3 py-2 text-sm">
            {editing === f.id ? (
              <>
                <input autoFocus value={editName} onChange={e => setEditName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void rename(f.id) }} className={INPUT} />
                <Button size="sm" onClick={() => void rename(f.id)}>Save</Button>
              </>
            ) : (
              <>
                <span className="flex-1 min-w-0 truncate">{f.name}</span>
                <button type="button" aria-label={`Rename ${f.name}`} onClick={() => { setEditing(f.id); setEditName(f.name) }} className="w-7 h-7 grid place-items-center rounded hover:bg-secondary text-muted-foreground"><Pencil className="w-4 h-4" /></button>
                <button type="button" aria-label={`Delete ${f.name}`} onClick={() => void remove(f.id)} className="w-7 h-7 grid place-items-center rounded hover:bg-secondary text-muted-foreground"><Trash2 className="w-4 h-4" /></button>
              </>
            )}
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Deleting a folder keeps its ads; they move to No folder.</p>
    </Sheet>
  )
}

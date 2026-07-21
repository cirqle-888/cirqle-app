'use client'

/**
 * Product Library — the shop owner's side of the catalog.
 *
 * DARK THEME ONLY: this lives under src/app/intake/, which renders on
 * #0f0f1a with no app chrome. bg-white/5 + text-white/60 are correct here and
 * are NOT the dashboard's tokens — do not copy this styling into (dashboard).
 */

import { useState, useRef } from 'react'
import Link from 'next/link'
import { ArrowLeft, Camera, Check, Clock, Loader2, Plus, X } from 'lucide-react'
import { IntakeAppSwitcher } from '@/components/intake/app-switcher'
import { submitLibraryProduct, getLibraryImageUploadUrl, type LibraryItem } from './actions'

/** Mirrors the server-side list in actions.ts, which is the authority. */
const CATEGORIES = ['Vegetables', 'Fruits'] as const

const STATUS_CHIP: Record<string, { label: string; className: string }> = {
  pending:  { label: 'Waiting for review', className: 'bg-amber-500/15 text-amber-300 border-amber-500/25' },
  approved: { label: 'Added to library',   className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25' },
  rejected: { label: 'Not accepted',       className: 'bg-white/5 text-white/40 border-white/10' },
}

const INPUT_CLASS =
  'w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-white/25 focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition-colors'

function formatDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export default function LibraryClient({
  token, client, initialItems, logoUrl, switcher, hub,
}: {
  token: string
  client: { id: string; name: string }
  initialItems: LibraryItem[]
  logoUrl?: string | null
  switcher?: { kind: string; label: string; href: string }[]
  hub?: string
}) {
  const [items, setItems] = useState<LibraryItem[]>(initialItems)
  const [name, setName] = useState('')
  const [localName, setLocalName] = useState('')
  const [category, setCategory] = useState<string>(CATEGORIES[0])
  const [imageUrl, setImageUrl] = useState('')
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [justAdded, setJustAdded] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleFile(file: File) {
    setError('')
    setUploading(true)
    try {
      const res = await getLibraryImageUploadUrl(token, file.name, file.type)
      if (!res.ok || !res.data) {
        setError(res.error || 'Could not prepare the photo upload. Please try again.')
        return
      }
      const uploadRes = await fetch(res.data.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      })
      if (!uploadRes.ok) {
        setError('The photo did not upload. Please check your connection and try again.')
        return
      }
      setImageUrl(res.data.publicUrl)
    } finally {
      setUploading(false)
      // Let the same file be picked again after a failure.
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function handleSubmit() {
    if (saving) return
    setError('')
    setJustAdded('')
    if (!name.trim()) {
      setError('Please type the name of the product.')
      return
    }
    setSaving(true)
    try {
      const res = await submitLibraryProduct(token, {
        name: name.trim(),
        localName: localName.trim() || undefined,
        category,
        imageUrl: imageUrl || undefined,
      })
      if (!res.ok || !res.data) {
        setError(res.error || 'Could not save that product. Please try again.')
        return
      }
      // Show it immediately rather than waiting for a reload — the client just
      // typed it, so nothing here needs to come back from the server.
      setItems(prev => [{
        id: res.data!.id,
        name: name.trim(),
        local_name: localName.trim() || null,
        category,
        review_status: 'pending',
        image_url: imageUrl || null,
        created_at: new Date().toISOString(),
      }, ...prev])
      setJustAdded(name.trim())
      setName('')
      setLocalName('')
      setImageUrl('')
    } finally {
      setSaving(false)
    }
  }

  const pendingCount = items.filter(i => (i.review_status || 'pending') === 'pending').length

  return (
    <div className="min-h-dvh bg-[#0f0f1a] text-white">
      <div className="max-w-2xl mx-auto px-4 pt-8 sm:pt-12">
        {hub && (
          <Link href={`/start/${hub}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-white/50 hover:text-white transition-colors mb-6 group">
            <ArrowLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" /> Back to Hub
          </Link>
        )}
        <div className="text-center mb-8">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="Cirqle" className="h-10 w-auto max-w-[200px] mx-auto object-contain mb-4" />
          ) : (
            <div className="mb-4">
              <div className="text-2xl font-extrabold tracking-tight">cirqle<span className="text-violet-400">.</span></div>
            </div>
          )}
          <h1 className="text-xl font-bold text-white/90">Product Library</h1>
          <p className="text-sm text-white/40 mt-1">
            {client.name} · Tell us what you sell, and we&apos;ll add it to your library
          </p>
        </div>
        {switcher && <IntakeAppSwitcher options={switcher} current="product_library" dark />}
      </div>

      <div className="max-w-2xl mx-auto px-4 pb-12">
        {/* ── Add form ───────────────────────────────────────────────────── */}
        <div className="bg-white/5 border border-white/10 rounded-2xl p-5 mb-6">
          <h2 className="text-sm font-bold text-white/80 mb-1">Add a vegetable or fruit</h2>
          <p className="text-xs text-white/40 mb-4">
            One item at a time. A clear photo helps us design your offers faster.
          </p>

          <div className="space-y-4">
            <div>
              <label htmlFor="lib-name" className="block text-xs font-semibold text-white/60 mb-1.5">
                Product name
              </label>
              <input
                id="lib-name"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Tomato"
                className={INPUT_CLASS}
              />
            </div>

            <div>
              <label htmlFor="lib-local" className="block text-xs font-semibold text-white/60 mb-1.5">
                Malayalam / local name <span className="font-normal text-white/30">(optional)</span>
              </label>
              <input
                id="lib-local"
                value={localName}
                onChange={e => setLocalName(e.target.value)}
                placeholder="e.g. തക്കാളി"
                className={INPUT_CLASS}
              />
              <p className="text-[11px] text-white/30 mt-1.5">
                This is the name your customers will recognise on the flyer.
              </p>
            </div>

            <div>
              <span className="block text-xs font-semibold text-white/60 mb-1.5">Type</span>
              <div className="flex gap-2">
                {CATEGORIES.map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategory(c)}
                    className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold border transition-colors ${
                      category === c
                        ? 'bg-violet-600 border-violet-500 text-white shadow-lg shadow-violet-900/30'
                        : 'bg-white/5 border-white/10 text-white/50 hover:text-white/80 hover:border-white/20'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="block text-xs font-semibold text-white/60 mb-1.5">
                Photo <span className="font-normal text-white/30">(optional)</span>
              </span>
              {imageUrl ? (
                <div className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-xl p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imageUrl} alt="" className="w-16 h-16 rounded-lg object-cover bg-black/30" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-white/80">Photo ready</div>
                    <div className="text-xs text-white/40">It will be sent with this product.</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setImageUrl('')}
                    className="p-2 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
                    aria-label="Remove photo"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="w-full flex items-center justify-center gap-2 py-6 rounded-xl border border-dashed border-white/15 bg-white/[0.03] text-sm font-medium text-white/50 hover:text-white/80 hover:border-white/30 disabled:opacity-50 transition-colors"
                >
                  {uploading
                    ? <><Loader2 className="w-4 h-4 animate-spin" /> Uploading photo…</>
                    : <><Camera className="w-4 h-4" /> Take or choose a photo</>}
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={e => {
                  const f = e.target.files?.[0]
                  if (f) void handleFile(f)
                }}
              />
            </div>
          </div>

          {error && (
            <div className="mt-4 text-sm text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-xl px-3 py-2.5">
              {error}
            </div>
          )}
          {justAdded && !error && (
            <div className="mt-4 flex items-start gap-2 text-sm text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-3 py-2.5">
              <Check className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                Thank you — <span className="font-semibold">{justAdded}</span> has been sent to us.
                We&apos;ll check it and add it to your library shortly. Add another one below.
              </span>
            </div>
          )}

          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={saving || uploading || !name.trim()}
            className="w-full mt-5 py-3.5 text-sm font-bold rounded-2xl bg-violet-600 hover:bg-violet-500 text-white shadow-lg shadow-violet-900/40 disabled:opacity-40 transition-all flex items-center justify-center gap-2"
          >
            {saving
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</>
              : <><Plus className="w-4 h-4" /> Send this product</>}
          </button>
        </div>

        {/* ── What they've already sent ───────────────────────────────────── */}
        <div className="flex items-baseline justify-between mb-3 px-1">
          <h2 className="text-sm font-bold text-white/80">What you&apos;ve sent us</h2>
          {pendingCount > 0 && (
            <span className="text-xs text-white/40">{pendingCount} waiting for review</span>
          )}
        </div>

        {items.length === 0 ? (
          <div className="text-center bg-white/[0.03] border border-dashed border-white/10 rounded-2xl px-6 py-10">
            <div className="text-3xl mb-3">🧺</div>
            <div className="text-sm font-semibold text-white/70 mb-1">Your library is empty for now</div>
            <p className="text-xs text-white/40 max-w-xs mx-auto">
              Start with the things you sell every day — tomatoes, onions, bananas.
              Everything you add here shows up ready to use in your offers.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {items.map(item => {
              const chip = STATUS_CHIP[item.review_status] || STATUS_CHIP.pending
              return (
                <li
                  key={item.id}
                  className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-xl p-3"
                >
                  {item.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.image_url} alt="" className="w-12 h-12 rounded-lg object-cover bg-black/30 shrink-0" />
                  ) : (
                    <div className="w-12 h-12 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center shrink-0">
                      <Camera className="w-4 h-4 text-white/20" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-white/85 truncate">{item.name}</div>
                    <div className="text-xs text-white/40 truncate">
                      {[item.local_name, item.category].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${chip.className}`}>
                      {item.review_status === 'pending' && <Clock className="w-3 h-3" />}
                      {item.review_status === 'approved' && <Check className="w-3 h-3" />}
                      {chip.label}
                    </span>
                    {item.created_at && (
                      <span className="text-[11px] text-white/25">{formatDate(item.created_at)}</span>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        <p className="text-center text-xs text-white/25 mt-8">
          Anything you send is checked by the Cirqle team before it goes live.
        </p>
      </div>
    </div>
  )
}

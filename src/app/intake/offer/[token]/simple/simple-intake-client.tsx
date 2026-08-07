'use client'

/**
 * SIMPLE client intake — the public face of /intake/offer/[token].
 *
 * Mobile-first, one clear primary action (Submit offer), everything advanced
 * folded away. The heavy 3,000-line editor still exists and still serves the
 * staff entrance (/dashboard/offer-prepare); this component replaces it only
 * for CLIENTS, who send a list from a phone and should never see bulk ops,
 * table views or keyboard shortcuts.
 *
 * DARK THEME ONLY: lives under src/app/intake/ (renders on #0f0f1a, no app
 * chrome) — bg-white/5 etc. are correct here and are NOT dashboard tokens.
 *
 * All server work goes through the same token-gated actions the heavy editor
 * uses, so either entrance can pick up where the other left off.
 */

import { useMemo, useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Calendar, CheckCircle2, ChevronDown, ChevronUp, History, Loader2, Lock, Plus,
} from 'lucide-react'
import { IntakeAppSwitcher } from '@/components/intake/app-switcher'
import type { OfferGroupOption } from '../actions'
import type { Badge, CampaignRow, CatalogItem } from './types'
import { INPUT_CLASS, LABEL_CLASS, fmtOfferDate } from './types'
import { useSimpleCampaign } from './use-simple-campaign'
import { SimpleProductRow } from './product-row'
import { AddProductSheet } from './add-product-sheet'

export default function SimpleIntakeClient({
  token, client, campaign, catalog, badges, groups = [], sheetManaged = false,
  designLocked = false, logoUrl, switcher, hub,
}: {
  token: string
  client: { id: string; name: string }
  campaign: CampaignRow | null
  catalog: CatalogItem[]
  badges: Badge[]
  groups?: OfferGroupOption[]
  sheetManaged?: boolean
  /** Designer pressed "Mark as Designed" — edits are locked until unlock. */
  designLocked?: boolean
  logoUrl?: string | null
  switcher?: { kind: string; label: string; href: string }[]
  hub?: string
}) {
  const c = useSimpleCampaign(token, campaign)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [cloneError, setCloneError] = useState('')

  const existingNames = useMemo(
    () => new Set(c.products.map(p => p.name.trim().toLowerCase()).filter(Boolean)),
    [c.products],
  )

  const readOnly = sheetManaged || designLocked
  const canSubmit = !readOnly && c.products.length > 0 && !c.saving

  return (
    <div className="min-h-dvh bg-[#0f0f1a] text-white">
      {/* Full-screen saving state — one deliberate submit, no double-taps */}
      {c.saving && (
        <div className="fixed inset-0 z-[60] bg-[#0f0f1a]/90 backdrop-blur-sm flex items-center justify-center">
          <div className="text-center">
            <Loader2 className="w-8 h-8 animate-spin text-violet-400 mx-auto mb-3" />
            <div className="text-sm font-semibold text-white/80">Sending your offer…</div>
            <div className="text-xs text-white/40 mt-1">Please keep this page open.</div>
          </div>
        </div>
      )}

      <div className="max-w-lg lg:max-w-2xl mx-auto px-4 pt-8 pb-36">
        {/* ── Header ── */}
        {hub && (
          <Link href={`/start/${hub}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-white/50 hover:text-white transition-colors mb-6 group">
            <ArrowLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" /> Back to Hub
          </Link>
        )}
        <div className="text-center mb-6">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="Cirqle" className="h-9 w-auto max-w-[180px] mx-auto object-contain mb-3" />
          ) : (
            <div className="text-2xl font-extrabold tracking-tight mb-3">cirqle<span className="text-violet-400">.</span></div>
          )}
          <h1 className="text-xl font-bold text-white/90">Weekly Offer</h1>
          <p className="text-sm text-white/40 mt-1">{client.name}</p>
        </div>
        {switcher && <IntakeAppSwitcher options={switcher} current="offer_intake" dark />}

        {/* ── Offer details (title + date) — collapsed to a single line ── */}
        <div className="bg-white/5 border border-white/10 rounded-2xl mb-4">
          <button
            type="button"
            onClick={() => setDetailsOpen(v => !v)}
            className="w-full flex items-center gap-2.5 px-4 py-3 text-left"
          >
            <Calendar className="w-4 h-4 text-white/30 shrink-0" />
            <span className="flex-1 min-w-0 text-sm text-white/70 truncate">
              {c.title.trim() ? c.title : 'Offer'}
              <span className="text-white/35"> · {fmtOfferDate(c.offerDate) || 'set the date'}</span>
              {c.dateType === 'range' && c.offerDateTo ? <span className="text-white/35"> – {fmtOfferDate(c.offerDateTo)}</span> : null}
            </span>
            {detailsOpen ? <ChevronUp className="w-4 h-4 text-white/30" /> : <ChevronDown className="w-4 h-4 text-white/30" />}
          </button>
          {detailsOpen && (
            <div className="px-4 pb-4 space-y-3">
              <div>
                <label className={LABEL_CLASS} htmlFor="offer-title">Offer name <span className="font-normal text-white/30">(optional)</span></label>
                <input
                  id="offer-title"
                  value={c.title}
                  disabled={readOnly}
                  onChange={e => c.setTitle(e.target.value)}
                  placeholder="e.g. Weekend Special"
                  className={INPUT_CLASS}
                />
              </div>
              <div className={c.dateType === 'range' ? 'grid grid-cols-2 gap-3' : ''}>
                <div>
                  <label className={LABEL_CLASS} htmlFor="offer-date">{c.dateType === 'range' ? 'From' : 'Offer date'}</label>
                  <input
                    id="offer-date"
                    type="date"
                    value={c.offerDate}
                    disabled={readOnly}
                    onChange={e => c.setOfferDate(e.target.value)}
                    className={INPUT_CLASS}
                  />
                </div>
                {c.dateType === 'range' && (
                  <div>
                    <label className={LABEL_CLASS} htmlFor="offer-date-to">To</label>
                    <input
                      id="offer-date-to"
                      type="date"
                      value={c.offerDateTo}
                      disabled={readOnly}
                      onChange={e => c.setOfferDateTo(e.target.value)}
                      className={INPUT_CLASS}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Read-only notices ── */}
        {designLocked && (
          <div className="flex items-start gap-2.5 bg-violet-500/10 border border-violet-500/25 rounded-2xl px-4 py-3 mb-4 text-sm text-violet-200/90">
            <Lock className="w-4 h-4 mt-0.5 shrink-0" />
            <span>Your offer is being designed — contact us if something must change.</span>
          </div>
        )}
        {sheetManaged && !designLocked && (
          <div className="flex items-start gap-2.5 bg-amber-500/10 border border-amber-500/20 rounded-2xl px-4 py-3 mb-4 text-sm text-amber-200/90">
            <Lock className="w-4 h-4 mt-0.5 shrink-0" />
            <span>This offer is managed from your Google Sheet, so it can&apos;t be edited here. Update the sheet instead.</span>
          </div>
        )}

        {/* ── Product list / empty state ── */}
        {c.products.length === 0 ? (
          <div className="text-center bg-white/[0.03] border border-dashed border-white/10 rounded-2xl px-6 py-12">
            <div className="text-3xl mb-3">🛒</div>
            <div className="text-sm font-semibold text-white/70 mb-1">No products yet</div>
            <p className="text-xs text-white/40 max-w-xs mx-auto mb-6">
              Add this week&apos;s products and prices — we&apos;ll design the flyer from your list.
            </p>
            {!readOnly && (
              <div className="flex flex-col sm:flex-row gap-2 justify-center">
                <button
                  type="button"
                  onClick={async () => { setCloneError(''); const err = await c.startFromLastWeek(); if (err) setCloneError(err) }}
                  disabled={c.cloning}
                  className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-2xl text-sm font-bold bg-white/5 border border-white/15 text-white/80 hover:bg-white/10 disabled:opacity-50 transition-colors"
                >
                  {c.cloning ? <Loader2 className="w-4 h-4 animate-spin" /> : <History className="w-4 h-4" />}
                  Start from last week
                </button>
                <button
                  type="button"
                  onClick={() => setSheetOpen(true)}
                  className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-2xl text-sm font-bold bg-violet-600 hover:bg-violet-500 text-white shadow-lg shadow-violet-900/40 transition-colors"
                >
                  <Plus className="w-4 h-4" /> Add products
                </button>
              </div>
            )}
            {cloneError && <p className="text-xs text-amber-300/90 mt-3">{cloneError}</p>}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-baseline justify-between px-1">
              <h2 className="text-sm font-bold text-white/80">Your products</h2>
              <span className="text-xs text-white/35">{c.products.length} item{c.products.length === 1 ? '' : 's'}</span>
            </div>
            {c.products.map(p => (
              <SimpleProductRow
                key={p._key}
                token={token}
                product={p}
                badges={badges}
                groups={groups}
                readOnly={readOnly}
                onUpdate={c.updateProduct}
                onRemove={c.removeProduct}
              />
            ))}
          </div>
        )}

        {/* ── Note to the team (folded) ── */}
        {!readOnly && c.products.length > 0 && (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setNoteOpen(v => !v)}
              className="flex items-center gap-1 text-xs font-semibold text-white/40 hover:text-white/70 transition-colors"
            >
              {noteOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              Add a note for the design team
            </button>
            {noteOpen && (
              <textarea
                value={c.note}
                onChange={e => c.setNote(e.target.value)}
                rows={2}
                placeholder="Anything we should know about this week's offer…"
                className={INPUT_CLASS + ' mt-2 resize-none'}
              />
            )}
          </div>
        )}

        {c.saveError && (
          <div className="mt-4 text-sm text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-xl px-3 py-2.5">
            {c.saveError}
          </div>
        )}
      </div>

      {/* ── Sticky action bar — ONE primary action ── */}
      {!readOnly && (
        <div className="fixed bottom-0 inset-x-0 z-40 bg-[#0f0f1a]/95 backdrop-blur border-t border-white/10">
          <div className="max-w-lg lg:max-w-2xl mx-auto px-4 py-3 flex items-center gap-2">
            {c.products.length > 0 && (
              <button
                type="button"
                onClick={() => setSheetOpen(true)}
                className="inline-flex items-center gap-1.5 px-4 py-3 rounded-2xl text-sm font-bold bg-white/5 border border-white/15 text-white/80 hover:bg-white/10 transition-colors shrink-0"
              >
                <Plus className="w-4 h-4" /> Add
              </button>
            )}
            <button
              type="button"
              onClick={() => void c.save()}
              disabled={!canSubmit || (!c.dirty && c.justSaved)}
              className={`flex-1 py-3 rounded-2xl text-sm font-bold flex items-center justify-center gap-2 transition-all ${
                c.justSaved && !c.dirty
                  ? 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/30'
                  : 'bg-violet-600 hover:bg-violet-500 text-white shadow-lg shadow-violet-900/40 disabled:opacity-40'
              }`}
            >
              {c.justSaved && !c.dirty
                ? <><CheckCircle2 className="w-4 h-4" /> Offer sent — we&apos;re on it</>
                : c.hasExistingCampaign || c.justSaved ? 'Update offer' : 'Submit offer'}
            </button>
          </div>
        </div>
      )}

      {sheetOpen && (
        <AddProductSheet
          token={token}
          catalog={catalog}
          existingNames={existingNames}
          onAdd={items => c.addProducts(items)}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </div>
  )
}

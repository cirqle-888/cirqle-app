'use client'

/**
 * One product in the simple intake list.
 *
 * Collapsed: thumb, name, weight, price, badge chips — tap anywhere to edit.
 * Expanded: name + price only by default; weight / MRP / offer type / offer
 * text / badges live behind a collapsed "More options" disclosure. Delete is
 * the only confirm (two-tap).
 */

import { useState } from 'react'
import { ChevronDown, ChevronUp, ImageIcon, Trash2 } from 'lucide-react'
import type { Badge, LocalProduct } from './types'
import { BADGE_CHIP_COLOR, INPUT_CLASS, LABEL_CLASS } from './types'
import type { OfferGroupOption } from '../actions'
import { ProductPhotoButton } from './photo-uploader'

const OFFER_TYPES: { value: LocalProduct['offer_type']; label: string }[] = [
  { value: 'price', label: 'Price' },
  { value: 'percent', label: '% off' },
  { value: 'bogo', label: 'Buy 1 Get 1' },
  { value: 'other', label: 'Other' },
]

function parseMoney(raw: string): number | null {
  const n = parseFloat(raw.replace(/[^\d.]/g, ''))
  return Number.isFinite(n) ? n : null
}

export function SimpleProductRow({
  token, product, badges, groups, readOnly, onUpdate, onRemove,
}: {
  token: string
  product: LocalProduct
  badges: Badge[]
  groups: OfferGroupOption[]
  readOnly?: boolean
  onUpdate: (key: string, patch: Partial<LocalProduct>) => void
  onRemove: (key: string) => void
}) {
  const [expanded, setExpanded] = useState(!product.name.trim())
  const [more, setMore] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const badgeLabel = (b: { badge_id?: string | null; custom_label?: string | null }) =>
    (b.badge_id ? badges.find(x => x.id === b.badge_id)?.label : b.custom_label) || ''

  const priceText =
    product.offer_type === 'price'
      ? (product.price != null ? `₹${product.price}` : '')
      : product.offer_type === 'bogo' ? 'Buy 1 Get 1' : (product.offer_text || '')

  const toggleBadge = (badge: Badge) => {
    const list = product.badges || []
    const has = list.some(b => b.badge_id === badge.id)
    onUpdate(product._key, {
      badges: has
        ? list.filter(b => b.badge_id !== badge.id)
        : [...list, { badge_id: badge.id, custom_label: null, color: badge.color || 'amber' }],
    })
  }

  return (
    <div className={`bg-white/5 border rounded-2xl transition-colors ${expanded ? 'border-violet-500/30' : 'border-white/10'}`}>
      {/* Collapsed header — always visible, tap to expand/collapse */}
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-3 p-3 text-left"
      >
        {product.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={product.image_url} alt="" className="w-12 h-12 rounded-lg object-cover bg-black/30 shrink-0" />
        ) : (
          <div className="w-12 h-12 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center shrink-0">
            <ImageIcon className="w-4 h-4 text-white/20" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white/90 truncate">
            {product.name.trim() || <span className="text-white/30 font-normal">New product…</span>}
          </div>
          <div className="text-xs text-white/40 truncate flex items-center gap-1.5">
            {product.weight ? <span>{product.weight}</span> : null}
            {priceText && <span className="text-emerald-300 font-semibold">{priceText}</span>}
            {product._pendingPhoto && <span className="text-amber-300">photo pending</span>}
            {(product.badges || []).slice(0, 2).map((b, i) => {
              const label = badgeLabel(b)
              return label ? (
                <span key={i} className={`px-1.5 py-px rounded-full border text-[10px] font-semibold ${BADGE_CHIP_COLOR[b.color] || BADGE_CHIP_COLOR.amber}`}>
                  {label}
                </span>
              ) : null
            })}
          </div>
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-white/30 shrink-0" /> : <ChevronDown className="w-4 h-4 text-white/30 shrink-0" />}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {/* Required by default: name + price */}
          <div>
            <label className={LABEL_CLASS} htmlFor={`name-${product._key}`}>Product name</label>
            <input
              id={`name-${product._key}`}
              value={product.name}
              disabled={readOnly}
              onChange={e => onUpdate(product._key, { name: e.target.value })}
              placeholder="e.g. Tomato"
              className={INPUT_CLASS}
            />
          </div>

          {product.offer_type === 'price' && (
            <div>
              <label className={LABEL_CLASS} htmlFor={`price-${product._key}`}>Offer price (₹)</label>
              <input
                id={`price-${product._key}`}
                inputMode="decimal"
                disabled={readOnly}
                value={product.price ?? ''}
                onChange={e => onUpdate(product._key, { price: parseMoney(e.target.value) })}
                placeholder="e.g. 49"
                className={INPUT_CLASS}
              />
            </div>
          )}

          <div className="flex items-center gap-2">
            <ProductPhotoButton
              token={token}
              compact
              imageUrl={product.image_url}
              onUploaded={url => onUpdate(product._key, { image_url: url, _pendingPhoto: false })}
              onPendingChange={pending => onUpdate(product._key, { _pendingPhoto: pending })}
            />
            {product.image_url && (
              <button
                type="button"
                onClick={() => onUpdate(product._key, { image_url: '' })}
                className="text-xs text-white/30 hover:text-white/60 transition-colors"
              >
                Remove photo
              </button>
            )}
          </div>

          {/* Everything rarely used stays folded */}
          <button
            type="button"
            onClick={() => setMore(v => !v)}
            className="flex items-center gap-1 text-xs font-semibold text-white/40 hover:text-white/70 transition-colors"
          >
            {more ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            More options
          </button>

          {more && (
            <div className="space-y-3 border-t border-white/5 pt-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={LABEL_CLASS} htmlFor={`weight-${product._key}`}>Weight / pack</label>
                  <input
                    id={`weight-${product._key}`}
                    value={product.weight || ''}
                    disabled={readOnly}
                    onChange={e => onUpdate(product._key, { weight: e.target.value })}
                    placeholder="e.g. 500g"
                    className={INPUT_CLASS}
                  />
                </div>
                <div>
                  <label className={LABEL_CLASS} htmlFor={`mrp-${product._key}`}>MRP (₹)</label>
                  <input
                    id={`mrp-${product._key}`}
                    inputMode="decimal"
                    disabled={readOnly}
                    value={product.mrp ?? ''}
                    onChange={e => onUpdate(product._key, { mrp: parseMoney(e.target.value) })}
                    placeholder="optional"
                    className={INPUT_CLASS}
                  />
                </div>
              </div>

              <div>
                <span className={LABEL_CLASS}>Offer type</span>
                <div className="flex flex-wrap gap-1.5">
                  {OFFER_TYPES.map(t => (
                    <button
                      key={t.value}
                      type="button"
                      disabled={readOnly}
                      onClick={() => onUpdate(product._key, { offer_type: t.value })}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                        product.offer_type === t.value
                          ? 'bg-violet-600 border-violet-500 text-white'
                          : 'bg-white/5 border-white/10 text-white/50 hover:text-white/80'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {(product.offer_type === 'percent' || product.offer_type === 'other') && (
                <div>
                  <label className={LABEL_CLASS} htmlFor={`text-${product._key}`}>Offer text</label>
                  <input
                    id={`text-${product._key}`}
                    value={product.offer_text || ''}
                    disabled={readOnly}
                    onChange={e => onUpdate(product._key, { offer_text: e.target.value })}
                    placeholder={product.offer_type === 'percent' ? 'e.g. 20% off' : 'e.g. Free delivery'}
                    className={INPUT_CLASS}
                  />
                </div>
              )}

              {badges.length > 0 && (
                <div>
                  <span className={LABEL_CLASS}>Badge</span>
                  <div className="flex flex-wrap gap-1.5">
                    {badges.map(b => {
                      const active = (product.badges || []).some(x => x.badge_id === b.id)
                      return (
                        <button
                          key={b.id}
                          type="button"
                          disabled={readOnly}
                          onClick={() => toggleBadge(b)}
                          className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors ${
                            active
                              ? BADGE_CHIP_COLOR[b.color] || BADGE_CHIP_COLOR.amber
                              : 'bg-white/5 border-white/10 text-white/40 hover:text-white/70'
                          }`}
                        >
                          {b.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {groups.length > 1 && (
                <div>
                  <label className={LABEL_CLASS} htmlFor={`group-${product._key}`}>Category</label>
                  <select
                    id={`group-${product._key}`}
                    value={product.group_id || ''}
                    disabled={readOnly}
                    onChange={e => onUpdate(product._key, { group_id: e.target.value || null })}
                    className={INPUT_CLASS}
                  >
                    <option value="">Default</option>
                    {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                </div>
              )}
            </div>
          )}

          {/* Delete — the one confirm in the row */}
          {!readOnly && (
            <div className="flex justify-end">
              {confirmDelete ? (
                <span className="inline-flex items-center gap-2 text-xs">
                  <span className="text-white/50">Remove this product?</span>
                  <button
                    type="button"
                    onClick={() => onRemove(product._key)}
                    className="px-2.5 py-1 rounded-lg font-semibold bg-rose-500/15 text-rose-300 border border-rose-500/25"
                  >
                    Remove
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="px-2.5 py-1 rounded-lg font-semibold bg-white/5 text-white/50 border border-white/10"
                  >
                    Keep
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="inline-flex items-center gap-1 text-xs text-white/30 hover:text-rose-300 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Remove
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

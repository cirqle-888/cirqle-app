'use client'

/**
 * State + save orchestration for the simple client intake.
 *
 * Everything server-side is the SAME token-gated actions the heavy editor
 * uses (saveCampaign / cloneLastCampaign) — this hook only owns the local
 * rows and the explicit-save lifecycle. No autosave: a shop owner on
 * cellular gets one deliberate "Submit offer" that either fully lands or
 * clearly fails (saveCampaign is many sequential round-trips; a silent
 * background retry loop would be worse than an honest button).
 */

import { useMemo, useState } from 'react'
import { saveCampaign, cloneLastCampaign, type ProductInput } from '../actions'
import type { CampaignRow, LocalProduct } from './types'
import { freshKey } from './types'

function tomorrowStr(): string {
  const t = new Date()
  t.setDate(t.getDate() + 1)
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}

/** Order-sensitive fingerprint of what a save would persist (same idea as the
 *  heavy editor's offerSignature) — powers the "unsaved changes" state. */
function signature(header: { title: string; offerDate: string; offerDateTo: string }, products: LocalProduct[]): string {
  return JSON.stringify([
    header.title.trim(), header.offerDate, header.offerDateTo,
    products.map(p => [
      p.name.trim(), p.weight?.trim() || '', p.image_url || '', p.offer_type,
      p.price ?? '', p.mrp ?? '', p.offer_text?.trim() || '', p.page || 1, p.group_id || '',
      (p.badges || []).map(b => [b.badge_id || '', b.custom_label || '', b.color]),
    ]),
  ])
}

function fromCampaign(campaign: CampaignRow | null): LocalProduct[] {
  return (campaign?.products || [])
    .slice()
    .sort((a, b) => a.display_order - b.display_order)
    .map((p, i) => ({
      id: p.id,
      _key: p.id,
      catalog_id: p.catalog_id,
      group_id: p.group_id ?? null,
      name: p.name,
      weight: p.weight || '',
      image_url: p.image_url || '',
      offer_type: p.offer_type || 'price',
      price: p.price ?? null,
      mrp: p.mrp ?? null,
      offer_text: p.offer_text || '',
      badges: (p.badges || []).map(b => ({
        badge_id: b.badge_id || null,
        custom_label: b.badge_id ? null : (b.custom_label || null),
        color: b.color || 'amber',
      })),
      page: p.page || 1,
      display_order: i,
    }))
}

export function useSimpleCampaign(token: string, campaign: CampaignRow | null) {
  const [products, setProducts] = useState<LocalProduct[]>(() => fromCampaign(campaign))
  const [title, setTitle] = useState(campaign?.title || '')
  const [dateType] = useState<'single' | 'range'>(campaign?.date_type || 'single')
  const [offerDate, setOfferDate] = useState(() => campaign?.offer_date || campaign?.offer_date_from || tomorrowStr())
  const [offerDateTo, setOfferDateTo] = useState(campaign?.offer_date_to || '')
  const [note, setNote] = useState('')

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [justSaved, setJustSaved] = useState(false)
  const [cloning, setCloning] = useState(false)

  const [savedSig, setSavedSig] = useState(() => signature({ title: campaign?.title || '', offerDate: campaign?.offer_date || campaign?.offer_date_from || tomorrowStr(), offerDateTo: campaign?.offer_date_to || '' }, fromCampaign(campaign)))
  const currentSig = useMemo(() => signature({ title, offerDate, offerDateTo }, products), [title, offerDate, offerDateTo, products])
  const dirty = currentSig !== savedSig

  function addProducts(items: (ProductInput & { _key?: string })[]) {
    setProducts(prev => [
      ...prev,
      ...items.map((p, i) => ({ ...p, _key: p._key || freshKey(), display_order: prev.length + i })),
    ])
    setJustSaved(false)
  }

  function updateProduct(key: string, patch: Partial<LocalProduct>) {
    setProducts(prev => prev.map(p => (p._key === key ? { ...p, ...patch } : p)))
    setJustSaved(false)
  }

  function removeProduct(key: string) {
    setProducts(prev => prev.filter(p => p._key !== key).map((p, i) => ({ ...p, display_order: i })))
    setJustSaved(false)
  }

  async function startFromLastWeek(): Promise<string> {
    setCloning(true)
    try {
      const res = await cloneLastCampaign(token)
      if (!res.ok || !res.data) return res.error || 'No previous offer to copy yet.'
      addProducts(res.data.products)
      return ''
    } finally {
      setCloning(false)
    }
  }

  async function save(): Promise<boolean> {
    if (saving) return false
    setSaving(true)
    setSaveError('')
    try {
      const res = await saveCampaign(
        token,
        {
          title: title.trim() || undefined,
          date_type: dateType,
          offer_date: dateType === 'single' ? offerDate : undefined,
          offer_date_from: dateType === 'range' ? offerDate : undefined,
          offer_date_to: dateType === 'range' ? (offerDateTo || offerDate) : undefined,
          client_note: note.trim() || undefined,
          products: products.map((p, i) => ({
            id: p.id,
            catalog_id: p.catalog_id,
            group_id: p.group_id ?? null,
            name: p.name.trim(),
            weight: p.weight?.trim() || undefined,
            image_url: p.image_url || undefined,
            offer_type: p.offer_type,
            price: p.price ?? null,
            mrp: p.mrp ?? null,
            offer_text: p.offer_text?.trim() || undefined,
            badges: p.badges || [],
            page: p.page || 1,
            display_order: i,
          })),
        },
        campaign?.id,
      )
      if (!res.ok || !res.data) {
        setSaveError(res.error || "Couldn't save your offer — check your connection and try again.")
        return false
      }
      // Adopt the server's row ids so a follow-up edit updates instead of
      // duplicating (mirrors what the heavy editor does after a save).
      const ids = res.data.productIds
      setProducts(prev => prev.map((p, i) => ({ ...p, id: ids[i] || p.id })))
      setSavedSig(currentSig)
      setJustSaved(true)
      setNote('')
      return true
    } catch {
      setSaveError("Couldn't save your offer — check your connection and try again.")
      return false
    } finally {
      setSaving(false)
    }
  }

  return {
    products, addProducts, updateProduct, removeProduct,
    title, setTitle, dateType, offerDate, setOfferDate, offerDateTo, setOfferDateTo,
    note, setNote,
    saving, saveError, setSaveError, justSaved, dirty,
    cloning, startFromLastWeek, save,
    hasExistingCampaign: !!campaign,
  }
}

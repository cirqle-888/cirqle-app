'use client'

/**
 * The ONE bottom sheet for adding products — three tabs, no other modals:
 *
 *   My products — the client's own catalog + shared library, searchable,
 *                 photos shown; one tap adds the product.
 *   New         — name + price; anything else can be edited on the row after.
 *   Paste list  — WhatsApp-style paste → parsed rows → add.
 *
 * Bottom-sheet on phones (slides from the bottom, thumb reach), centered
 * dialog on desktop — same component, CSS only.
 */

import { useMemo, useState } from 'react'
import { ImageIcon, Plus, Search, X } from 'lucide-react'
import type { CatalogItem } from './types'
import { INPUT_CLASS, LABEL_CLASS } from './types'
import type { ProductInput } from '../actions'
import { PasteListTab } from './paste-list-sheet'

type Tab = 'catalog' | 'new' | 'paste'

export function AddProductSheet({
  token, catalog, existingNames, onAdd, onClose,
}: {
  token: string
  catalog: CatalogItem[]
  /** Lowercased names already on the offer — shown as "added" in the picker. */
  existingNames: Set<string>
  onAdd: (items: ProductInput[]) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>(catalog.length ? 'catalog' : 'new')
  const [query, setQuery] = useState('')
  const [newName, setNewName] = useState('')
  const [newPrice, setNewPrice] = useState('')
  const [justAdded, setJustAdded] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q ? catalog.filter(c => c.name.toLowerCase().includes(q)) : catalog
    return list.slice(0, 60)
  }, [catalog, query])

  function addFromCatalog(item: CatalogItem) {
    onAdd([{
      catalog_id: item.id,
      name: item.name,
      weight: item.weight || undefined,
      image_url: item.image_url || undefined,
      offer_type: 'price',
      price: null,
      mrp: null,
      badges: [],
      page: 1,
      display_order: 0,
    }])
    setJustAdded(item.name)
    // Keep the sheet open — clients add many items in one sitting; closing
    // after each tap would double every add.
  }

  function addNew() {
    const name = newName.trim()
    if (!name) return
    const price = parseFloat(newPrice.replace(/[^\d.]/g, ''))
    onAdd([{
      name,
      offer_type: 'price',
      price: Number.isFinite(price) ? price : null,
      mrp: null,
      badges: [],
      page: 1,
      display_order: 0,
    }])
    setJustAdded(name)
    setNewName('')
    setNewPrice('')
  }

  const TABS: { key: Tab; label: string }[] = [
    ...(catalog.length ? ([{ key: 'catalog', label: 'My products' }] as { key: Tab; label: string }[]) : []),
    { key: 'new', label: 'New' },
    { key: 'paste', label: 'Paste list' },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      {/* Scrim */}
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/60" />

      <div className="relative w-full sm:max-w-lg max-h-[85dvh] flex flex-col bg-[#16161f] border border-white/10 rounded-t-3xl sm:rounded-3xl shadow-2xl">
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <div className="flex gap-1 bg-white/5 rounded-xl p-1">
            {TABS.map(t => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                  tab === t.key ? 'bg-violet-600 text-white' : 'text-white/50 hover:text-white/80'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
            aria-label="Done adding products"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {justAdded && (
          <div className="mx-4 mb-1 text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-1.5">
            Added <span className="font-semibold">{justAdded}</span> — set its price on the list.
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 pb-6 pt-2">
          {tab === 'catalog' && (
            <div className="space-y-3">
              <div className="relative">
                <Search className="w-4 h-4 text-white/30 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search your products…"
                  className={INPUT_CLASS + ' pl-9'}
                />
              </div>
              {filtered.length === 0 ? (
                <p className="text-sm text-white/40 text-center py-8">
                  Nothing found — add it from the <button type="button" className="text-violet-300 font-semibold" onClick={() => setTab('new')}>New</button> tab.
                </p>
              ) : (
                <ul className="grid grid-cols-1 gap-1.5">
                  {filtered.map(item => {
                    const added = existingNames.has(item.name.trim().toLowerCase())
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={() => addFromCatalog(item)}
                          className="w-full flex items-center gap-3 px-2.5 py-2 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.07] hover:border-white/20 text-left transition-colors"
                        >
                          {item.image_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={item.image_url} alt="" className="w-10 h-10 rounded-lg object-cover bg-black/30 shrink-0" />
                          ) : (
                            <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center shrink-0">
                              <ImageIcon className="w-3.5 h-3.5 text-white/20" />
                            </div>
                          )}
                          <span className="flex-1 min-w-0">
                            <span className="block text-sm font-medium text-white/85 truncate">{item.name}</span>
                            {item.weight && <span className="block text-xs text-white/35">{item.weight}</span>}
                          </span>
                          {added
                            ? <span className="text-[11px] font-semibold text-emerald-300/80 shrink-0">On the offer</span>
                            : <Plus className="w-4 h-4 text-violet-300 shrink-0" />}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}

          {tab === 'new' && (
            <div className="space-y-3">
              <div>
                <label className={LABEL_CLASS} htmlFor="add-new-name">Product name</label>
                <input
                  id="add-new-name"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addNew() }}
                  placeholder="e.g. Tomato"
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label className={LABEL_CLASS} htmlFor="add-new-price">Offer price (₹) <span className="font-normal text-white/30">(optional)</span></label>
                <input
                  id="add-new-price"
                  inputMode="decimal"
                  value={newPrice}
                  onChange={e => setNewPrice(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addNew() }}
                  placeholder="e.g. 49"
                  className={INPUT_CLASS}
                />
              </div>
              <p className="text-xs text-white/30">
                Weight, MRP, photo and badges can be added on the list afterwards.
              </p>
              <button
                type="button"
                onClick={addNew}
                disabled={!newName.trim()}
                className="w-full py-2.5 rounded-xl text-sm font-bold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-40 transition-colors flex items-center justify-center gap-2"
              >
                <Plus className="w-4 h-4" /> Add product
              </button>
            </div>
          )}

          {tab === 'paste' && <PasteListTab token={token} onAdd={items => { onAdd(items); onClose() }} />}
        </div>
      </div>
    </div>
  )
}

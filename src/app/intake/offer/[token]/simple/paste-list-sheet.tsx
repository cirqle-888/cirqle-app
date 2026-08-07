'use client'

/**
 * The "Paste list" tab of the add-product sheet.
 *
 * The client pastes their WhatsApp-style message; "Read my list" runs the
 * same server-side parser the rest of Cirqle uses (aiParseProductList — no
 * AI jargon in the UI). Parsed rows come back pre-checked; unchecking skips
 * a row; one button adds them all.
 */

import { useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { aiParseProductList, type ProductInput } from '../actions'
import { INPUT_CLASS } from './types'

interface ParsedRow {
  name: string
  price: number | null
  mrp: number | null
  weight: string | null
  badge: string | null
  checked: boolean
}

export function PasteListTab({
  token, onAdd,
}: {
  token: string
  onAdd: (items: ProductInput[]) => void
}) {
  const [text, setText] = useState('')
  const [rows, setRows] = useState<ParsedRow[]>([])
  const [parsing, setParsing] = useState(false)
  const [error, setError] = useState('')

  async function parse() {
    if (parsing || !text.trim()) return
    setParsing(true)
    setError('')
    try {
      const res = await aiParseProductList(token, text)
      if (!res.ok || !res.data) {
        setError(res.error || "Couldn't read that list — try tidying it up and paste again.")
        return
      }
      setRows(res.data.products.map(p => ({
        name: p.name,
        price: p.price ?? null,
        mrp: p.mrp ?? null,
        weight: p.weight ?? null,
        badge: p.badge ?? null,
        checked: true,
      })))
    } finally {
      setParsing(false)
    }
  }

  function addChecked() {
    const picked = rows.filter(r => r.checked)
    if (!picked.length) return
    onAdd(picked.map((r, i) => ({
      name: r.name,
      weight: r.weight || undefined,
      offer_type: 'price' as const,
      price: r.price,
      mrp: r.mrp,
      badges: r.badge ? [{ custom_label: r.badge, color: 'amber' }] : [],
      page: 1,
      display_order: i,
    })))
    setRows([])
    setText('')
  }

  const checkedCount = rows.filter(r => r.checked).length

  if (rows.length > 0) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-white/40">
          Found {rows.length} products — untick anything you don&apos;t want.
        </p>
        <ul className="space-y-1.5 max-h-[40dvh] overflow-y-auto">
          {rows.map((r, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => setRows(prev => prev.map((x, j) => (j === i ? { ...x, checked: !x.checked } : x)))}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl border text-left transition-colors ${
                  r.checked ? 'bg-violet-500/10 border-violet-500/25' : 'bg-white/[0.03] border-white/10 opacity-50'
                }`}
              >
                <span className={`w-4 h-4 rounded flex items-center justify-center border shrink-0 ${r.checked ? 'bg-violet-600 border-violet-500' : 'border-white/20'}`}>
                  {r.checked && <Check className="w-3 h-3 text-white" />}
                </span>
                <span className="flex-1 min-w-0 text-sm text-white/85 truncate">{r.name}</span>
                <span className="text-xs text-white/40 shrink-0">
                  {[r.weight, r.price != null ? `₹${r.price}` : null].filter(Boolean).join(' · ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setRows([])}
            className="px-4 py-2.5 rounded-xl text-sm font-semibold bg-white/5 text-white/50 border border-white/10 hover:text-white/80 transition-colors"
          >
            Back
          </button>
          <button
            type="button"
            onClick={addChecked}
            disabled={!checkedCount}
            className="flex-1 py-2.5 rounded-xl text-sm font-bold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-40 transition-colors"
          >
            Add {checkedCount} product{checkedCount === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-white/40">
        Paste your offer message exactly as you&apos;d send it on WhatsApp — we&apos;ll pick out the products and prices.
      </p>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        rows={7}
        placeholder={'Tomato 1kg 49\nOnion 1kg 39\nBanana 500g 25…'}
        className={INPUT_CLASS + ' resize-none font-mono text-[13px]'}
      />
      {error && (
        <div className="text-sm text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-xl px-3 py-2.5">{error}</div>
      )}
      <button
        type="button"
        onClick={() => void parse()}
        disabled={parsing || !text.trim()}
        className="w-full py-2.5 rounded-xl text-sm font-bold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-40 transition-colors flex items-center justify-center gap-2"
      >
        {parsing ? <><Loader2 className="w-4 h-4 animate-spin" /> Reading your list…</> : 'Read my list'}
      </button>
    </div>
  )
}

'use client'

import { useState } from 'react'
import { HelpCircle, X, Check, Copy } from 'lucide-react'
import { figmaBindingGuide } from '@/lib/offer-sheet'

/**
 * What to name a Figma layer so the Google Sheets plugin fills it.
 *
 * Staff kept asking which name goes where, and the cost of guessing is a layer
 * that silently stays blank — the sync reports success, the sheet has the data,
 * and only the finished flyer shows the gap. The mapping is generated from
 * OFFER_SHEET_HEADERS so it can never drift from the columns Cirqle writes.
 */

// Grouped so the list reads as "the ones you always need" before the rest,
// rather than 17 equal-weight rows.
const ESSENTIAL = new Set(['Product', 'Offer Price', 'MRP', 'Image URL', 'Badges'])

const NOTES: Record<string, string> = {
  'Product': 'Product name',
  'Offer Price': 'The selling price',
  'MRP': 'Struck-through price',
  'Image URL': 'Use on an IMAGE layer, not a text layer',
  'Badges': 'Comma-separated if there are several',
  'Price 1': 'Rupees only — for two-layer price designs',
  'Price 2': 'Paise only — blank on whole rupees',
  'Offer Date Display': '18, 19, 20 JULY 2026',
  'Offer Date Text': 'Offer valid on July 19 2026',
  'Weight': '500 g, 1 kg, 5 L…',
  'Offer Type': 'price · percent · bogo · other',
  'Offer Text': '“Buy 1 Get 1”, “50% Off”',
  'Offer Title': '“Weekend Bonanza”',
  'Client': 'Client name',
  'Page Number': 'Which page of the flyer',
  'Display Order': 'Position within the page',
}

function LayerRow({ column, layer }: { column: string; layer: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    await navigator.clipboard.writeText(layer)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="flex items-center gap-3 py-1.5 border-b border-border last:border-0">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-foreground truncate">{column}</div>
        {NOTES[column] && (
          <div className="text-[11px] text-muted-foreground truncate">{NOTES[column]}</div>
        )}
      </div>
      <button
        onClick={copy}
        title="Copy this layer name"
        className="shrink-0 flex items-center gap-1.5 font-mono text-xs px-2 py-1 rounded-md bg-secondary border border-border text-foreground hover:border-violet-500/40 transition-colors"
      >
        {layer}
        {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3 opacity-40" />}
      </button>
    </div>
  )
}

/**
 * `tone` picks the trigger's styling. The offer editor is a dark-only surface
 * with its own palette, while the dashboard follows the theme tokens — a
 * trigger styled for one looks broken on the other.
 */
export function FigmaBindingHelp({ tone = 'light' }: { tone?: 'light' | 'dark' }) {
  const [open, setOpen] = useState(false)
  const guide = figmaBindingGuide()
  const essential = guide.filter(g => ESSENTIAL.has(g.column))
  const rest = guide.filter(g => !ESSENTIAL.has(g.column))

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Which layer names to use in Figma"
        className={
          'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ' +
          (tone === 'dark'
            ? 'bg-white/5 border border-white/10 text-white/60 hover:text-white hover:bg-white/10'
            : 'bg-secondary border border-border text-muted-foreground hover:text-foreground')
        }
      >
        <HelpCircle className="w-3.5 h-3.5" /> Figma names
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl bg-card border border-border shadow-xl"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Figma layer names"
          >
            <div className="flex items-start gap-3 p-5 border-b border-border sticky top-0 bg-card">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-foreground">Naming layers in Figma</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  So the Google Sheets plugin fills them automatically
                </p>
              </div>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="shrink-0 p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-5">
              <div className="rounded-xl bg-secondary border border-border p-3">
                <p className="text-xs text-foreground leading-relaxed">
                  Name the layer <span className="font-mono font-semibold">#</span> plus the column name,
                  lowercase and without spaces. A text layer named{' '}
                  <span className="font-mono font-semibold">#product</span> receives the product name;{' '}
                  <span className="font-mono font-semibold">#offerprice</span> receives the price.
                </p>
                <p className="text-[11px] text-muted-foreground mt-2">
                  Each product is one copy of your component. Cirqle sends one row per product, and the plugin
                  repeats the component down the list.
                </p>
              </div>

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                  Almost every flyer uses these
                </p>
                <div className="rounded-xl border border-border px-3">
                  {essential.map(g => <LayerRow key={g.column} {...g} />)}
                </div>
              </div>

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                  The rest
                </p>
                <div className="rounded-xl border border-border px-3">
                  {rest.map(g => <LayerRow key={g.column} {...g} />)}
                </div>
              </div>

              <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 space-y-2">
                <p className="text-xs font-semibold text-foreground">Worth knowing</p>
                <ul className="text-[11px] text-muted-foreground space-y-1.5 list-disc pl-4">
                  <li>
                    The plugin reads the <strong>first tab</strong> of a spreadsheet only. If a client has
                    two flyers, give each one its own Google Sheet.
                  </li>
                  <li>
                    <span className="font-mono">#imageurl</span> goes on an image/rectangle layer — on a text
                    layer it prints the URL instead of the photo.
                  </li>
                  <li>
                    Use <span className="font-mono">#offerdatedisplay</span> or{' '}
                    <span className="font-mono">#offerdatetext</span> for the date instead of typing it, so it
                    can’t drift from the offer.
                  </li>
                  <li>
                    A misspelled name doesn’t error — the layer simply stays as it was. If something isn’t
                    updating, check its name first.
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

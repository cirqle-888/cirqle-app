import { useState } from 'react'
import { Sparkles, X, Loader2, Check, ArrowRight } from 'lucide-react'
import { generateAiSuggestions, type AiSuggestion } from './ai-service'
import type { ProductInput } from '../actions'

type LocalProduct = ProductInput & { _key: string; id?: string; page?: number; display_order?: number }

interface AiAssistantPanelProps {
  products: LocalProduct[]
  onApplySuggestion: (productKey: string, updates: Partial<ProductInput>) => void
}

export function AiAssistantPanel({ products, onApplySuggestion }: AiAssistantPanelProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [suggestions, setSuggestions] = useState<AiSuggestion[]>([])
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set())

  const handleOpen = async () => {
    setIsOpen(true)
    if (suggestions.length === 0) {
      setLoading(true)
      const sugs = await generateAiSuggestions({ products })
      setSuggestions(sugs)
      setLoading(false)
    }
  }

  const apply = (suggestion: AiSuggestion, idx: number) => {
    if (!suggestion.productKey) return
    const id = `${suggestion.productKey}-${idx}`
    if (appliedIds.has(id)) return

    if (suggestion.type === 'price') {
      onApplySuggestion(suggestion.productKey, { price: parseFloat(suggestion.suggestedValue) })
    } else if (suggestion.type === 'text') {
      onApplySuggestion(suggestion.productKey, { offer_text: suggestion.suggestedValue })
    }
    
    setAppliedIds(prev => new Set([...prev, id]))
  }

  return (
    <>
      <button 
        onClick={handleOpen}
        className="fixed bottom-6 right-6 z-40 flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-3 rounded-full shadow-lg shadow-indigo-900/40 transition-transform hover:scale-105"
      >
        <Sparkles className="w-5 h-5" />
        <span className="font-semibold text-sm">AI Assistant</span>
      </button>

      {isOpen && (
        <div className="fixed bottom-20 right-6 z-50 w-[350px] bg-[#1a1a24] border border-indigo-500/30 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[600px]">
          <div className="px-4 py-3 bg-indigo-600/10 border-b border-indigo-500/20 flex items-center justify-between">
            <h3 className="font-bold text-indigo-300 flex items-center gap-2">
              <Sparkles className="w-4 h-4" /> Cirqle Assistant
            </h3>
            <button onClick={() => setIsOpen(false)} className="text-white/50 hover:text-white transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
          
          <div className="p-4 flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex flex-col items-center justify-center py-10 text-indigo-400">
                <Loader2 className="w-6 h-6 animate-spin mb-3" />
                <p className="text-sm">Analyzing products...</p>
              </div>
            ) : suggestions.length === 0 ? (
              <div className="text-center py-10 text-white/40 text-sm">
                No suggestions right now. Your offer looks great!
              </div>
            ) : (
              <div className="space-y-3">
                {suggestions.map((sug, i) => {
                  const id = `${sug.productKey}-${i}`
                  const applied = appliedIds.has(id)
                  const prod = products.find(p => p._key === sug.productKey)
                  
                  return (
                    <div key={id} className="bg-white/5 border border-white/10 rounded-xl p-3">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div>
                          <p className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider">{sug.type}</p>
                          <p className="text-sm font-medium text-white/90">{prod?.name || 'Product'}</p>
                        </div>
                        {applied ? (
                          <span className="text-[10px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded flex items-center gap-1"><Check className="w-3 h-3" /> Applied</span>
                        ) : null}
                      </div>
                      
                      <p className="text-xs text-white/60 mb-2">{sug.reason}</p>
                      
                      {sug.originalValue && (
                        <div className="flex items-center gap-2 text-xs mb-3">
                          <span className="line-through text-white/30">{sug.originalValue}</span>
                          <ArrowRight className="w-3 h-3 text-white/30" />
                          <span className="text-emerald-400 font-medium">{sug.suggestedValue}</span>
                        </div>
                      )}
                      
                      {!applied && (
                        <button 
                          onClick={() => apply(sug, i)}
                          className="w-full py-1.5 bg-white/10 hover:bg-white/15 text-white/90 text-xs font-medium rounded-lg transition-colors"
                        >
                          Apply Suggestion
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

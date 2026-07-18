import { useState, useMemo } from 'react'
import { AlertCircle, AlertTriangle, ChevronDown, ChevronUp, ArrowRight } from 'lucide-react'
import type { ValidationIssue } from './useValidationEngine'
import type { ProductInput } from '../actions'

type LocalProduct = ProductInput & { _key: string; id?: string; page?: number; display_order?: number }

interface ValidationPanelProps {
  issues: ValidationIssue[]
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
  products: LocalProduct[]
}

export function ValidationPanel({ issues, errors, warnings, products }: ValidationPanelProps) {
  const [expanded, setExpanded] = useState(false)

  // Group issues by category. Hooks MUST run before the zero-issues early
  // return below — otherwise fixing the last issue changes the hook order
  // between renders (React "change in the order of Hooks" error).
  const errorGroups = useMemo(() => {
    const groups: Record<string, ValidationIssue[]> = {}
    errors.forEach(e => {
      if (!groups[e.message]) groups[e.message] = []
      groups[e.message].push(e)
    })
    return groups
  }, [errors])

  const warningGroups = useMemo(() => {
    const groups: Record<string, ValidationIssue[]> = {}
    warnings.forEach(w => {
      if (!groups[w.message]) groups[w.message] = []
      groups[w.message].push(w)
    })
    return groups
  }, [warnings])

  if (issues.length === 0) {
    return (
      <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl px-4 py-3 mb-5 flex items-center gap-3">
        <AlertCircle className="w-5 h-5 text-emerald-400 shrink-0" />
        <p className="text-sm text-emerald-300 flex-1">Validation ✓ Ready</p>
      </div>
    )
  }

  const handleGoToProduct = (key?: string) => {
    if (!key) return
    const el = document.getElementById(`product-row-${key}`) || document.getElementById(`product-card-${key}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('ring-2', 'ring-violet-500', 'ring-offset-2', 'ring-offset-[#1a1a24]')
      setTimeout(() => {
        el.classList.remove('ring-2', 'ring-violet-500', 'ring-offset-2', 'ring-offset-[#1a1a24]')
      }, 2000)
    }
  }

  return (
    <div className={`border rounded-2xl mb-5 transition-colors ${errors.length > 0 ? 'bg-red-500/10 border-red-500/30' : 'bg-amber-500/10 border-amber-500/30'}`}>
      <div 
        className="px-4 py-3 flex items-center justify-between cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3">
          {errors.length > 0 ? (
            <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
          )}
          <p className="text-sm font-medium text-white/90">
            Validation: {errors.length > 0 && <span className="text-red-400 mr-2">{errors.length} Errors</span>}
            {warnings.length > 0 && <span className="text-amber-400">{warnings.length} Warnings</span>}
          </p>
        </div>
        <button aria-label="Toggle Validation Panel" className="p-1 rounded text-white/60 hover:text-white transition-colors">
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>
      
      {expanded && (
        <div className="px-4 pb-4 pt-2 border-t border-white/10 space-y-4">
          {Object.entries(errorGroups).length > 0 && (
            <div>
              <h4 className="text-xs font-bold text-red-400 uppercase tracking-wider mb-2">Errors</h4>
              <ul className="space-y-2">
                {Object.entries(errorGroups).map(([msg, items]) => (
                  <li key={msg} className="text-sm text-red-200/80 bg-red-900/20 rounded-lg p-2.5">
                    <div className="font-medium mb-1">{msg} ({items.length})</div>
                    <div className="flex flex-wrap gap-2">
                      {items.map(item => {
                        const prod = products.find(p => p._key === item.productKey)
                        return (
                          <button 
                            key={item.id}
                            onClick={() => handleGoToProduct(item.productKey)}
                            className="inline-flex items-center gap-1 text-xs bg-red-500/20 hover:bg-red-500/30 text-red-300 px-2 py-1 rounded transition-colors"
                          >
                            {prod?.name || 'Unnamed'} <ArrowRight className="w-3 h-3" />
                          </button>
                        )
                      })}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          
          {Object.entries(warningGroups).length > 0 && (
            <div>
              <h4 className="text-xs font-bold text-amber-400 uppercase tracking-wider mb-2">Warnings</h4>
              <ul className="space-y-2">
                {Object.entries(warningGroups).map(([msg, items]) => (
                  <li key={msg} className="text-sm text-amber-200/80 bg-amber-900/20 rounded-lg p-2.5">
                    <div className="font-medium mb-1">{msg} ({items.length})</div>
                    <div className="flex flex-wrap gap-2">
                      {items.map(item => {
                        const prod = products.find(p => p._key === item.productKey)
                        return (
                          <button 
                            key={item.id}
                            onClick={() => handleGoToProduct(item.productKey)}
                            className="inline-flex items-center gap-1 text-xs bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 px-2 py-1 rounded transition-colors"
                          >
                            {prod?.name || 'Unnamed'} <ArrowRight className="w-3 h-3" />
                          </button>
                        )
                      })}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

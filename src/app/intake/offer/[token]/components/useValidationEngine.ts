import { useMemo } from 'react'
import type { ProductInput } from '../actions'

type LocalProduct = ProductInput & { _key: string; id?: string; page?: number; display_order?: number }

export type ValidationIssueType = 'error' | 'warning'

export interface ValidationIssue {
  id: string
  type: ValidationIssueType
  category: string
  message: string
  productKey?: string
}

export function useValidationEngine(products: LocalProduct[]) {
  return useMemo(() => {
    const issues: ValidationIssue[] = []

    const nameWeightPageMap = new Map<string, string[]>()

    products.forEach((p, i) => {
      // 1. Missing Data
      if (!p.name || !p.name.trim()) {
        issues.push({ id: `err-name-${p._key}`, type: 'error', category: 'Missing Data', message: 'Product name is empty', productKey: p._key })
      }
      if (p.price === null || p.price === undefined) {
        issues.push({ id: `err-price-${p._key}`, type: 'error', category: 'Missing Data', message: 'Missing selling price', productKey: p._key })
      }
      if (!p.image_url) {
        issues.push({ id: `err-img-${p._key}`, type: 'error', category: 'Missing Data', message: 'Missing image', productKey: p._key })
      }
      if (!p.page) {
        issues.push({ id: `warn-page-${p._key}`, type: 'warning', category: 'Missing Data', message: 'No page assignment', productKey: p._key })
      }

      // 2. Pricing Issues
      if (p.price !== null && p.price !== undefined) {
        if (p.price <= 0) {
          issues.push({ id: `err-price-zero-${p._key}`, type: 'error', category: 'Pricing', message: 'Price cannot be zero or negative', productKey: p._key })
        }
        if (p.mrp !== null && p.mrp !== undefined && p.price > p.mrp) {
          issues.push({ id: `err-price-mrp-${p._key}`, type: 'error', category: 'Pricing', message: 'Offer Price > MRP', productKey: p._key })
        }
      }

      // 3. Duplicate Detection
      const dedupKey = `${(p.name || '').trim().toLowerCase()}|${(p.weight || '').trim().toLowerCase()}|${p.page || 1}`
      if (!nameWeightPageMap.has(dedupKey)) {
        nameWeightPageMap.set(dedupKey, [])
      }
      nameWeightPageMap.get(dedupKey)!.push(p._key)

      // 4. Text Validation
      if (p.offer_text && p.offer_text.length > 30) {
        issues.push({ id: `warn-text-len-${p._key}`, type: 'warning', category: 'Text', message: 'Offer text might be too long', productKey: p._key })
      }
      
      const badgeLabels = (p.badges || []).map(b => b.custom_label || '').join('')
      if (badgeLabels.length > 20) {
        issues.push({ id: `warn-badge-len-${p._key}`, type: 'warning', category: 'Text', message: 'Badge text might be too long', productKey: p._key })
      }

      if (p.weight) {
        // Regex to check if weight looks like "500g", "1kg", etc.
        const validWeightFormat = /^\d+(\.\d+)?\s*(g|gm|kg|ml|l|ltr|pcs|pack|nos)$/i
        if (!validWeightFormat.test(p.weight.trim())) {
          issues.push({ id: `warn-weight-fmt-${p._key}`, type: 'warning', category: 'Text', message: `Weight '${p.weight}' has unusual format`, productKey: p._key })
        }
      }
    })

    // Process Duplicates
    nameWeightPageMap.forEach((keys, mapKey) => {
      if (keys.length > 1) {
        keys.forEach(k => {
          issues.push({
            id: `err-dup-${k}`,
            type: 'error',
            category: 'Duplicate',
            message: 'Duplicate product detected (Same name, weight, and page)',
            productKey: k
          })
        })
      }
    })

    const errors = issues.filter(i => i.type === 'error')
    const warnings = issues.filter(i => i.type === 'warning')

    return { issues, errors, warnings }
  }, [products])
}

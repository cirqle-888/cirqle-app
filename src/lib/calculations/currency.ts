import { Currency } from '@/types'

const CURRENCY_SYMBOLS: Record<Currency, string[]> = {
  INR: ['₹'],
  AED: ['د.إ.', 'dh', 'AED'],
  SAR: ['SAR', '﷼'],
  USD: ['$', 'USD'],
  QAR: ['Rial', 'QAR'],
  GBP: ['£', 'GBP'],
  EUR: ['€', 'EUR'],
}

export function detectCurrency(value: string): Currency {
  const v = value.trim()
  if (v.includes('₹')) return 'INR'
  if (v.includes('د.إ.') || v.toLowerCase().includes('dh') || v.includes('AED')) return 'AED'
  if (v.includes('SAR') || v.includes('﷼')) return 'SAR'
  if (v.includes('$') || v.includes('USD')) return 'USD'
  if (v.includes('Rial') || v.includes('QAR')) return 'QAR'
  if (v.includes('£') || v.includes('GBP')) return 'GBP'
  if (v.includes('€') || v.includes('EUR')) return 'EUR'
  return 'INR'
}

export function extractAmount(value: string): number {
  const cleaned = value.replace(/[₹د.إ.$£€﷼]/g, '')
    .replace(/AED|SAR|USD|QAR|GBP|EUR|Rial|dh/gi, '')
    .replace(/,/g, '')
    .trim()
  return parseFloat(cleaned) || 0
}

export async function convertToINR(
  amount: number,
  currency: Currency,
  rates: Record<Currency, number>
): Promise<number> {
  if (currency === 'INR') return amount
  const rate = rates[currency] || 1
  return amount * rate
}

// Hoisted formatter — instantiating Intl.NumberFormat is expensive (~50-200μs
// per call). When a table renders 1000+ rows each calling this 2-3 times,
// reusing one instance saves ~100-600ms of pure allocation.
const INR_FORMATTER = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
export function formatINR(amount: number): string {
  return INR_FORMATTER.format(amount)
}

const CURRENCY_DISPLAY_SYMBOLS: Record<Currency, string> = {
  INR: '₹',
  AED: 'AED ',
  SAR: 'SAR ',
  USD: '$',
  QAR: 'QAR ',
  GBP: '£',
  EUR: '€',
}

export function getCurrencySymbol(currency: Currency = 'INR'): string {
  return CURRENCY_DISPLAY_SYMBOLS[currency] || currency
}

export function formatCurrency(amount: number, currency: Currency = 'INR'): string {
  return `${getCurrencySymbol(currency)}${amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
}

export function formatCompact(amount: number): string {
  if (amount >= 100000) return `₹${(amount / 100000).toFixed(2)}L`
  if (amount >= 1000) return `₹${(amount / 1000).toFixed(2)}K`
  return `₹${amount.toFixed(2)}`
}

// ── FX helpers ────────────────────────────────────────────────────────────────
// Shared by the <CurrencyAmountInput> widget (cashbook + invoice payments) and
// server-side payment/entry writes so the foreign → rate → INR math is identical
// everywhere. Rates are stored numeric(18,6); money numeric(14,2).

/** Round to 2 decimals (money), guarding against binary-float drift. */
export function round2(n: number): number {
  return Math.round(((n || 0) + Number.EPSILON) * 100) / 100
}

/** INR base value for a foreign amount at a given rate: base = foreign × rate. */
export function computeInr(foreignAmount: number, rate: number): number {
  return round2((foreignAmount || 0) * (rate || 0))
}

/** Implied rate from a known INR amount and foreign amount: rate = INR ÷ foreign. */
export function computeRate(inrAmount: number, foreignAmount: number): number {
  if (!foreignAmount) return 0
  return Math.round(((inrAmount || 0) / foreignAmount) * 1e6) / 1e6
}

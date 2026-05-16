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

export function formatINR(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

export function formatCurrency(amount: number, currency: Currency = 'INR'): string {
  const symbols: Record<Currency, string> = {
    INR: '₹',
    AED: 'AED ',
    SAR: 'SAR ',
    USD: '$',
    QAR: 'QAR ',
    GBP: '£',
    EUR: '€',
  }
  return `${symbols[currency]}${amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
}

export function formatCompact(amount: number): string {
  if (amount >= 100000) return `₹${(amount / 100000).toFixed(2)}L`
  if (amount >= 1000) return `₹${(amount / 1000).toFixed(2)}K`
  return `₹${amount.toFixed(2)}`
}

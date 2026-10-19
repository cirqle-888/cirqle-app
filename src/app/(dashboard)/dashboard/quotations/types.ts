import type { Currency } from '@/types'

export interface QuotationItem {
  description: string
  quantity: number
  unit_price: number
  total: number
  display_order?: number | null
}

export interface QuotationClient {
  id: string
  name: string
  code: string
  phone?: string | null
  email?: string | null
  address?: string | null
}

export interface Quotation {
  id: string
  quotation_number: string
  client_id: string
  status: string
  issue_date: string
  valid_until?: string
  currency: Currency
  total_amount: number
  notes?: string
  terms?: string
  client?: QuotationClient
  items?: QuotationItem[]
}

export type ClientRow = QuotationClient

/** The columns every quotation read selects: header, client contact (for the document) and lines. */
export const QUOTATION_SELECT = '*, client:clients(id, name, code, phone, email, address), items:quotation_items(*)'

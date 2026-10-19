import { canOpenHref, type NavItem } from '@/lib/nav-sections'

export const CREATE_SHORTCUTS = [
  { id: 'qa-task', label: 'Create new task', href: '/dashboard/tasks?new=true', permission: 'tasks.create' },
  { id: 'qa-invoice', label: 'Create new invoice', href: '/dashboard/invoices?new=true', permission: 'billing.edit' },
  { id: 'qa-quotation', label: 'Create new quotation', href: '/dashboard/quotations?new=true', permission: 'billing.edit' },
  { id: 'qa-cashbook', label: 'Add cashbook entry', href: '/dashboard/cashbook?new=true', permission: 'cashbook.edit' },
] as const

export function availableCreateShortcuts(can: (key: string) => boolean, isAdmin: boolean, isViewAs = false) {
  if (isViewAs) return []
  return CREATE_SHORTCUTS.filter(item => can(item.permission) && canOpenHref(item.href, can, isAdmin))
}

export function canOpenSearchHref(href: string, can: (key: string) => boolean, isAdmin: boolean, isViewAs = false): boolean {
  if (!canOpenHref(href, can, isAdmin)) return false
  const url = new URL(href, 'https://cirqle.local')
  if (url.searchParams.get('new') !== 'true') return true
  const shortcut = CREATE_SHORTCUTS.find(item => item.href.split('?')[0] === url.pathname)
  return !shortcut || (!isViewAs && can(shortcut.permission))
}

export function matchesNavSearch(item: NavItem, query: string): boolean {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  const text = [item.label, ...(item.keywords ?? [])].join(' ').toLowerCase()
  return terms.every(term => text.includes(term))
}

export function searchResultHref(kind: 'task' | 'invoice' | 'quotation' | 'client' | 'project' | 'cashbook', id: string, label = '') {
  const encoded = encodeURIComponent(id)
  switch (kind) {
    case 'task': return `/dashboard/tasks?q=${encodeURIComponent(label)}`
    case 'invoice': return `/dashboard/invoices?id=${encoded}`
    case 'quotation': return `/dashboard/quotations/${encoded}`
    case 'client': return `/dashboard/clients/${encoded}`
    case 'project': return `/dashboard/advertising/${encoded}`
    case 'cashbook': return `/dashboard/cashbook?focus=${encoded}`
  }
}

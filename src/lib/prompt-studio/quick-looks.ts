import type { PromptTemplate } from './types'

export interface SavedQuickLook {
  id: string
  name: string
  template_key: string
  client_id: string | null
  values: Record<string, string>
  style_id: string | null
  language: string
}

// Content changes on each job. Keep appearance choices and their free-form notes.
const content = new Set(['product', 'text', 'subline', 'need', 'shots', 'speech', 'scriptText', 'problem', 'moments', 'refs'])
export function quickLookValues(template: PromptTemplate, values: Record<string, string>) {
  return Object.fromEntries(template.fields
    .filter(f => !content.has(f.key) && !(f.required && (f.type === 'text' || f.type === 'textarea')))
    .map(f => [f.key, values[f.key] ?? template.defaults?.[f.key] ?? '']))
}

export function applyQuickLook(template: PromptTemplate, current: Record<string, string>, saved: Record<string, string>) {
  return { ...current, ...quickLookValues(template, saved) }
}

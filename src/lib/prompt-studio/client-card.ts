/**
 * Prompt Studio — the Client Card. Filled once per client and prepended to
 * every template that uses it, so nobody re-explains the brand each time.
 */
import type { PromptField } from './types'

export const CLIENT_CARD_FIELDS: PromptField[] = [
  { key: 'brand',      label: 'Brand',               type: 'text',     required: true, placeholder: 'Seastar' },
  { key: 'business',   label: 'Business',            type: 'text',     placeholder: 'Wedding packages and event management' },
  { key: 'location',   label: 'Location',            type: 'text',     placeholder: 'Neerad, Kondotty, Malappuram, Kerala' },
  { key: 'offer',      label: 'Offer',               type: 'textarea', placeholder: '1000 guests package for ₹3,45,000' },
  { key: 'contact',    label: 'Phone / address',     type: 'textarea', placeholder: '+91 98463 17155 | +91 81293 68417' },
  { key: 'audience',   label: 'Audience',            type: 'text',     placeholder: 'Malabar Muslim families planning a wedding' },
  { key: 'language',   label: 'Language for voice and text', type: 'select', options: ['Malayalam', 'English', 'Manglish', 'Malayalam + English', 'Arabic', 'Hindi', 'Tamil'] },
  { key: 'look',       label: 'Look and feel',       type: 'text',     placeholder: 'Warm, grand, festive, local Malabar' },
  { key: 'colors',     label: 'Brand colors',        type: 'text',     placeholder: 'Maroon #7A1F2B, gold #D4A64A, cream' },
  { key: 'mustShow',   label: 'Must show',           type: 'textarea', placeholder: 'Entrance decor, dream entry, stage, photography, food, team' },
  { key: 'neverShow',  label: 'Never show',          type: 'textarea', placeholder: 'Alcohol, other brands, music with lyrics' },
  { key: 'lengthSize', label: 'Length and size',     type: 'text',     placeholder: '45 seconds, 9:16 vertical' },
  { key: 'tools',      label: 'Tools I am using',    type: 'text',     placeholder: 'Veo 3.1 in Flow, Gemini voice, Mureka music' },
]

/** Fields that can be pre-filled from the clients table when a card is first opened. */
export const CARD_PREFILL_FROM_CLIENT: Record<string, 'name' | 'phone' | 'address'> = {
  brand: 'name',
  contact: 'phone',
  location: 'address',
}

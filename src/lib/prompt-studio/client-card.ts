/**
 * Prompt Studio — the Client Card. Filled once per client and prepended to
 * every template that uses it, so nobody re-explains the brand each time.
 */
import type { PromptField } from './types'
import { COLOR_USE_OPTIONS } from './colors'

// New fields go at the END: the card prints in this order, and saved prompts
// were built with the older fields first.
export const CLIENT_CARD_FIELDS: PromptField[] = [
  { key: 'brand',      label: 'Brand',               type: 'text',     required: true, placeholder: 'Seastar' },
  { key: 'business',   label: 'Business',            type: 'text',     placeholder: 'Wedding packages and event management' },
  { key: 'location',   label: 'Location',            type: 'text',     placeholder: 'Neerad, Kondotty, Malappuram, Kerala' },
  { key: 'offer',      label: 'Offer',               type: 'textarea', placeholder: '1000 guests package for ₹3,45,000' },
  { key: 'contact',    label: 'Phone / address',     type: 'textarea', placeholder: '+91 98463 17155 | +91 81293 68417' },
  { key: 'audience',   label: 'Audience',            type: 'text',     placeholder: 'Malabar Muslim families planning a wedding' },
  { key: 'language',   label: 'Language for voice and text', type: 'select', options: ['Malayalam', 'English', 'Manglish', 'Malayalam + English', 'Arabic', 'Hindi', 'Tamil'] },
  { key: 'look',       label: 'Look and feel',       type: 'text',     placeholder: 'Warm, grand, festive, local Malabar' },
  { key: 'colors',     label: 'Brand colors',        type: 'text',     placeholder: 'Maroon #7A1F2B, gold #D4A64A, cream',
    help: 'Add the colour codes (like #7A1F2B) when you have them: the AI then uses the exact shade.' },
  { key: 'mustShow',   label: 'Must show',           type: 'textarea', placeholder: 'Entrance decor, dream entry, stage, photography, food, team' },
  { key: 'neverShow',  label: 'Never show',          type: 'textarea', placeholder: 'Alcohol, other brands, music with lyrics' },
  { key: 'lengthSize', label: 'Length and size',     type: 'text',     placeholder: '45 seconds, 9:16 vertical' },
  { key: 'tools',      label: 'Tools I am using',    type: 'text',     placeholder: 'Veo 3.1 in Flow, Gemini voice, Mureka music' },
  { key: 'logo',       label: 'Logo link',           type: 'text',     placeholder: 'https://drive.google.com/… or the logo on their website',
    help: 'Paste a link to the logo, or upload the file below. "Copy for AI" then has an Open logo and a Copy logo image shortcut, for attaching it in the AI tool.' },
  { key: 'colorUse',   label: 'How to use colour',   type: 'select',   options: [...COLOR_USE_OPTIONS],
    help: 'Exact: only the brand colours. Accents: neutral backgrounds with brand colours on headlines and tags. Matching: colours that pair with the brand, when the client does not need the exact shades.' },
  { key: 'platforms',  label: 'Platforms',           type: 'multi',    options: ['Instagram', 'Facebook', 'WhatsApp', 'YouTube', 'LinkedIn', 'TikTok', 'X'] },
  { key: 'postsPerWeek', label: 'Posts per week',    type: 'text',     placeholder: '3 posters + 2 reels' },
  { key: 'goal',       label: 'Main goal',           type: 'select',   options: ['Walk-ins', 'Calls', 'WhatsApp orders', 'Bookings', 'Followers', 'Website visits'] },
  { key: 'gulf',       label: 'Gulf audience',       type: 'text',     placeholder: 'Malayali families in UAE (leave empty if none)' },
  { key: 'worked',     label: 'What worked before',  type: 'textarea', placeholder: 'Staff reels, weekend fish offer posters' },
  { key: 'competitors', label: 'Pages they like or compete with', type: 'text', placeholder: '@page1, @page2' },
]

/** Fields that can be pre-filled from the clients table when a card is first opened. */
export const CARD_PREFILL_FROM_CLIENT: Record<string, 'name' | 'phone' | 'address'> = {
  brand: 'name',
  contact: 'phone',
  location: 'address',
}

export interface CardGroup {
  id: string
  name: string
  keys: string[]
  /** Shown only with Advanced on. */
  advanced?: boolean
}

/** How the card editor lays the fields out. Every field is in exactly one group. */
export const CARD_GROUPS: CardGroup[] = [
  { id: 'basics', name: 'Basics',       keys: ['brand', 'business', 'location', 'audience', 'language', 'contact'] },
  { id: 'brand',  name: 'Brand look',   keys: ['logo', 'colors', 'colorUse', 'look'] },
  { id: 'social', name: 'Social media', keys: ['platforms', 'postsPerWeek', 'goal', 'gulf'] },
  { id: 'more',   name: 'More details', keys: ['offer', 'mustShow', 'neverShow', 'worked', 'competitors', 'lengthSize', 'tools'], advanced: true },
]

/** Printed as their own lines (see render.ts), not as "Label: value". */
export const CARD_SPECIAL_KEYS = ['logo', 'colorUse']

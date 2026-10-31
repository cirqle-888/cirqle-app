/**
 * Prompt Studio — shared types.
 *
 * A template is a "prompt that writes a prompt": the user fills a few fields in
 * their own words, the template wraps them with the client's card and a tight
 * set of rules, and the result is pasted into any AI (Claude, ChatGPT, Gemini),
 * which replies with a short, ready-to-use prompt for the video/image/voice tool.
 */

/**
 * text / textarea / number: typed in. select: one of `options` from a dropdown.
 * choice: one of `options` shown as picture cards. multi: any number of
 * `options` (stored as "A; B; C"), shown as tick chips or picture cards.
 * toggle: a tick box ("yes" or ""). It is not in the body: it shows or hides
 * the fields whose `showIf` names it, and a hidden field counts as empty.
 */
export type FieldType = 'text' | 'textarea' | 'select' | 'number' | 'choice' | 'multi' | 'toggle'

/** Which little picture each option of a choice/multi field gets (see option-preview.tsx). */
export type PreviewKind =
  | 'text-effect' | 'text-font' | 'text-angle' | 'text-space' | 'text-lines'
  | 'photo-angle' | 'photo-pose' | 'photo-shadow'

/** How the ticked options of a multi field are joined (options may contain commas). */
export const MULTI_SEP = '; '
export const splitMulti = (v: string | undefined): string[] => (v || '').split(';').map(x => x.trim()).filter(Boolean)

export const FIELD_TYPES: FieldType[] = ['textarea', 'text', 'select', 'choice', 'multi', 'number', 'toggle']
/** The value a ticked toggle holds. */
export const TOGGLE_ON = 'yes'
export const PREVIEW_KINDS: PreviewKind[] = ['text-effect', 'text-font', 'text-angle', 'text-space', 'text-lines', 'photo-angle', 'photo-pose', 'photo-shadow']

export interface PromptField {
  /** Placeholder name used in the body as {{key}}. */
  key: string
  label: string
  type: FieldType
  placeholder?: string
  /** For type 'select'. */
  options?: string[]
  /** Required fields must be filled before the prompt can be copied. */
  required?: boolean
  /** Short hint shown under the field. */
  help?: string
  /** Only shown (and only used) while this toggle field is ticked. */
  showIf?: string
  /** choice/multi: draw a small picture for each option. */
  preview?: PreviewKind
  /**
   * Show an "add a picture" box with this field. The picture stays in the
   * browser: it drives the live preview and reminds the user what to attach in
   * the AI tool. It is never uploaded or saved.
   */
  attach?: boolean
}

/** A one-click set of values, e.g. the same photo look for every product in a flyer. */
export interface PromptPreset {
  name: string
  /** One line under the button. */
  note?: string
  values: Record<string, string>
}

export type CategoryId = 'flyer' | 'ad' | 'film' | 'product' | 'agency' | 'fix'
export const CATEGORY_IDS: CategoryId[] = ['flyer', 'ad', 'film', 'product', 'agency', 'fix']

export interface PromptCategory {
  id: CategoryId
  name: string
  description: string
}

export interface PromptTemplate {
  /** Stable id, never renamed (saved library rows point at it). */
  key: string
  name: string
  category: CategoryId
  /** One line: what this template is for. */
  purpose: string
  /** Where the AI's answer gets pasted. */
  useIn: string
  /** Prepend the client's card when a client is picked. */
  usesClientCard: boolean
  fields: PromptField[]
  /**
   * The prompt text. {{key}} is replaced by the field value. A line whose
   * placeholders are ALL empty (and not required) is dropped, so optional
   * fields cost no tokens when unused.
   */
  body: string
  /** One practical tip shown under the template. */
  tip?: string
  /** Ready-made value sets shown as buttons above the form. */
  presets?: PromptPreset[]
  /** Draw a rough live picture of the chosen options (see live-preview.tsx). */
  livePreview?: 'text-effect' | 'product-photo'
  /** Fields keep these values until the user changes them. */
  defaults?: Record<string, string>
  /**
   * The prompt goes straight into the image tool (with the attached photo),
   * not to a chat AI first: no "Generate here" and no Answer box.
   */
  direct?: boolean
}

/** Values of one client's card, keyed by CLIENT_CARD_FIELDS[].key. */
export type ClientCard = Record<string, string>

export interface StudioClient { id: string; name: string; phone: string | null; address: string | null }
export interface SavedCard { client_id: string; card: ClientCard; updated_at: string }
export interface CustomTemplate extends PromptTemplate { id: string; based_on?: string | null }
export interface LibraryItem {
  id: string; client_id: string | null; template_key: string; template_name: string;
  title: string | null; inputs: Record<string, string>; prompt: string; ai_result: string | null;
  is_favorite: boolean; created_at: string; created_by?: string | null;
}
export type LibraryInput = Omit<LibraryItem, 'id' | 'created_at' | 'is_favorite' | 'created_by'>
/** Library tab filters; `before` is the created_at of the last row already shown. */
export interface LibraryQuery { search?: string; clientId?: string; templateKey?: string; favorites?: boolean; before?: string }
/** How many saved prompts load at a time. */
export const LIBRARY_PAGE = 50
export type ActionResult<T = undefined> = { ok: boolean; error?: string; data?: T }

/**
 * Prompt Studio — shared types.
 *
 * A template is a "prompt that writes a prompt": the user fills a few fields in
 * their own words, the template wraps them with the client's card and a tight
 * set of rules, and the result is pasted into any AI (Claude, ChatGPT, Gemini),
 * which replies with a short, ready-to-use prompt for the video/image/voice tool.
 */

export type FieldType = 'text' | 'textarea' | 'select' | 'number'

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
}

export type CategoryId = 'ad' | 'film' | 'product' | 'agency' | 'fix'

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
}

/** Values of one client's card, keyed by CLIENT_CARD_FIELDS[].key. */
export type ClientCard = Record<string, string>

export interface StudioClient { id: string; name: string; phone: string | null; address: string | null }
export interface SavedCard { client_id: string; card: ClientCard; updated_at: string }
export interface CustomTemplate extends PromptTemplate { id: string; based_on?: string | null }
export interface LibraryItem {
  id: string; client_id: string | null; template_key: string; template_name: string;
  title: string | null; inputs: Record<string, string>; prompt: string; ai_result: string | null;
  is_favorite: boolean; created_at: string;
}
export type LibraryInput = Omit<LibraryItem, 'id' | 'created_at' | 'is_favorite'>
export type ActionResult<T = undefined> = { ok: boolean; error?: string; data?: T }

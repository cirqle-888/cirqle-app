/**
 * Prompt Studio — saved styles.
 *
 * "Style from a picture" answers with a STYLE RECIPE (NAME, STYLE, COLOURS,
 * ELEMENTS, Avoid). People save it to the Library and then either mix it into
 * any template's prompt or turn it into their own text-effect template.
 */
import type { CustomTemplate, PromptField } from './types'
import { templateByKey } from './templates'

export const STYLE_TEMPLATE_KEY = 'flyer-style-recipe'

/** A saved style as offered in the "Mix in a saved style" picker. */
export interface SavedStyle { id: string; title: string; recipe: string }

/** Name and recipe from a style answer. Unknown shapes keep the whole answer as the recipe. */
export function styleFromAnswer(answer: string): { name: string; recipe: string } {
  const lines = answer.replace(/\*\*/g, '').split('\n').map(l => l.trim()).filter(Boolean)
  const nameLine = lines.find(l => /^name\s*:/i.test(l))
  const name = nameLine?.replace(/^name\s*:\s*/i, '').trim().slice(0, 80) || 'My style'
  const recipe = lines.filter(l => l !== nameLine).join('\n')
    // Braces would turn into form fields in a template.
    .replace(/\{\{|\}\}/g, '')
    .trim()
  return { name, recipe }
}

/** The block a saved style adds to any prompt. */
export function styleBlock(recipe: string): string {
  return `STYLE TO FOLLOW (from a saved reference — copy this look, not its words):\n${recipe.trim()}`
}

/**
 * A custom "3D text in this style" template: the same text, lines, space and
 * background choices as the 3D text effect template, with the recipe fixed in.
 */
export function styleTemplate(name: string, recipe: string): CustomTemplate {
  const base = templateByKey('flyer-text-effect')!
  const pick = (key: string): PromptField => {
    return { ...base.fields.find(x => x.key === key)! }
  }
  const fields = [pick('text'), pick('lines'), pick('subline'), pick('space'), pick('background')]
  fields[3] = { ...fields[3], help: 'Pick the shape of the space on the flyer.' }
  return {
    id: '', key: '', name: `${name} text`.slice(0, 120), category: 'flyer',
    purpose: `3D headline lettering in the saved “${name}” style`,
    useIn: base.useIn, usesClientCard: true, based_on: STYLE_TEMPLATE_KEY,
    fields,
    body: `You write prompts for AI image tools that make 3D headline lettering for shop offer flyers. Use the CLIENT CARD above.

TEXT (spell exactly): "{{text}}"
Lines: {{lines}}
Small line in a ribbon: "{{subline}}"
Text space: {{space}}
Background: {{background}}

STYLE (follow closely):
${recipe.trim()}

Task: write ONE image prompt for this headline in the style above.
Rules:
- Show only the text above (and the small line, if given), spelled exactly. No other words, logos or numbers.
- Fill the text space's shape and size; nothing cut off.
- Big, bold and easy to read from far away.
- 4K, sharp, clean edges ready to cut out.
- Maximum 120 words.

Output only the prompt. Then one line starting "Avoid:" with 5 short things to avoid. No explanation.`,
  }
}

---
name: prompt-template-builder
description: Turn a short brief into new Prompt Studio templates (video, image, voice, music, social or any other purpose) in the house format, add them to the Cirqle app library, and check them.
---

# Prompt template builder

Use this when Farooq wants new or upgraded prompt templates, for example "add templates for podcast videos", "a template for Arabic real estate ads", or "make the video clip template better for Kling". The library lives in the Cirqle app at `src/lib/prompt-studio/templates.ts`, with types in `types.ts`, rendering in `render.ts` and tests in `prompt-studio.test.ts`. The app's Prompt Studio page shows them automatically.

## 1. Understand the brief (ask at most 2 questions)
Work out:
- **The jobs:** one template per job. Split a brief like "wedding film" into story, shots, clips and so on.
- **Where the answer is pasted:** which tool.
- **Whether it needs the Client Card:** client work does; personal or story work does not.
- **The category:** `ad`, `film`, `product`, `agency` or `fix`. If none fits and more than 3 templates share a new theme, add a category to `CATEGORIES` and to the migration's `category` check constraint, and say that an SQL change is needed.

If the brief is clear, don't ask; state the reading you took.

## 2. Write each template in the house format
```ts
{
  key: '<category>-<short-name>',    // stable id, never rename an existing key
  name: 'Short name',                // 2–4 words, plain English
  category: 'ad',
  purpose: 'One line: what it is for',
  useIn: 'Tool(s) where the answer is pasted',
  usesClientCard: true,
  fields: [NEED, /* shared fields first: REFS, SHOTS, RATIO, SECONDS, VIDEO_TOOL, PRODUCT, GENRE, BIBLE */ ],
  body: `You <role>. Use the CLIENT CARD above.

MY NEED: {{need}}
<Label>: {{otherField}}

Task: <one job>.
Rules:
- <4 to 7 short rules: structure, realism, what to keep consistent, what to avoid>
- Maximum <N> words.

Output only <exact shape>. No explanation.`,
  tip: 'One practical tip (optional).',
}
```

Rules every template must follow:
- **One job, one answer.** A hard word limit on the produced prompt (60–120 words for generation prompts).
- Start with `Output only … No explanation.` so the AI doesn't chat. Use `${AVOID_LINE}` for image and video prompts.
- Templates with `usesClientCard: true` say "Use the CLIENT CARD above."
- Put each optional field on its own line, so an empty field drops out. Mark the main need `required`.
- Every `{{placeholder}}` is a declared field, and every field is used. The tests check this.
- Plain, simple English in labels and help text; the team is not technical.
- Video: 8 s or less, one camera move, one action, the size stated, no text in the video.
- Voice: numbers in words, no `<` tags, about 2 to 2.5 words per second.
- Music: instrumental, original, BPM, the shape over time.
- Nothing invented: no prices, claims or real people.
- To upgrade an existing template, keep its `key` and edit its body or fields.

## 3. Add and check
1. Add the templates at the end of their category array in `templates.ts`.
2. Run `npx vitest run src/lib/prompt-studio` and `npm run typecheck`, and fix anything they report.
3. Render one filled example of each new template with `renderPrompt` and read it as a user would. Check that it is short and clear, with no leftover `{{` or empty labels.
4. Commit on a branch named `templates/<short-topic>` only if asked to commit. Never push without being asked.

## 4. If the app is not available
Give each template as a ready-to-paste block in the reply: the prompt with `[BLANKS]` and a one-line "use in". Offer to add them to the app later, or for Farooq to paste them into Prompt Studio → My Templates.

## 5. Report back
List the new or changed templates as name → purpose, one line each, and say where they appear in Prompt Studio. Don't paste the full template text unless asked.

# Prompt Studio — build spec

**What it is:** a page in the Cirqle app where anyone on the team picks a client and a template, fills a few boxes in plain words, and gets a ready-to-paste prompt. They paste it into any AI (Claude, ChatGPT, Gemini), or press "Generate here" to get the final prompt inside the app. Each client's details are saved once as a **Client Card** and added to every prompt automatically.

**Already written (do not rewrite, only integrate):**

| File | What it holds |
|---|---|
| `src/lib/prompt-studio/types.ts` | `PromptTemplate`, `PromptField`, `ClientCard`, categories |
| `src/lib/prompt-studio/client-card.ts` | `CLIENT_CARD_FIELDS` (13 fields) and `CARD_PREFILL_FROM_CLIENT` |
| `src/lib/prompt-studio/templates.ts` | `CATEGORIES` (5) and `TEMPLATES` (48 built-in templates) |
| `src/lib/prompt-studio/render.ts` | `renderPrompt`, `renderBody`, `renderClientCard`, `missingRequired`, `placeholdersIn`, `estimateTokens` |
| `src/lib/prompt-studio/prompt-studio.test.ts` | Library and renderer tests (10, passing) |
| `skills/*/SKILL.md` | 4 reusable skills: video-ad-production, video-prompt-writer, video-finishing, prompt-template-builder |
| `src/lib/prompt-studio/skills.ts` + `skills.test.ts` | Skills as data for the Skills tab (generated; tests passing) |
| `scripts/sync-prompt-skills.mjs` | Regenerates `skills.ts` after a SKILL.md is edited or added |

Built-in templates live in code. The database only holds what people save: client cards, their own custom templates, and the prompt library.

---

## 1. House rules to follow

- Read `AGENTS.md`. This Next.js version differs from training data. Check `node_modules/next/dist/docs/` before writing routes or server actions.
- **Reads are server-side only.** Use `createAdminClient()` and `fetchAll()` in `page.tsx`, the way `quote-planner/page.tsx` does. The browser never calls `.from()`; `rls-grants.test.ts` fails if it does.
- **Writes go through `'use server'` actions** guarded by `requirePermission(...)` from `@/lib/permissions/check`. A `'use server'` file may export **only** async functions. Put shared types in `src/lib/prompt-studio/types.ts`.
- Reuse the existing UI: the `Header` component, `.field` inputs, `bg-card border border-border rounded-xl` sections, `useToast`/`ToastContainer`, `ConfirmDialog`, `EmptyState`.
- "Not set up yet" pattern: copy `finance/profit-sharing/_not-installed.tsx` and the missing-table detection in its `_shared.ts` (`PGRST205` / "does not exist").

## 2. Database — `supabase/migrations/20261028120000_prompt_studio.sql`

Wrap it in `BEGIN; … COMMIT;` and make it safe to re-run (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`).

```
prompt_client_cards
  id uuid pk default gen_random_uuid()
  client_id uuid not null unique references clients(id) on delete cascade
  card jsonb not null default '{}'          -- keys = CLIENT_CARD_FIELDS[].key
  updated_by uuid references employees(id) on delete set null
  created_at, updated_at timestamptz not null default now()

prompt_templates                            -- custom templates only
  id uuid pk
  key text not null unique                  -- 'custom-<slug>-<short id>'
  name text not null
  category text not null check (category in ('ad','film','product','agency','fix'))
  purpose text, use_in text
  uses_client_card boolean not null default true
  fields jsonb not null default '[]'        -- PromptField[]
  body text not null
  based_on text                             -- built-in key it was duplicated from
  created_by uuid references employees(id) on delete set null
  created_at, updated_at, deleted_at

prompt_library                              -- saved prompts
  id uuid pk
  client_id uuid references clients(id) on delete set null
  template_key text not null, template_name text not null
  title text
  inputs jsonb not null default '{}'
  prompt text not null
  ai_result text
  is_favorite boolean not null default false
  created_by uuid references employees(id) on delete set null
  created_at timestamptz not null default now(), deleted_at timestamptz
  index (created_at desc) where deleted_at is null; index (client_id)
```

- **Security:** follow the `20261022100000_profit_sharing.sql` pattern. Enable RLS, `REVOKE ALL … FROM anon, authenticated`, `GRANT ALL … TO service_role`, no policies.
- **Permissions:**
  - `prompt_studio.view` (label "Use Prompt Studio"): open the page, build, copy, generate, and save to the library.
  - `prompt_studio.manage` (label "Manage Prompt Studio"): edit Client Cards and create, edit or delete custom templates.
  - Grant both to designations where `is_admin = TRUE`.
- **Rollback:** `supabase/rollbacks/20261028120000_prompt_studio_down.sql`.
- **APPLIED.md:** add a row under "Waiting to be applied".

## 3. Wiring

- `src/lib/permissions/keys.ts`: add `PROMPT_STUDIO_VIEW` and `PROMPT_STUDIO_MANAGE` with doc comments. Not financial, not critical.
- `src/lib/supabase/middleware.ts` `ROUTE_PERMS`: add `[/^\/dashboard\/prompt-studio/, 'prompt_studio.view']`.
- `src/lib/nav-sections.ts`, **Marketing** section, right after Social:
  - Label `Prompt Studio`, href `/dashboard/prompt-studio`, icon `Wand2`, `requiredPerm: 'prompt_studio.view'`.
  - Keywords: `prompt, ai video, veo, kling, script, voiceover, music, client card, template, film, series, product video, reel`.
- `src/components/layout/header.tsx` `ROUTE_LABELS`: `'prompt-studio': 'Prompt Studio'`.

## 4. Files — `src/app/(dashboard)/dashboard/prompt-studio/`

- **`page.tsx`** (server, `dynamic = 'force-dynamic'`)
  - Gate with `prompt_studio.view` (admin always).
  - Load: active clients (`id, name, phone, address`), all cards, custom templates (not deleted), and the latest 200 library rows.
  - Pass `canManage` and `aiEnabled = !!process.env.GROQ_API_KEY`.
  - If the tables are missing, render `NotInstalled` above a working Create tab. Built-in templates and Copy still work; saving is hidden.
- **`actions.ts`**, each action returning `{ ok, error?, data? }`:
  - Manage permission: `saveClientCard(clientId, card)`, `saveCustomTemplate(t)`, `deleteCustomTemplate(id)` (soft delete).
  - View permission: `saveToLibrary(row)`, `toggleFavorite(id)`, `deleteLibraryItem(id)` (soft delete).
  - `generateWithAI(prompt)`, view permission, using `callGroqJSON` from `@/lib/ai/groq`:
    - System prompt: `Follow the user's instructions exactly. Reply ONLY with JSON {"result": "<your full answer as plain text>"}.`
    - Options: `{ maxTokens: 1500 }`.
    - Return `result`. Show a friendly error if it is empty.
- **`prompt-studio-client.tsx`**: the UI below.

## 5. UI — simple first, power second

Five tabs across the top: **Create · Client Cards · My Templates · Library · Skills**. On a phone everything stacks into one column with large tap targets.

### Create (the default tab)

1. **Client**
   - A searchable picker with "No client" first. Next to it is a chip showing the card's state:
     - Green "Card saved": hovering shows the card.
     - Amber "No card yet · Add": opens the Client Cards tab on that client.
2. **Template**
   - Category chips (the 5 from `CATEGORIES`, plus "My templates" and "Favorites"). Add a search box that matches name and purpose.
   - Template cards show the name and the purpose line. Custom templates get a small "Custom" badge.
   - Starring a template keeps it at the top. Store stars in localStorage, wrapped in try/catch.
3. **Fill**
   - The form is built from `template.fields`:
     - `textarea` auto-grows, `select` uses the given options, `number` uses a small input.
     - Required fields show an asterisk; `help` appears as grey text under its field.
   - Above the form, show "Paste the answer into: {useIn}". Below it, show the tip.
4. **Result**, a live preview updated as the user types:
   - Read-only monospace box showing `renderPrompt(template, values, card)`, with "≈ N tokens" from `estimateTokens`.
   - **Copy prompt** (primary button):
     - Disabled until `missingRequired` is empty; while disabled, list the missing labels.
     - Ctrl/Cmd+Enter copies.
     - After copying: toast "Copied — paste into Claude, ChatGPT or Gemini".
   - **Generate here** (only if `aiEnabled`):
     - Runs `generateWithAI` and shows the answer in a second box with its own Copy button.
     - Small note under it: "Free AI — check Malayalam wording before use."
   - **Save to Library**: saves the prompt, inputs and AI result, with an optional title.
   - **Duplicate as my template** (manage permission only): opens My Templates prefilled with this template.
   - **Clear**: empties the form.
- Remember the last client, category and template in localStorage, wrapped in try/catch.

### Client Cards

- A list of active clients with search. Each row shows "Card saved · updated <date>" or "No card".
- Clicking a row opens a form of the 13 `CLIENT_CARD_FIELDS`.
  - With no card yet, prefill brand, contact and location from the client record (`CARD_PREFILL_FROM_CLIENT`).
  - Show a live "How it will appear" preview from `renderClientCard`.
- Save requires manage permission; without it the form is read-only.
- Button **"Fill from a client message"**: switches to Create with the `fix-brief-to-card` template and this client selected.

### My Templates

- A list of custom templates, plus **New template**.
- Editor fields: name, category, purpose, "paste into", "add client card" toggle, and body.
- Fields are **detected automatically** from the `{{placeholders}}` in the body using `placeholdersIn()`:
  - Each detected field gets editable label, type and required settings, and defaults to a textarea.
  - Fields are added or removed as the body changes, keeping settings already chosen.
- Live preview with sample values. Saving requires manage permission.

### Library

- Saved prompts, newest first. Filters: client, template, favorites only; plus search.
- Each row shows title, client, template and date, with these actions:
  - Copy prompt and Copy AI result.
  - Favorite toggle.
  - **Open in Create**, which restores the template, client and inputs.
  - Delete, behind `ConfirmDialog`.

### Skills

The reusable Claude skills for video work. They are already written; the tab only lists them and offers downloads.

- **Source of truth:** `skills/<name>/SKILL.md` at the repo root (4 skills, committed).
- **Generated module:** `src/lib/prompt-studio/skills.ts` is generated from those files by `node scripts/sync-prompt-skills.mjs`. `skills.test.ts` fails if the two drift apart.
- **Make Claude Code load them:** copy each `skills/<name>/` folder into `.claude/skills/<name>/`, or symlink `.claude/skills` → `../skills`. `.claude/` is git-ignored, so this stays local; do it once on this Mac.
- **The tab:**
  - One card per skill from `PROMPT_SKILLS`, showing the title and summary plus four buttons:
    - **Download .zip** builds `<name>.zip` containing `<name>/SKILL.md` in the browser with `jszip` (already a dependency). This is the format claude.ai uses for uploading a skill.
    - **Download SKILL.md** saves the plain file.
    - **Copy** copies the text.
    - **View** expands it read-only.
  - At the top: **Download all (.zip)** with every skill in one zip.
  - A short "How to use" box in plain words:
    1. In Claude (web or desktop), go to Settings → Capabilities → Skills, upload the .zip, and switch it on.
    2. Claude Code needs nothing more; the skills are already in this project.
    3. To add or improve a template, ask Claude: "use prompt-template-builder to add templates for …".
- **Permissions:** visible to anyone with `prompt_studio.view`. The skills are static text with no secrets, and there is no database.

## 6. Done when

- [ ] Work is on a new branch `feature/prompt-studio`.
- [ ] `npm run typecheck`, `npm test` and `npm run lint` pass.
- [ ] I can open `/dashboard/prompt-studio` locally, pick a client, fill "Video clip" and copy a prompt. Check it at phone width and desktop width.
- [ ] Without the migration applied, the page still loads, Copy works, and the setup banner shows.
- [ ] Everything is committed on the branch. **Do not push or run the migration.** Tell me the SQL file to run in Supabase and the checks to do after.

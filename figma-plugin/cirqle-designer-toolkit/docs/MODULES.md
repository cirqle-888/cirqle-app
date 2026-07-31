# Module reference: capabilities and honest limitations

Same spirit as good internal documentation everywhere: state plainly where
a limit comes from the Figma Plugin API itself, a heuristic, or a
deliberate scope decision — rather than discovering it the hard way in
production. Every item below was self-reported by the engineer (human or
agent) who built that module, then reviewed for this document.

## 1. Bulk Rename

Pure `buildNewName()` (in `renameEngine.ts`) applies find & replace →
prefix/suffix → smart variables, in that order, and never throws — an
invalid regex is reported per-row instead of aborting the batch. `{nn}`
auto-pads to the widest index in the whole batch, not a fixed width.

**Verify before relying on it:**
- `getNodeById`/multi-page "Document" scope traversal assumes
  `dynamic-page` pages are already loaded; under strict `dynamic-page`
  access this can throw for pages other than the current one — flagged by
  the implementing agent as inherited from `traversal.ts`, not module-local.
- Undo closes over live `SceneNode` references (not re-resolved by id) —
  correct as long as the node hasn't been removed elsewhere in the
  meantime.

## 2. Cleaner

Twelve detectors, Quick (cheap, single-pass: hidden/invisible/empty/
zero-size/off-canvas/empty-section) vs Deep (adds duplicate image/
component/style hashing and unused-style checks, which are meaningfully
only correct at Document scope).

**Documented heuristics, not hard guarantees:**
- *Duplicate component* = same name + rounded size + child count. **Not**
  byte-identical detection.
- *Off-canvas* = a configurable-threshold heuristic on parent-relative
  position, not a true absolute-position diff — can misfire on deeply
  nested or rotated layers.
- *Detached instance* = `INSTANCE` node with no resolvable main component.
  Figma exposes no "was detached via the Detach command" marker, so this
  overlaps with genuinely broken instances by design.
- **Delete has no Undo.** Figma has no generic node deserialization API —
  faking undo-for-delete would be worse than not offering it. History
  still records what was deleted; Figma's native Cmd/Ctrl+Z is the real
  safety net here.
- Selecting nodes that span multiple pages only selects the subset on the
  first resolved node's page — Figma only supports single-page selection.

## 3. Accessibility Checker

Contrast math (`colorUtils.ts`) is exact WCAG 2.1 relative-luminance/
contrast-ratio — that part is not a heuristic, it's the spec formula,
runtime-verified in this build (black/white = 21:1, AA/AAA thresholds
correct).

**Where it's necessarily approximate:**
- **Background detection.** The Plugin API has no pixel-read/compositing
  access, so "what's behind this text" is a heuristic: nearest ancestor
  with a visible ~opaque solid fill, falling back to white with the
  fallback explicitly flagged in the finding's metadata.
- **Colour-blindness simulation shows colour *values*, not a live render
  filter.** The four CVD matrices are applied to each distinct fill/stroke
  hex found — there's no way to filter Figma's actual rendered pixels from
  a plugin. The UI states this explicitly next to the swatch grid.
- Multi-style text (`figma.mixed` font/size) uses the *dominant* segment
  by character count, not a true per-character analysis.
- Font-weight reading has a speculative path (a numeric `fontWeight`
  property) alongside a safe fallback (parsing the font style name for
  "Bold"/"Semi Bold" etc.) — re-verify the numeric path once
  `@figma/plugin-typings` is actually installed.
- `applyFix` mutations are `undoable: false` (see the Undo model in
  `ARCHITECTURE.md`).

PDF export runs entirely in the UI thread via `jsPDF` (jsPDF needs a DOM —
the main thread never imports it, by design).

## 4. Automator

20 actions, each wrapped per-node in try/catch so one bad node can't abort
a batch (failures surface as `warnings`, not a thrown error).

**The two actions that are honest best-effort, not a full re-implementation
of Figma's native commands:**
- `createComponent` — carries over geometry and children, but **not**
  auto-layout, constraints, `clipsContent`, effects, corner radius, fills/
  strokes, or blend mode from the source node.
- `ungroup` — correct for an unrotated group (translates children by the
  group's x/y offset, since a group-child's x/y is group-relative); does
  **not** un-rotate children the way Figma's native Ungroup does for a
  rotated group.

**Other things worth knowing:**
- `replaceFont` skips (warns on) text nodes with mixed fonts within one
  node — only replaces a single uniform font per node.
- `swapComponent`/`updateVariable` try the modern API first
  (`swapComponentAsync`, `figma.variables.*`) and fall back / warn
  gracefully if unavailable on the installed typings or the file's plan.
- Macro steps all run against **one shared node-list snapshot** resolved
  once at the start, not re-resolved after each step — simpler and more
  predictable, at the cost of a later step not "seeing" nodes an earlier
  step created or renamed. Documented trade-off, not an oversight.
- Automator's own `export` action is a lightweight macro convenience
  (single format/scale, pushed back via an event since the action
  registry's return shape doesn't carry bytes) — Export Manager (Module 8)
  is the real batch/naming-preset tool.
- "Share a macro" has no backend (`manifest.json` sets
  `networkAccess: none` on purpose) — implemented honestly as JSON export
  + copy-to-clipboard, not a fake network share.

## 5. Template Validator

Generalizes a real production pattern (a `#layerName` contract a data-fill
step depends on) into a configurable rule-set system with two seed
presets. Auto-fix placeholder creation always loads a font
(`figma.loadFontAsync`, with an Inter → first-available fallback) before
touching `.characters`, since Figma blocks text edits in unloaded fonts.

Auto-fix history entries are `undoable: false` — Figma's native undo still
covers it.

## 6. Component Manager

"Unused components" requires a **full-document** instance scan (mapping
every `INSTANCE`'s main component id) — the expensive check in this
module, chunked and progress-reported. Reports unused components rolled up
to the `COMPONENT_SET` level where relevant (a documented design choice,
not the only valid one). Duplicate detection is the same
name+size+child-count heuristic as Cleaner's, independently implemented
(each module is intentionally self-contained rather than sharing
cross-module logic).

`swapComponentAsync`/`getMainComponentAsync` availability isn't confirmed
against real installed typings in this environment — implemented with a
three-tier fallback (`Async` method → sync method → direct property
assignment) and feature-detection casts; re-verify once
`@figma/plugin-typings` is actually installed. `batchRelink` exists as a
main-thread action but has no dedicated UI control yet (the page only
exposes single-target swap + bulk variant update) — a good first Roadmap
item.

## 7. Asset Manager

"Duplicate" = same `imageHash` used by 2+ nodes (a hard fact, not a
heuristic). "Possibly unused" is explicitly a heuristic (only used by
hidden/off-canvas nodes) — Figma has no real separate "asset library"
concept to query, only fills-on-nodes. Compress/Replace apply identical
output bytes to every node sharing a given hash (avoids re-encoding the
same image N times) — a deliberate simplification worth knowing about if
you expected per-node independent compression.

Image compression and WebP encoding are UI-thread-only (need Canvas) —
main thread only ever sends/receives raw bytes, never touches image
codecs.

## 8. Export Manager

Figma's real native export formats are exactly PNG/JPG/SVG/PDF. **There is
no native WebP** — a WebP request exports PNG bytes from the main thread
and re-encodes to WebP in the UI thread via Canvas before download.

**"Folder structure" is baked into filenames, not real folders.** A Figma
plugin's UI is a browser context — it cannot write directories to disk,
only trigger flat file downloads. A naming preset like `{name}/{scale}x.
{format}` becomes a filename like `ProductCard__2x.png`; this is stated in
the UI copy, not silently different from what was promised.

## 9. Document Analytics

A full-document scan is inherently the slow module — always chunked and
progress-reported, with a UI warning on Document scope for large files.
`estimatedFileSizeKb`, `complexityScore`, and `performanceScore` are all
explicitly-documented weighted heuristics (Figma exposes no real byte size
via the Plugin API) — useful for relative comparison between files, not
as an exact number. The Variables count gracefully degrades to
"unavailable" (not `0`) when `figma.variables` isn't accessible on the
current plan/editor.

## 10. Design QA

Every one of its eight checks (missing constraints, missing auto-layout,
inconsistent spacing/radius/shadow/typography, duplicate text styles,
missing variable bindings) is a **documented heuristic with known
false-positive shapes** — e.g. default `MIN/MIN` constraints can be a
genuinely intentional choice, not always a mistake; "evenly spaced
children" can happen by coincidence without meaning "should be
auto-layout." Tunable thresholds live at the top of `qaEngine.ts`/
`designQATypes.ts` specifically so they're easy to recalibrate per team
without touching the detection logic.

## 11. Shortcuts

Global keydown handling (`⌘/Ctrl+K` for the command palette, `⌘/Ctrl+,`
for Settings, `⌘/Ctrl+Shift+H` for Home, `⌘/Ctrl+Shift+<letter>` per
module) plus fuzzy substring search in the palette — not a full
fuzzy-match scoring algorithm, a simple `indexOf`-based rank. Good enough
for twelve modules; would need a real scorer if the command list grows
much larger. With an empty query the palette ranks by pinned → usage →
registry order (`toolOrganizer.rankedForPalette`), and lists hidden tools
last with a "Hidden" badge — hiding a tool never removes it from search.

## 12. Settings

Theme follows Figma's own injected `--figma-color-*` CSS variables by
default (`themeColors: true` in `figma.showUI`), with an explicit
light/dark/system override. History and the activity log are both capped
and persisted via `figma.clientStorage`. "Language" only ships English
today — the selector exists so adding a second language later doesn't
require new UI, only translation strings (see `docs/ROADMAP.md`).

The **Tools** tab controls what the main interface shows: pin (★) a tool
to keep it at the top of the sidebar and Home, hide (👁) one to remove it
from the main interface without disabling it, and reset the usage data
that drives the automatic ranking. Usage is tracked by the `trackUsage`
settings action — App.tsx fires it after a module has been on screen for
1.5 s, and merges only `usageCounts`/`recentlyUsed` from the response so
an in-flight optimistic settings edit can't be clobbered. Stored settings
are merged over `DEFAULT_SETTINGS` on every load, so settings saved by an
older version (without `hiddenTools`/`usageCounts`) upgrade in place.

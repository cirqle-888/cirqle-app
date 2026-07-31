# Architecture

## The two-thread split (why everything here looks the way it does)

Every Figma plugin is actually two programs running in two different
JavaScript environments that can only talk to each other via
`postMessage`:

- **The main thread** (`src/main/**`) runs inside Figma's own plugin
  sandbox. It has the global `figma` API and can read/mutate the document,
  but it has **no DOM** — no `window`, `document`, `fetch`, `Canvas`,
  `localStorage`. It's a single bundled IIFE (`dist/code.js`).
- **The UI thread** (`src/ui/**`) is a normal browser iframe running the
  React app. It has the full DOM/Canvas, but **no `figma` global** — it
  cannot touch the document directly. It's a single self-contained HTML
  file (`dist/ui.html`, built with `vite-plugin-singlefile` since a Figma
  plugin UI can't load external JS/CSS at runtime).

Nothing in this codebase should cross that boundary directly. A few modules
deliberately round-trip data across it (Asset Manager's image compression,
Accessibility's PDF export) — those are the exception, not the rule, and
are called out explicitly in `docs/MODULES.md`.

## The message protocol (`src/shared/messages.ts`)

Every module speaks the same envelope, which is what let the twelve
modules be built independently against one contract instead of
hand-wiring twelve different postMessage shapes:

```
UI                                              Main thread
--- { kind:'request', id, module, action, payload } -->
<-- { kind:'progress', id, module, progress } -----------  (zero or more)
<-- { kind:'result', id, module, payload } --------------  (or 'error')
```

Main thread → UI can also push unsolicited `{ kind:'event', module, event,
payload }` messages (used for menu-command deep-linking and live selection
count).

- `src/main/bridge.ts` — `registerModule(id, handler)` + `startDispatcher()`
  wire every module's `handle(action, payload, ctx)` into this envelope on
  the main-thread side.
- `src/ui/lib/bridge.ts` + `src/ui/hooks/usePluginMessage.ts` — the UI-side
  request/response client. A page never touches `postMessage` directly:
  `const { run, loading, progress } = usePluginMessage('rename'); await
  run('preview', payload)`.

## Performance: chunked traversal (`src/main/utils/chunk.ts`, `traversal.ts`)

The brief requires no UI freeze on 10,000+ layer files. Figma's plugin
sandbox has no Worker/requestIdleCallback, so "async" here means
`processInChunks`/`processInChunksAsync` yielding to the event loop
(`setTimeout(0)`) every N items — which lets Figma repaint and lets a
cancel signal be honoured mid-scan. **Every module's document walk uses
this**; a raw `for`/`.forEach()` over a full-document scan is the one
thing every module was explicitly told not to do.

## Undo model

Figma's Plugin API has no generic "give me back the node I just deleted"
primitive — there's no serialize/deserialize for arbitrary nodes. So undo
is implemented two different ways depending on what's actually possible:

- **Reversible mutations** (rename, recolour, etc.) keep a small in-memory,
  main-thread-only stack (capped ~20) of closures that know how to put the
  value back, returned to the UI as an opaque `undoToken`. This is lost
  when the plugin closes — an accepted, documented limitation, not a bug.
- **Irreversible mutations** (Cleaner's delete) are marked `undoable: false`
  on their history entry and simply don't offer an Undo button. Figma's own
  Cmd/Ctrl+Z still works as the real safety net for anything the plugin
  itself can't reverse.

## Settings, history and macros

All persisted via `figma.clientStorage` (per-user, per-plugin, main-thread
only — see `src/main/utils/storage.ts`), which is why Settings/History/
Macros all route through the message protocol instead of the UI reading
storage directly.

## Where each module's "brain" actually lives

Every module keeps its Figma-API-touching code in `src/main/modules/<id>/`
and, wherever the underlying logic doesn't need `figma` at all (name
building, colour maths, chunk scheduling), factors it into a **pure
function** with no `figma`/DOM/clock dependency — e.g.
`rename/renameEngine.ts`, `utils/colorUtils.ts`. That's what makes those
pieces trivially unit-testable (see `*.test.ts` next to them) without a
Figma sandbox mock, and it's the pattern to follow for any new module.

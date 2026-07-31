# Installation

## 0. First run — do this before anything else

This project was built and reviewed in a sandboxed environment whose
network policy blocked `registry.npmjs.org`, so **no `npm install` has ever
been run against this exact source tree, and no full TypeScript compile or
Vite build has completed end to end.** What *was* verified in that
environment, and what wasn't, is listed plainly so you know what your first
local run is actually checking for:

**Verified already (you're re-confirming, not discovering from scratch):**
- All 80 source files parse as valid TypeScript/TSX (checked with Bun's
  transpiler, which doesn't need `node_modules`).
- Every `import` in the project — relative and via the `@shared/@main/@ui`
  aliases — resolves to a real file on disk (checked with a path-resolution
  script, not the real compiler, so it can't catch *type* errors, only
  missing files).
- No main-thread file touches `document`/`window`/`fetch`/Canvas/`jspdf`,
  and no UI file touches the `figma` global — the two-thread boundary
  described in `docs/ARCHITECTURE.md` is intact everywhere.
- Every module's `handle()` export and every page's named export exists at
  the exact path `src/main/code.ts` / `src/ui/App.tsx` import it from.
- The pure logic — `renameEngine.buildNewName`, `colorUtils`'s contrast/
  WCAG/colour-blindness math, and the chunked-traversal utilities — was
  **executed at runtime** (not just parsed) against a battery of test
  cases and produced correct results. The same assertions are checked in
  `src/main/modules/rename/renameEngine.test.ts`, `src/main/utils/
  colorUtils.test.ts` and `src/main/utils/chunk.test.ts` via `npm test`.

**NOT verified — your first `npm install && npm run typecheck && npm run
build` is checking these for the first time:**
- Full strict-mode TypeScript compilation against the *real*
  `@figma/plugin-typings` package (this environment had no copy of it to
  check against — several modules use APIs the authoring agents flagged as
  uncertain, e.g. `getMainComponentAsync`/`swapComponentAsync` vs. their
  synchronous fallbacks, and the `dynamic-page` document-access async APIs
  like `figma.getNodeByIdAsync`/`PageNode.loadAsync()`. These are
  implemented with try/catch fallbacks and are the single most likely
  source of real compile errors — see `docs/MODULES.md` for the full list
  per module).
- That Vite actually produces a working single-file `dist/ui.html` and a
  single-IIFE `dist/code.js` from this exact config.
- Any actual behaviour inside real Figma — everything above is static
  analysis and pure-function execution, not a live plugin run.

None of this means the code is likely broken — the architecture, wiring,
and every piece of business logic that could be checked without Figma's
real typings checked out clean. It means: **budget time for a normal
first-build debugging pass**, the same as you would for any new project,
rather than assuming this is launch-ready untested.

## 1. Install and build

```bash
npm install
npm run typecheck   # tsc --noEmit — fix anything here first
npm run build        # builds dist/code.js + dist/ui.html
npm test              # runs the vitest suite (rename engine, colour maths, chunking)
```

## 2. Import into Figma

1. Open the **Figma desktop app** (development plugins don't run in the
   browser).
2. **Plugins → Development → Import plugin from manifest…**
3. Select `manifest.json` in this project's root.
4. It now appears under **Plugins → Development → Cirqle Designer
   Toolkit**, and the six menu shortcuts in `manifest.json` (Bulk Rename,
   Cleaner, Accessibility Checker, Automator, Template Validator, Document
   Analytics) deep-link straight into that module.

## 3. Iterating

```bash
npm run dev   # watches and rebuilds both bundles; reload the plugin in Figma to pick up changes
```

Figma doesn't hot-reload plugin code — after a rebuild, right-click the
plugin's entry under **Plugins → Development** and choose **Reload**, or
close and reopen its window.

## 4. Publishing to your team (optional)

Once verified, **Plugins → Development → Publish new plugin from
manifest…** as a private **organisation** plugin (needs a Figma Org plan)
gives everyone one-click install + centralized updates instead of each
person importing the manifest locally. See `docs/ROADMAP.md`.

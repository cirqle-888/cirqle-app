# Cirqle Designer Toolkit

An all-in-one Figma productivity plugin: bulk rename, cleaner, accessibility
checker, automator (macros), template validator, component/asset/export
managers, document analytics and design QA — twelve tools in one modular
plugin instead of a dozen separate ones.

Built TypeScript + React + Vite, with a strict typed request/response
protocol between the plugin's main thread (Figma sandbox) and its UI
(React, running in Figma's iframe). See `docs/ARCHITECTURE.md` for how that
split works and why every module follows the same shape.

## Quick start

```bash
npm install
npm run build      # builds dist/code.js (main thread) + dist/ui.html (UI)
```

Then in Figma desktop: **Plugins → Development → Import plugin from
manifest…** and select `manifest.json` in this folder. Full walkthrough in
`docs/INSTALLATION.md`.

## Modules

| # | Module | What it does |
|---|---|---|
| 1 | Bulk Rename | Find & replace, prefix/suffix, sequential numbering, regex, smart variables (`{n}` `{nn}` `{type}` `{parent}` `{page}` `{date}` `{index}`), per-node-type filters, preview before apply, undo. |
| 2 | Cleaner | Finds hidden/invisible/empty/zero-size/off-canvas layers, duplicate images/components/styles, detached instances, unused styles. Quick vs Deep scan modes. |
| 3 | Accessibility Checker | WCAG AA/AAA contrast, font-size and touch-target checks, colour-blindness simulation (protanopia/deuteranopia/tritanopia/achromatopsia), auto-fix suggestions, JSON + PDF export. |
| 4 | Automator | 20 reusable actions (rename, resize, align, distribute, replace colour/font/image, swap components, apply auto layout, export, and more) composable into saved, shareable macros. |
| 5 | Template Validator | Define required `#layerName` contracts per template family, validate a selection against them, auto-create missing placeholder layers. |
| 6 | Component Manager | Detached/broken instances, unused & duplicate components, bulk variant updates, batch relink. |
| 7 | Asset Manager | Duplicate/large/possibly-unused images, on-device compression, replace, rename, export. |
| 8 | Export Manager | Batch PNG/JPG/SVG/PDF/WebP export with naming presets, multiple scales, selection/page/document scope. |
| 9 | Document Analytics | Counts (pages/frames/components/variants/images/vectors/fonts/styles/variables), estimated file size, complexity & performance scores. |
| 10 | Design QA | Missing constraints/auto-layout, inconsistent spacing/radius/shadow/typography/colour, duplicate text styles, missing variable bindings. |
| 11 | Shortcuts | Global keyboard shortcuts + a `⌘/Ctrl K` command palette over every module. |
| 12 | Settings | Theme, language, autosave, performance mode, history, activity log, reset. |

`docs/MODULES.md` has the honest per-module detail: exactly what's a hard
guarantee vs. a documented heuristic, and every known limitation a reviewer
should be aware of before relying on a result.

## Interface: organised by usage, not by catalogue

The plugin opens on a **Home** screen, not on a tool. The main interface
only ever shows what you actually use:

- **Sidebar** — Home, then "Your tools" (pinned tools first, then your
  most-opened ones, five slots), then a collapsed "More tools" section
  holding everything else. Settings stays at the bottom. A brand-new
  install shows just Home + More tools until usage data accumulates.
- **Home** — pinned tools as cards, recently used as chips, and the full
  grid below, ordered by how often you open each tool. Pin/unpin directly
  from any card (★).
- **Hiding tools** — Settings → Tools can hide any tool from the main
  interface entirely. Hidden tools stay reachable from sidebar search and
  the ⌘K palette (marked "Hidden") — hiding trims the interface, it never
  disables anything.
- Usage counts live in `settings.usageCounts` (persisted via
  `figma.clientStorage`); a tool is only counted after ~1.5 s on screen so
  browsing past modules doesn't skew the ranking. Reset any time from
  Settings → Tools.

## Project structure

```
src/
├── shared/        # types + message protocol used by BOTH threads
├── main/          # Figma sandbox (no DOM) — the 12 modules' logic
│   ├── bridge.ts  # typed request/response dispatcher
│   ├── code.ts    # entry point, registers every module
│   ├── utils/     # chunked traversal, colour maths, storage, logging
│   └── modules/   # one folder per module, each exporting handle()
└── ui/            # React app running in Figma's iframe
    ├── components/  # Sidebar, Command Palette, Toast, Modal, Table...
    ├── hooks/       # usePluginMessage, usePluginEvent, shortcuts
    ├── state/       # zustand store, settings
    └── pages/       # one page per module
```

## Status

This is a from-scratch build, not an iteration on an existing plugin.
`npm install`, `npm test` (34+ unit tests) and `npm run build` all pass;
`dist/code.js` + `dist/ui.html` are committed prebuilt, so importing
`manifest.json` into Figma works without a build step. Known caveat:
`npm run typecheck` currently reports errors in a handful of pre-existing
modules (automator, designQA, traversal, image utils) against the latest
`@figma/plugin-typings` — they don't affect the build output (Vite doesn't
typecheck) and predate the usage-based interface work.

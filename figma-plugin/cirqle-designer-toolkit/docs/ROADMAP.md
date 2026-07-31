# Roadmap

## Immediate (before first real use)

1. **Run the real build.** `npm install && npm run typecheck && npm run
   build` — this is the first time this exact source has compiled against
   real `@figma/plugin-typings`. Expect a debugging pass; `docs/MODULES.md`
   lists exactly which APIs in which modules to check first (mostly
   `*Async` methods on instances/nodes and the Variables API).
2. **Smoke-test each module once in a real Figma file** — the sandbox this
   was built in has no Figma desktop to test against, so nothing here has
   run against the actual Plugin API yet, only been reviewed against
   documented behaviour.
3. **Component Manager: add a `batchRelink` UI.** The main-thread action
   exists; the page doesn't expose it yet.
4. **Wire up unit tests project-wide.** Three `*.test.ts` files exist
   (`renameEngine`, `colorUtils`, `chunk`) covering the pure logic that's
   easiest to test in isolation — the same pattern (factor Figma-API-free
   logic into a pure function next to the module) should extend to the
   heuristic-heavy modules (Cleaner's duplicate detection, Design QA's
   clustering) once there's a way to feed them synthetic `NodeRef`-shaped
   fixtures instead of real `SceneNode`s.

## Near-term

- **Command palette: real fuzzy scoring.** Today it's a simple substring
  rank; fine for 12 modules, worth a proper scorer (e.g. a small
  Levenshtein-ish or subsequence match) if the action list grows.
- **Per-action undo coverage audit.** Some actions are `undoable: false`
  by necessity (delete, auto-fix placeholder creation); go through
  `docs/MODULES.md`'s per-module list and confirm every *reversible*
  mutation actually offers Undo in its page, not just in the handler.
- **Design QA / Cleaner heuristic tuning pass**, informed by real usage —
  the thresholds are all centralized specifically to make this easy
  (`designQATypes.ts`, constants at the top of `cleanerScan.ts`).
- **Localization.** Settings already has a language selector wired to a
  single `'en'` option — the next language just needs a strings file and
  a lookup, not new UI.

## Medium-term

- **Publish as a private organisation plugin** (Figma Org plan required)
  for one-click team install + centralized updates instead of manual
  manifest imports per machine.
- **Automator: `createComponent` parity pass.** Currently carries over
  geometry + children only; extending it to auto-layout/constraints/
  effects/fills is real work worth scoping separately once real usage
  shows which gaps actually matter.
- **Asset Manager: true perceptual duplicate detection.** Today's
  "duplicate" is same-hash-only (a hard fact); detecting two *visually*
  identical images with different hashes would need a perceptual hash,
  which is a meaningfully bigger lift (image decode + hash algorithm) —
  worth it if teams re-upload the same photo under different names often.

## Explicitly out of scope (platform ceiling, not a gap)

- **No headless operation.** A Figma plugin only runs while Figma is open
  with the file loaded and a human clicks the button — this is a Plugin
  API limit, not something any amount of engineering here changes.
- **No real folder structure on export.** Browser downloads are flat
  files; Export Manager bakes the requested structure into filenames
  instead of pretending to write directories.
- **No live-canvas colour-blindness filter.** The Plugin API has no
  pixel/render access — Accessibility's simulation is colour-*value*
  based, and says so in the UI.

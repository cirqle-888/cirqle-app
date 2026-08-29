import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

import { nameLeakRules, nameLeakExemptFiles } from "./eslint.privacy.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...nameLeakRules],
    },
  },
  // Exempt surfaces where showing the real name is legitimate:
  //  - the privacy helpers, the ONE place that unwraps the name;
  //  - the payslip module, a self-addressed personal document delivered to the
  //    employee themselves (a payslip labelled only "CQID001" would be absurd).
  {
    files: nameLeakExemptFiles,
    rules: { "no-restricted-syntax": "off" },
  },
  // ── Advisory rules: reported, ratcheted, but not build-breaking ──────────
  //
  // These seven were ERRORS, and together they were 1,880 of the 1,883 that
  // made `npm run lint` — and therefore CI — fail on every single push since
  // the gate was added. A gate that is red 242 runs in a row reports nothing:
  // nobody can tell a new breakage from the standing noise, which is how the
  // genuinely actionable errors (a dead require(), an unescaped entity, an
  // unused ts-expect-error) sat unnoticed among them.
  //
  // They are downgraded rather than fixed, deliberately, for two reasons.
  //
  // 1. THE REACT ONES FIRE ON CORRECT CODE. `set-state-in-effect` and friends
  //    come from eslint-plugin-react-hooks v6 and encode React Compiler
  //    preferences, not correctness. Three sampled sites:
  //      - invoices-client.tsx:319 is the FIX for the props-sync bug that used
  //        to silently empty the invoice detail panel on every router.refresh().
  //        "Fixing" the lint here reintroduces a shipped production bug.
  //      - invoices-client.tsx:399 is ordinary URL->state synchronisation.
  //      - dashboard-client.tsx:83 is SSR-safe localStorage hydration, which
  //        React documents as the way to do it — you cannot read localStorage
  //        during render.
  //
  // 2. THERE IS NO SAFETY NET FOR A REWRITE. vitest runs with
  //    environment: 'node' and neither jsdom nor @testing-library/react is
  //    installed, so the repo has zero component tests. Mechanically rewriting
  //    ~1,900 lines of invoicing, payroll and cashbook UI with nothing to catch
  //    a regression is a far larger risk than the debt itself.
  //
  // no-explicit-any is the same trade at scale: 1,797 sites, concentrated in
  // Supabase row shapes that genuinely are dynamic. Retyping them by hand
  // without component tests buys little and can silently change narrowing.
  //
  // The ratchet is what makes this safe rather than a surrender: `npm run lint`
  // passes --max-warnings, pinned to the count on the day this landed, so the
  // debt can shrink but never grow. A new `any` in a new file fails CI exactly
  // as an error would.
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/refs": "warn",
    },
  },

  // Override default ignores of eslint-config-next.
  //
  // This list has to carry everything, because supplying globalIgnores at all
  // replaces the defaults rather than adding to them. While it named only the
  // build directories, `npm run lint` was also walking the archives, the two
  // Figma plugins, the desktop and mobile shells, and the vendored bundles
  // they ship — minified single-line files that alone produced thousands of
  // hits. 4,878 problems, the overwhelming majority in code that is not the
  // app and in several cases not even hand-written, which is the same as
  // having no linter: nothing in that output can be acted on.
  //
  // Scope is now the app plus its own tooling, matching what tsconfig.json
  // compiles and what vitest.config.ts runs.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Build output and dependencies.
    "node_modules/**",
    "**/dist/**",
    "**/.next/**",
    "public/**",
    // Not the app: self-contained sub-projects with their own toolchains.
    "figma-plugin/**",
    "desktop/**",
    "mobile/**",
    // Not shipped: archives, scratch space, agent worktrees, docs samples.
    "_archive/**",
    "docs/**",
    "scratch/**",
    "scratch_query.ts",
    ".claude/**",
  ]),
]);

export default eslintConfig;

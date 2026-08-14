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

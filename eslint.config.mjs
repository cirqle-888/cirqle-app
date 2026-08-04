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
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;

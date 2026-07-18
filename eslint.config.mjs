import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// ── Employee-name privacy guard ──────────────────────────────────────────────
// Employee real names are sensitive: the UI must show the CQID by default and
// the name ONLY when privacy is unlocked. The `dn()` helper / <EmployeeName>
// component enforce that — but they're opt-in, so this rule stops the recurring
// regression where a new page renders `{emp.name}` raw.
//
// It fires only in RENDER positions — JSX text children (`<span>{emp.name}</span>`)
// and template literals (`` `…${emp.name}` `` for toasts / notifications) — for
// identifiers that are employees (emp, employee, assignee, staff, member,
// creator, author, actor, me). It deliberately does NOT flag JSX attributes,
// object properties, or plain reads, so masking internals and data-plumbing DTOs
// stay quiet. Legitimate reveals (unlock-gated admin UI, an employee's own name)
// use an `eslint-disable-next-line` with a reason.
const EMP_IDENT = "/^(emp|employee|assignee|staff|member|creator|author|actor|me)$/";
const EMP_CHAIN = "/^(employee|creator|author|actor|assignee|assigned_employee|requestedBy|decidedBy|sender)$/";
const NAME_MSG =
  "Employee names are private — render CQID via dn(emp) or <EmployeeName emp={emp} />, not `.name`. If this is a deliberate unlock-gated or self-name reveal, add an eslint-disable-next-line with a reason.";
const nameLeakRules = [
  // Direct JSX text: <span>{emp.name}</span>
  `JSXElement > JSXExpressionContainer > MemberExpression[property.name='name'][object.name=${EMP_IDENT}]`,
  `JSXFragment > JSXExpressionContainer > MemberExpression[property.name='name'][object.name=${EMP_IDENT}]`,
  // Chained JSX text: <span>{row.creator.name}</span>
  `JSXElement > JSXExpressionContainer > MemberExpression[property.name='name'][object.property.name=${EMP_CHAIN}]`,
  `JSXFragment > JSXExpressionContainer > MemberExpression[property.name='name'][object.property.name=${EMP_CHAIN}]`,
  // Template literals (toasts, notification titles, share text): `…${emp.name}`
  `TemplateLiteral > MemberExpression[property.name='name'][object.name=${EMP_IDENT}]`,
  `TemplateLiteral > MemberExpression[property.name='name'][object.property.name=${EMP_CHAIN}]`,
].map((selector) => ({ selector, message: NAME_MSG }));

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
    files: [
      "src/contexts/privacy-context.tsx",
      "src/lib/utils/employee-display.ts",
      "src/components/ui/employee-name.tsx",
      "src/lib/payslip/**",
    ],
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

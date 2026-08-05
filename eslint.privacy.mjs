// ── Employee-name privacy guard — SINGLE SOURCE OF TRUTH ─────────────────────
//
// Employee real names are private. The UI shows CQID everywhere; the name is
// revealed only through the privacy helpers, and only where explicitly allowed.
//
// This module is imported by BOTH:
//   • eslint.config.mjs          — normal linting, alongside every other rule
//   • eslint.privacy.config.mjs  — the build gate, which runs ONLY this rule
//
// Keeping the selectors here means the build gate can never drift from the
// editor's rule, and there is exactly one place to strengthen the pattern.
//
// It fires in RENDER positions — JSX text children (`<span>{emp.name}</span>`)
// and template literals (`` `…${emp.name}` ``) — for identifiers that name an
// employee. It deliberately does NOT flag JSX attributes, object properties or
// plain reads, so masking internals and data-plumbing DTOs stay quiet.
//
// STRONGEST GUARANTEE IS UPSTREAM: prefer not selecting `name` from the
// database at all for a feature that only needs CQIDs — then no render-time
// mistake is even possible. This lint is the safety net, not the strategy.

const EMP_IDENT = "/^(emp|employee|assignee|staff|member|creator|author|actor|me|designer|worker|person|user)$/";
const EMP_CHAIN = "/^(employee|creator|author|actor|assignee|assigned_employee|assignedEmployee|requestedBy|decidedBy|sender|designer)$/";

const NAME_MSG =
  "Employee names are private — render CQID via dn(emp) or <EmployeeName emp={emp} />, not `.name`. " +
  "Better still, don't select `name` from the database for this feature at all. " +
  "If this is a deliberate unlock-gated or self-name reveal, add an eslint-disable-next-line with a reason.";

export const nameLeakRules = [
  // Direct JSX text: <span>{emp.name}</span>
  `JSXElement > JSXExpressionContainer > MemberExpression[property.name='name'][object.name=${EMP_IDENT}]`,
  `JSXFragment > JSXExpressionContainer > MemberExpression[property.name='name'][object.name=${EMP_IDENT}]`,
  // Chained JSX text: <span>{row.creator.name}</span>
  `JSXElement > JSXExpressionContainer > MemberExpression[property.name='name'][object.property.name=${EMP_CHAIN}]`,
  `JSXFragment > JSXExpressionContainer > MemberExpression[property.name='name'][object.property.name=${EMP_CHAIN}]`,
  // NOTE: deliberately NOT flagging conditional/`&&` positions. Those are
  // overwhelmingly truthiness guards (`{emp.name && <span>{dn(emp)}</span>}`)
  // and unlock-gated own-account reveals; flagging them buried the real signal
  // in 13 false positives. The template-literal selector below already catches
  // the shape that leaked (`{emp.cqid}{emp.name ? ` · ${emp.name}` : ''}`).
  // Template literals (toasts, notification titles, share text): `…${emp.name}`
  `TemplateLiteral > MemberExpression[property.name='name'][object.name=${EMP_IDENT}]`,
  `TemplateLiteral > MemberExpression[property.name='name'][object.property.name=${EMP_CHAIN}]`,
].map((selector) => ({ selector, message: NAME_MSG }));

/** Surfaces where showing the real name is legitimate and reviewed. */
export const nameLeakExemptFiles = [
  // The privacy helpers themselves — the ONE place that unwraps a name.
  "src/contexts/privacy-context.tsx",
  "src/lib/utils/employee-display.ts",
  "src/components/ui/employee-name.tsx",
  // A payslip is a self-addressed personal document delivered to the employee
  // themselves; one labelled only "CQID001" would be absurd.
  "src/lib/payslip/**",
];

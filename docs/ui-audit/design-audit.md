# Design System Audit

## 1. Overview
The Cirqle platform uses Tailwind CSS combined with Shadcn UI (Radix primitives). A global CSS file (`globals.css`) defines a robust CSS variables-based theming system (Light/Dark mode) with a distinct violet brand accent (`--primary: oklch(0.55 0.22 280)`).

## 2. Inconsistencies & Findings

### Spacing & Layout
- **Inconsistency**: Some dashboards use hard-coded paddings (e.g., `p-4`, `p-6`, `px-8`) which causes visual jumping when navigating between apps.
- **Action**: Standardize page containers using a unified `<PageShell>` component with strict max-widths and responsive padding scales (`px-4 sm:px-6 lg:px-8`).

### Typography
- **Inconsistency**: The typography scale relies on raw Tailwind classes (`text-sm`, `text-lg`). Headers in different modules often use mismatched weights or sizes.
- **Action**: Enforce unified semantic typography variants. Ensure all `h1` equivalent page titles use standard styles, and `h2`/`h3` section headers are uniform.

### Colors, Shadows & Radii
- **Inconsistency**: Shadows and border radii are generally consistent due to `--radius` CSS variables, but some custom components bypass them (using hardcoded `rounded-lg` vs `rounded-xl`).
- **Action**: Ensure all interactive cards and modals use the semantic CSS variables (`var(--radius)`). Unify shadow depth to reduce visual noise.

### Iconography
- **Inconsistency**: While `lucide-react` is used globally, icon sizing and stroke widths vary across modules.
- **Action**: Standardize icons to a default `w-4 h-4` (or `w-5 h-5` for sidebar) with a `1.5` or `2` stroke width across the board.

## 3. Brand Identity Guidelines
- Maintain the current violet/blue gradient aesthetic (`gradient-text`, `gradient-bg`).
- Use `hover-gradient-row` and `hover-gradient-card` for interactive elements to provide a premium feel.
- Never use generic red/green/blue unless strictly semantic (e.g., destructive actions or success states).

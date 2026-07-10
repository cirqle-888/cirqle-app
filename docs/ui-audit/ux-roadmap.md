# UX Roadmap - Phase 3

## Global Priority: Command Palette (Cmd+K)
- The application currently has a `CommandPalette` in `src/components/ui/command-palette.tsx` and it is mounted in `layout.tsx`.
- **Upgrade Path**: Verify its global accessibility. Add support for searching Employees and Settings configurations. Ensure keyboard bindings (`Cmd+K` and `Ctrl+K`) are globally reliable. Add a trigger button in the main header for discoverability.

## Track 1: Navigation & Layout Polish
- Refine the sidebar auto-collapse behavior for tablets (`iPad`).
- Implement smooth transitions for mobile navigation menus.
- Standardize Breadcrumbs across all dashboard inner pages.

## Track 2: Core Components & Forms
- Audit and upgrade the primary `<Button>` component with loading states and micro-interactions.
- Standardize all `<input>` and `<select>` fields to share the same focus rings and error states.
- Inject `sr-only` labels into icon buttons.

## Track 3: Dashboard Density & Empty States
- Audit individual module dashboards (CRM, Finance, Payroll, Tasks).
- Convert complex tables into responsive card stacks on mobile.
- Implement designed Empty States for modules lacking data.

## Track 4: Quality Assurance
- Run Lighthouse Accessibility audits against key pages.
- Ensure 0 TypeScript errors after component refactors.
- Verify production build bundle sizes to ensure performance remains >95.

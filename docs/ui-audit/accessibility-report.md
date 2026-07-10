# Accessibility (a11y) Report

## 1. Goal
Target a Lighthouse Accessibility score of 100.

## 2. Identified Areas for Improvement

### Keyboard Navigation & Focus Management
- **Issue**: Standard Tailwind setups often neglect `:focus-visible` outlines, leaving keyboard users lost.
- **Solution**: Universally implement `@apply focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2` on all interactive elements (buttons, inputs, links). Ensure skip-links exist for main content areas.

### ARIA Attributes
- **Issue**: Custom dropdowns or toggle buttons may lack `aria-expanded`, `aria-haspopup`, and `aria-label`.
- **Solution**: Since Shadcn UI/Radix primitives are heavily used, much of this is handled out-of-the-box. We must audit our custom wrapped components (like `FilterDropdown` and bespoke modals) to ensure Radix properties are correctly propagated.

### Color Contrast
- **Issue**: Text over gradients or muted foregrounds (`text-muted-foreground`) might fail WCAG AA contrast ratios against light/dark backgrounds.
- **Solution**: Audit the `oklch` values in `globals.css` ensuring contrast ratios are strictly `>= 4.5:1` for normal text and `>= 3:1` for large text/icons.

### Screen Reader Optimization
- **Issue**: Icon-only buttons (like delete trash cans or edit pencils) might lack screen-reader text.
- **Solution**: Add `<span className="sr-only">Action Name</span>` to all icon-only interactive elements.

## 3. Action Plan
1. Systematically audit `src/components/ui`.
2. Add a `sr-only` utility standard.
3. Validate focus traps on all open modals.

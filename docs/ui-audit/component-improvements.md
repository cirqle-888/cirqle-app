# Component Improvements

## 1. Goal
Evaluate specific UI elements (Forms, Buttons, Loading states, Tables) to eliminate visual clutter and improve feedback.

## 2. Component Audits

### Forms & Inputs
- **Validation**: Improve inline error messages. Move away from generic red borders towards descriptive text below the input.
- **Success Feedback**: Implement toast notifications for successful save operations instead of silent UI updates.
- **Loading Buttons**: Currently some buttons just say "Saving..." or become disabled. Implement a standard spinner icon inside the `Button` component when `isLoading` is true.

### Empty States & Skeletons
- **Empty States**: Generic "No data found" is unhelpful. Replace with illustrated (or icon-heavy) empty states that include a clear call-to-action (e.g., "Create your first Invoice").
- **Skeletons**: Standardize `Skeleton` usage so dashboards don't jump layout as data streams in.

### Micro Interactions
- **Cards**: Add `hover:-translate-y-0.5 transition-transform` and subtle shadow increases to interactive cards.
- **Dropdowns & Dialogs**: Ensure `animate-in zoom-in-95 fade-in` is universally applied for smooth, fast pop-in effects.

### Data Tables
- **Filters**: Migrate clunky inline filter inputs into a unified `FilterDropdown` or popover to reclaim horizontal space.
- **Clutter**: Dim non-critical table data (like secondary timestamps) using `text-muted-foreground` to bring primary data (like Status and Amount) into visual prominence.

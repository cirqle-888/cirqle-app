# Responsive Experience Report

## 1. Goal
Ensure a flawless, native-like experience across all viewport breakpoints:
- Desktop (>1024px)
- Tablet Landscape (iPad Pro)
- Tablet Portrait (iPad Mini)
- Mobile (iPhone/Android, <768px)

## 2. Identified Bottlenecks

### Data Tables
- **Issue**: Complex CRM and financial data tables currently force horizontal scrolling on mobile, degrading the UX.
- **Solution**: Implement stacked card layouts for mobile views using utility classes (`hidden md:table`, `block md:hidden`). Ensure horizontal scrolling is only used if absolutely necessary (e.g., dense financial spreadsheets) and always hide the webkit scrollbar.

### Navigation (Sidebar)
- **Issue**: The sidebar needs improved logic for tablet portrait mode. It shouldn't consume 250px of horizontal space on narrow screens.
- **Solution**: Enhance the sidebar to auto-collapse on tablet portrait, leaving only icons visible (`w-16`). Ensure the mobile hamburger menu provides a smooth, full-screen overlay or sliding drawer experience without layout jank.

### Modals and Dialogs
- **Issue**: Standard Radix dialogs can feel cramped or cut off on small phones.
- **Solution**: For viewports `<640px`, switch full-screen critical forms into sliding bottom sheets or use full-height modal overlays with fixed bottom action bars to mimic native iOS/Android behavior.

### Breadcrumbs
- **Issue**: Long breadcrumb trails wrap awkwardly on mobile.
- **Solution**: Introduce intelligent truncation (e.g., `... / Current Page`) on narrow screens.

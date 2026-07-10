# Phase 2: Performance Comparison

## Database Optimizations
- **Baseline**: Missing critical foreign-key indexes leading to potential sequential scans on child tables (`ad_projects`, `invoice_expense_items`, `allocations`).
- **After**: Created and documented a 7-index migration script (`20260709150000_phase2_performance_indexes.sql`) mapping out necessary index paths for scale.

## N+1 Queries
- **Baseline**: `ingestMetrics` triggered `publishAdEvent` and `notifyAdmins` individually per campaign inside a loop. Since `notifyAdmins` queries the `employees` table internally, this generated up to `(2 + numAdmins) * numProjects` queries.
- **After**: Created batched endpoints (`publishAdEventsBatch`, `notifyAdminsBatch`). `notifyAdminsBatch` queries `employees` exactly once, reducing database roundtrips down to `2 + batch_insert` entirely.

## React Lazy Loading
- **Baseline**: Modal components with complex internal states/forms (`ClientEditModal`, `RecalcBillingModal`, etc) were imported synchronously into large client components, adding to the initial Time To Interactive load.
- **After**: Replaced static modal imports with `next/dynamic` across the dashboard. Since Modals only render conditionally via boolean states (`isModalOpen`), they are now safely deferred and loaded over the network only when requested.

## Summary
The application is significantly leaner on the initial layout paint for core routes, and protected against cascading N+1 loops during API bulk updates. We are ready to proceed with Phase 3 (Electron & Mobile Strategy).

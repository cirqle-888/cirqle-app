# Phase 2: Baseline Metrics

Before beginning implementation of Phase 2 optimizations, the following baseline metrics were captured to measure our progress:

## 1. Build and Static Analysis
- **TypeScript (`tsc --noEmit`)**: 0 errors. (Phase 1 types are fully stable).
- **ESLint**: 3,178 errors, 584 warnings. (A significant backlog of `@typescript-eslint/no-explicit-any` and React hooks warnings to be addressed selectively or ignored where safe).
- **React Client Components**: 138 files explicitly use `'use client'`.
- **Realtime Subscriptions**: 6 instances of `supabase.channel(...)` initialization logic found across the application.

## 2. Bundle Size & Chunks
Due to Next.js 16 Turbopack compatibility, `@next/bundle-analyzer` has been superseded by the `next experimental-analyze` tool. The output is now generated as a fully interactive web directory rather than a single HTML file. 
- **Analyzer Output Location**: `docs/performance/bundle-before/` (Contains the `index.html` and chunk data blocks).
- *Note:* The build logs (captured in `docs/performance/build_output.log`) also contain the raw routing size tables.

## 3. Lighthouse Scores
- **Environment**: Local Build
- **Status**: Since Lighthouse requires a running web server to test network/LCP accurately, official scores will be compared post-deployment or during a staging run. The primary focus right now is chunk reduction and DOM node reduction.

---
**Next Steps**: Begin executing the Implementation Plan. The first task will be Database Indexes.

# Payroll Verification Report

This report outlines the proposed mapping between the historical CSV payments and the payroll records in the system, based on the rules provided.

### Summary
- **Total CSV Payments**: 52
- **Unambiguous Matches**: 51
- **Ambiguous Records**: 1

### Proposed Allocations

| Date | Employee | Payment Amount | Proposed Payroll Month | Reasoning | Matched Payroll | Amount Diff |
|---|---|---|---|---|---|---|
| 23 Nov 2024 | CQID002 | ₹3,579.15 | **2024-11** | Date Rule (Phase 1: Old Method, ~23rd of month) | Yes (Net: 4095) ❌ Diff: ₹-515.85 | ₹-515.85 |
| 24 Nov 2024 | CQID001 | ₹2,340.11 | **2024-11** | Date Rule (Phase 1: Old Method, ~23rd of month) | Yes (Net: 8782) ❌ Diff: ₹-6441.89 | ₹-6441.89 |
| 05 Dec 2024 | CQID001 | ₹7,000.00 | **2024-11** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 8782) ❌ Diff: ₹-1782.00 | ₹-1782.00 |
| 23 Dec 2024 | CQID002 | ₹2,265.00 | **2024-12** | Date Rule (Phase 1: Old Method, ~23rd of month) | Yes (Net: 2843) ❌ Diff: ₹-578.00 | ₹-578.00 |
| 23 Dec 2024 | CQID001 | ₹5,405.89 | **2024-12** | Date Rule (Phase 1: Old Method, ~23rd of month) | Yes (Net: 9780) ❌ Diff: ₹-4374.11 | ₹-4374.11 |
| 23 Jan 2025 | CQID002 | ₹4,484.00 | **2025-01** | Date Rule (Phase 1: Old Method, ~23rd of month) | Yes (Net: 3355) ❌ Diff: ₹1129.00 | ₹1129.00 |
| 28 Jan 2025 | CQID001 | ₹8,267.00 | **2025-01** | Date Rule (Phase 1: Old Method, ~23rd of month) | Yes (Net: 7290) ❌ Diff: ₹977.00 | ₹977.00 |
| 23 Feb 2025 | CQID002 | ₹2,665.00 | **2025-02** | Date Rule (Phase 1: Old Method, ~23rd of month) | Yes (Net: 3369) ❌ Diff: ₹-704.00 | ₹-704.00 |
| 23 Feb 2025 | CQID001 | ₹10,260.00 | **2025-02** | Date Rule (Phase 1: Old Method, ~23rd of month) | Yes (Net: 6923) ❌ Diff: ₹3337.00 | ₹3337.00 |
| 23 Mar 2025 | CQID002 | ₹5,774.00 | **2025-03** | Date Rule (Phase 1: Old Method, ~23rd of month) | Yes (Net: 6563) ❌ Diff: ₹-789.00 | ₹-789.00 |
| 23 Mar 2025 | CQID001 | ₹5,136.00 | **2025-03** | Date Rule (Phase 1: Old Method, ~23rd of month) | Yes (Net: 8504) ❌ Diff: ₹-3368.00 | ₹-3368.00 |
| 23 Apr 2025 | CQID002 | ₹5,596.00 | **2025-04** | Date Rule (Phase 1: Old Method, ~23rd of month) | Yes (Net: 5043) ❌ Diff: ₹553.00 | ₹553.00 |
| 23 Apr 2025 | CQID001 | ₹9,226.00 | **2025-04** | Date Rule (Phase 1: Old Method, ~23rd of month) | Yes (Net: 6531) ❌ Diff: ₹2695.00 | ₹2695.00 |
| 01 Jun 2025 | CQID002 | ₹4,614.00 | **2025-05** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 3424) ❌ Diff: ₹1190.00 | ₹1190.00 |
| 01 Jun 2025 | CQID001 | ₹4,600.00 | **2025-05** | Description indicates Partial payment | Yes (Net: 9011) ❌ Diff: ₹-4411.00 | ₹-4411.00 |
| 12 Jun 2025 | CQID001 | ₹4,826.00 | **2025-05** | Description indicates Balance payment | Yes (Net: 9011) ❌ Diff: ₹-4185.00 | ₹-4185.00 |
| 01 Jul 2025 | CQID002 | ₹3,774.45 | **2025-06** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 3993) ❌ Diff: ₹-218.55 | ₹-218.55 |
| 01 Jul 2025 | CQID001 | ₹4,725.03 | **2025-06** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 4874) ❌ Diff: ₹-148.97 | ₹-148.97 |
| 06 Jul 2025 | CQID002 | ₹144.38 | **2025-06** | Description indicates Balance payment | Yes (Net: 3993) ❌ Diff: ₹-3848.62 | ₹-3848.62 |
| 01 Aug 2025 | CQID002 | ₹2,842.18 | **2025-07** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 2821) ❌ Diff: ₹21.18 | ₹21.18 |
| 01 Aug 2025 | CQID001 | ₹4,711.22 | **2025-07** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 4532) ❌ Diff: ₹179.22 | ₹179.22 |
| 06 Sept 2025 | CQID002 | ₹4,859.83 | **2025-08** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 4860) ✅ Match | ₹-0.17 |
| ⚠️ 06 Sept 2025 | CQID003 | ₹3,607.90 | **2025-09** | Description indicates Multi-month (July, August) | Yes (Net: 2234) ❌ Diff: ₹1373.90 | ₹1373.90 |
| 06 Sept 2025 | CQID001 | ₹7,508.39 | **2025-08** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 7460) ❌ Diff: ₹48.39 | ₹48.39 |
| 04 Oct 2025 | CQID002 | ₹4,695.54 | **2025-09** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 4822) ❌ Diff: ₹-126.46 | ₹-126.46 |
| 04 Oct 2025 | CQID003 | ₹2,216.34 | **2025-09** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 2234) ❌ Diff: ₹-17.66 | ₹-17.66 |
| 04 Oct 2025 | CQID001 | ₹3,498.85 | **2025-09** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 3651) ❌ Diff: ₹-152.15 | ₹-152.15 |
| 05 Nov 2025 | CQID002 | ₹5,846.83 | **2025-10** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 5835) ❌ Diff: ₹11.83 | ₹11.83 |
| 05 Nov 2025 | CQID002 | ₹126.64 | **2025-10** | Description indicates Last Month Pending | Yes (Net: 5835) ❌ Diff: ₹-5708.36 | ₹-5708.36 |
| 05 Nov 2025 | CQID003 | ₹2,492.34 | **2025-10** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 2499) ✅ Match | ₹-6.66 |
| 05 Nov 2025 | CQID003 | ₹17.44 | **2025-10** | Description indicates Last Month Pending | Yes (Net: 2499) ❌ Diff: ₹-2481.56 | ₹-2481.56 |
| 05 Nov 2025 | CQID001 | ₹2,602.45 | **2025-10** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 2599) ✅ Match | ₹3.45 |
| 05 Nov 2025 | CQID001 | ₹151.88 | **2025-10** | Description indicates Last Month Pending | Yes (Net: 2599) ❌ Diff: ₹-2447.12 | ₹-2447.12 |
| 07 Dec 2025 | CQID001 | ₹3,328.02 | **2025-11** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 3328) ✅ Match | ₹0.02 |
| 07 Dec 2025 | CQID002 | ₹5,098.00 | **2025-11** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 5098) ✅ Match | ₹0.00 |
| 07 Dec 2025 | CQID003 | ₹1,930.77 | **2025-11** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 1931) ✅ Match | ₹-0.23 |
| 04 Jan 2026 | CQID001 | ₹4,338.35 | **2025-12** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 4338) ✅ Match | ₹0.35 |
| 04 Jan 2026 | CQID002 | ₹5,798.81 | **2025-12** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 5838) ❌ Diff: ₹-39.19 | ₹-39.19 |
| 04 Jan 2026 | CQID003 | ₹3,056.33 | **2025-12** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 3036) ❌ Diff: ₹20.33 | ₹20.33 |
| 06 Feb 2026 | CQID001 | ₹2,092.63 | **2026-01** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 2093) ✅ Match | ₹-0.37 |
| 06 Feb 2026 | CQID002 | ₹5,999.99 | **2026-01** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 6000) ✅ Match | ₹-0.01 |
| 06 Feb 2026 | CQID002 | ₹38.98 | **2026-01** | Description indicates Last Month Pending | Yes (Net: 6000) ❌ Diff: ₹-5961.02 | ₹-5961.02 |
| 06 Feb 2026 | CQID003 | ₹1,531.62 | **2026-01** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 1532) ✅ Match | ₹-0.38 |
| 04 Mar 2026 | CQID001 | ₹3,537.79 | **2026-02** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 3538) ✅ Match | ₹-0.21 |
| 04 Mar 2026 | CQID002 | ₹4,257.75 | **2026-02** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 4258) ✅ Match | ₹-0.25 |
| 04 Mar 2026 | CQID003 | ₹1,653.97 | **2026-02** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 1654) ✅ Match | ₹-0.03 |
| 05 Apr 2026 | CQID001 | ₹3,945.81 | **2026-03** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 3946) ✅ Match | ₹-0.19 |
| 05 Apr 2026 | CQID002 | ₹5,050.53 | **2026-03** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 5051) ✅ Match | ₹-0.47 |
| 05 Apr 2026 | CQID003 | ₹1,569.73 | **2026-03** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 1570) ✅ Match | ₹-0.27 |
| 06 May 2026 | CQID001 | ₹1,906.08 | **2026-04** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 1906) ✅ Match | ₹0.08 |
| 06 May 2026 | CQID002 | ₹4,878.76 | **2026-04** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 4879) ✅ Match | ₹-0.24 |
| 06 May 2026 | CQID003 | ₹1,507.81 | **2026-04** | Date Rule (Phase 2: New Method, early month -> prev month) | Yes (Net: 1508) ✅ Match | ₹-0.19 |

### Ambiguous Records for Review

- **06-Sep-2025 - CQID003 (₹3607.9)**
  - **Description**: Creative Rewards - CQID003 (July, August)
  - **Reason**: Description indicates Multi-month (July, August)

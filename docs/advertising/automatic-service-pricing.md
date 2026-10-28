# Automatic advertising service pricing setup

Prepared 28 October 2026. Live records inspected read-only; no production writes performed.

## Evidence

- MEZZA Royal Food Products has a client-specific price of 30 for service
  `3a9b5a49-d55c-4688-b258-2746c48149d9`, “Ad Running (As Agreed / _100 Ad Spend)”.
- Its July “20% Extra Offer” project stores `percent / 30`.
- Historical tasks #1581 and #1485 store ₹150 / quantity 5 and ₹750 / quantity 25,
  respectively, consistent with ₹30 per ₹100 of spend.
- The service is inactive, has pricing type `percentage_of_spend`, and no default price.
- Other clients have explicit 75 rates. Preserve these; do not mass-overwrite with 30.
- Sea Star Catering and Hotel has no override for this service. The prepared fallback is 30%.
- The Wedding Package campaign has two projects and tasks #2094 and #2098.

## Activation

1. Review/apply migration `20261028160000_automatic_advertising_pricing.sql`.
   It explicitly marks the historical service as the advertising default, activates it,
   and fills its missing default price with 30. Existing client prices remain unchanged.
2. Apply `20261028170000_cashbook_ad_wallet_autocredit.sql`, then deploy the application changes. Apply the migration before the code, since mapping
   requires the new configuration column.
3. Sync an active canonical campaign. The existing sync worker invokes billing recomputation.
   An imported active campaign with no service and the legacy fixed/zero pricing shape
   receives the configured service and rate. Its existing task is updated.
4. Verify the campaign, linked task and draft invoice amounts. Check logs for
   `[advertising billing] Recompute failed` if a task or pricing is missing.

## Rules and limits

- Client price wins; otherwise use the service default. An explicit client price of zero is preserved.
- Campaign rates already configured, including manual fees, are preserved.
- New imported campaigns receive the service/rate at mapping; missing configuration blocks
  mapping with “Needs pricing”. Repeating mapping reuses the registry project.
- Sync repair skips internal, duplicate, inactive, and finalized-invoice campaigns.
  Reviewed invoices are locked as well. Missing invoice history fails closed.
- No historic invoice rewrite, duplicate deletion, or automatic task status change.
- This change covers imported campaigns and their sync. The manual New Campaign form
  continues to use its existing service-selection and automatic client-pricing behavior.
- Percentage fees now use actual spend INCLUDING GST only. Before any spend is reported,
  the fee basis is zero; top-ups, allocations and estimated budgets do not create percentage
  fees. Cashbook funding is already gross and is never multiplied by 1.18 again.
- Campaign detail loads the same authoritative spend source as billing. Manual creation
  starts percentage billing at zero, and regenerated tasks use actual spend. Dedicated
  campaign invoice lines also use actual spend rather than funding. Fixed fees retain their
  existing behavior.
- Confirmed workflow: accountant records the bank payment into Meta in Cashbook. Only
  this funding credits the ad wallet. Service fees remain campaign tasks; they do not
  create Cashbook entries or debit the wallet.
- Migration `20261028170000_cashbook_ad_wallet_autocredit.sql` credits explicitly client-
  and ad-account-tagged outflows atomically. A bank account is required. Repeat saves
  update one managed credit, preserving existing manual shares. Amount edits reconcile
  the credit; deletion/reversal releases it. Retagging already-assigned funds is blocked.
- Cashbook now has an explicit Meta ad-account picker. Unknown/unassigned-client funding
  is not guessed. The account funding worker rechecks older tagged entries through a
  restricted reconciliation RPC. The existing Add Fund flow recognizes the trigger's
  credit so it does not credit twice.
- Sea Star's live books contain ₹800 plus an erroneous ₹80 top-up, as clarified by the
  user. Both currently have wallet credits. Valid intended funding is ₹800. No live
  correction was performed; the accountant must delete/reverse the erroneous Cashbook
  source, which releases the credit (not merely hide a wallet row).
- Wallet credit minus campaign allocations is UNALLOCATED funding. It is not remaining
  platform money. The Funds statement reconciles credited funding against actual spend;
  fees are excluded. The campaign label now explicitly says “Unallocated wallet”.
- Legacy null-service/fixed-zero records cannot distinguish intentional free work from
  the importer default. Set an explicit zero-priced service before syncing any intentionally
  free campaign. This automatic repair runs only for active imported campaigns.
- The registry prevents sequential repeated imports; concurrent first-time imports are not
  transactionally serialized by this patch. Existing canonical-owner checks suppress duplicate
  billing. A full database uniqueness cleanup would require reviewing existing duplicates.

## Validation

Vitest advertising and Cashbook suites: 150 tests passed across 16 files.
Isolated PostgreSQL (PGlite) integration tests cover idempotent wallet credit, edits,
manual partial/full credits, FX, rejected retagging, deletion/restore and reversals.
Run `scripts/test-ad-wallet-autocredit.mjs` as described in its header.
TypeScript project check passed. No production deployment or financial writes performed.

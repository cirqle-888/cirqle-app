-- ============================================================
-- Public invoice token (client-shareable hosted invoice link)
-- ============================================================
-- Adds an unguessable token to every invoice so it can be viewed by a client
-- at /i/<token> WITHOUT logging in (the existing /dashboard/invoices link is
-- login-only). A v4 UUID is unpredictable enough that the link is not
-- discoverable — the standard "hosted invoice link" security model.
--
-- Idempotent. The volatile DEFAULT fills existing rows with distinct tokens on
-- ADD COLUMN; the UPDATE is a belt-and-braces backfill for any nulls.
-- ============================================================

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS public_token uuid DEFAULT gen_random_uuid();

UPDATE invoices
  SET public_token = gen_random_uuid()
  WHERE public_token IS NULL;

ALTER TABLE invoices
  ALTER COLUMN public_token SET NOT NULL,
  ALTER COLUMN public_token SET DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_public_token
  ON invoices (public_token);

COMMENT ON COLUMN invoices.public_token IS
  'Unguessable token for the public hosted invoice page /i/<token>. No login required.';

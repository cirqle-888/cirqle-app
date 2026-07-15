-- Business Partner attribution window.
--
-- A partner often takes over a client that already had years of billing history
-- with us (e.g. BP-004 was handed Sea Star Supermarket long after Sea Star
-- became a client), while other clients they brought in from scratch. Crediting
-- the partner with the client's entire lifetime revenue overstates their book.
--
-- `partner_since` is the date the partner took the client over: every invoice
-- ISSUED on or after it is theirs (collected, outstanding, and statement);
-- anything issued earlier is ours and never appears in their figures.
-- NULL means "from the very beginning" — the correct value for a client the
-- partner originated, and the backwards-compatible default for existing links.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS partner_since date;

COMMENT ON COLUMN public.clients.partner_since IS
  'Date the linked business partner took this client over. Invoices issued on/after it are attributed to the partner; NULL = the whole history is theirs. Ignored when business_partner_id is NULL.';
